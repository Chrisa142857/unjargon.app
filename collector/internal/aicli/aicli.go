// Package aicli runs only user-requested term explanations with the AI CLI
// already signed in on this machine. Transcript detection never calls it.
package aicli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

const callTimeout = 30 * time.Second
const budgetWindow = 5 * time.Hour
const budgetLimit = budgetWindow / 20 // 5% of a five-hour window

type budgetUse struct {
	At           time.Time `json:"at"`
	InputTokens  int       `json:"input_tokens,omitempty"`
	OutputTokens int       `json:"output_tokens,omitempty"`
	Reported     bool      `json:"reported,omitempty"`
}

// ErrBudgetWait means the optional explanation budget is spent. Callers must
// not block; the user-requested expansion remains queued for a later retry.
type ErrBudgetWait struct{ Until time.Time }

func (e *ErrBudgetWait) Error() string {
	return fmt.Sprintf("local AI budget spent until %s", e.Until.Format(time.RFC3339))
}

// budget reserves one worst-case CLI call before it starts. Persisting it
// means restarting the collector cannot accidentally bypass the limit.
type budget struct {
	path string
	mu   sync.Mutex
	uses []budgetUse
}

func newBudget(stateDir string) *budget {
	b := &budget{path: stateDir + "/ai-budget.json"}
	if data, err := os.ReadFile(b.path); err == nil {
		_ = json.Unmarshal(data, &b.uses)
	}
	return b
}

func (b *budget) reserve() time.Duration {
	b.mu.Lock()
	defer b.mu.Unlock()
	cutoff := time.Now().Add(-budgetWindow)
	kept := b.uses[:0]
	for _, use := range b.uses {
		if use.At.After(cutoff) {
			kept = append(kept, use)
		}
	}
	b.uses = kept
	// Each process is capped at 30 seconds, so this reserves at most 15
	// minutes (5%) of local AI runtime in every rolling five-hour window.
	if time.Duration(len(b.uses)+1)*callTimeout > budgetLimit {
		return time.Until(b.uses[0].At.Add(budgetWindow))
	}
	b.uses = append(b.uses, budgetUse{At: time.Now()})
	data, _ := json.Marshal(b.uses)
	_ = os.WriteFile(b.path, data, 0o600)
	return 0
}

// status reports calls used in the current window and when the oldest use
// rolls out of it (zero time when the window is empty).
func (b *budget) status() (used int, resetAt time.Time, inputTokens int, outputTokens int, reported bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	cutoff := time.Now().Add(-budgetWindow)
	kept := b.uses[:0]
	for _, use := range b.uses {
		if use.At.After(cutoff) {
			kept = append(kept, use)
		}
	}
	b.uses = kept
	for _, use := range b.uses {
		inputTokens += use.InputTokens
		outputTokens += use.OutputTokens
		reported = reported || use.Reported
	}
	if len(b.uses) == 0 {
		return 0, time.Time{}, 0, 0, false
	}
	return len(b.uses), b.uses[0].At.Add(budgetWindow), inputTokens, outputTokens, reported
}

func (b *budget) recordUsage(inputTokens, outputTokens int, reported bool) {
	if !reported {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.uses) == 0 {
		return
	}
	b.uses[len(b.uses)-1].InputTokens = inputTokens
	b.uses[len(b.uses)-1].OutputTokens = outputTokens
	b.uses[len(b.uses)-1].Reported = true
	data, _ := json.Marshal(b.uses)
	_ = os.WriteFile(b.path, data, 0o600)
}

type Translator struct {
	Command []string // CLI invocation; the prompt is appended as final arg
	Dir     string   // cwd for child sessions — see RecursionGuard
	Model   string   // passed via --model when using the default claude CLI
	budget  *budget
}

// Detect builds a Translator according to mode ("auto" | "claude" | "codex" |
// "on" | "off"). In auto mode Codex wins when both CLIs exist: this avoids
// choosing an unrelated, signed-out Claude install on a Codex machine.
// In auto mode it quietly returns nil when no AI CLI is available.
func Detect(mode, stateDir string) (*Translator, error) {
	if mode == "off" {
		return nil, nil
	}
	cmd, model := commandFromEnv()
	if cmd == nil {
		if mode != "claude" {
			if _, err := exec.LookPath("codex"); err == nil {
				// `exec` is non-interactive and ephemeral. Read-only keeps an
				// explanation request from modifying the user's workspace.
				cmd = []string{"codex", "exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only"}
			}
		}
		if cmd == nil && mode != "codex" {
			if _, err := exec.LookPath("claude"); err == nil {
				cmd = []string{"claude", "--output-format", "json", "-p"}
			}
		}
		if cmd == nil && (mode == "on" || mode == "claude" || mode == "codex") {
			return nil, fmt.Errorf("local-explain=%s but its AI CLI was not found on PATH", mode)
		}
		if cmd == nil {
			return nil, nil
		}
	}
	// Child sessions run in a marker directory so the daemon can recognize
	// (and never tail) the transcripts they generate. See RecursionGuard.
	dir := stateDir + "/unjargond-translator"
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return &Translator{
		Command: cmd,
		Dir:     dir,
		Model:   model,
		budget:  newBudget(stateDir),
	}, nil
}

// commandFromEnv honors UNJARGON_TRANSLATE_CMD (space-separated command that
// receives the prompt as its final argument and prints JSON — used for other
// AI CLIs and for tests).
func commandFromEnv() (cmd []string, model string) {
	model = os.Getenv("UNJARGON_TRANSLATE_MODEL")
	if model == "" {
		model = "haiku"
	}
	if raw := os.Getenv("UNJARGON_TRANSLATE_CMD"); raw != "" {
		return strings.Fields(raw), model
	}
	return nil, model
}

func (t *Translator) Describe() string {
	if t.Command[0] != "claude" {
		return fmt.Sprintf("%s (fresh headless session per requested explanation, cwd %s)",
			strings.Join(t.Command, " "), t.Dir)
	}
	return fmt.Sprintf("%s (model %s, fresh headless session per requested explanation, cwd %s)",
		strings.Join(t.Command, " "), t.Model, t.Dir)
}

// Notice is the transparency banner logged at startup.
func (t *Translator) Notice() string {
	return "local explanation mode ON: unjargon makes no automatic AI calls\n" +
		"  using YOUR credentials via: " + t.Describe() + "\n" +
		"  This reserves at most 15 minutes (5%) of local AI runtime for buttons you press.\n" +
		"  Disable with -local-explain=off."
}

// BudgetStatus reports local AI budget state for /api/status: calls used in
// the rolling window, the cap, and when the oldest call rolls out.
func (t *Translator) BudgetStatus() (used, limit int, resetAt time.Time, inputTokens, outputTokens int, reported bool) {
	used, resetAt, inputTokens, outputTokens, reported = t.budget.status()
	return used, int(budgetLimit / callTimeout), resetAt, inputTokens, outputTokens, reported
}

// Complete runs an arbitrary prompt through the user's AI CLI and returns the
// raw output (a claude-style JSON envelope or bare text). Used for explicit
// term-expansion work fetched from the server.
func (t *Translator) Complete(prompt string) (string, error) {
	if wait := t.budget.reserve(); wait > 0 {
		return "", &ErrBudgetWait{Until: time.Now().Add(wait)}
	}
	args := append([]string(nil), t.Command[1:]...)
	if t.Command[0] == "claude" && t.Model != "" {
		args = append([]string{"--model", t.Model}, args...)
	}
	args = append(args, prompt)
	cmd := exec.Command(t.Command[0], args...)
	cmd.Dir = t.Dir
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	timer := time.AfterFunc(callTimeout, func() {
		if cmd.Process != nil {
			cmd.Process.Kill()
		}
	})
	err := cmd.Run()
	timer.Stop()
	if err != nil {
		detail := firstLine(stderr.String())
		if detail == "" {
			detail = firstLine(stdout.String())
		}
		return "", fmt.Errorf("%s: %v (%s)", t.Command[0], err, detail)
	}
	inputTokens, outputTokens, reported := usageFromOutput(stdout.String())
	t.budget.recordUsage(inputTokens, outputTokens, reported)
	return stdout.String(), nil
}

// Claude's JSON result includes actual API usage. Codex's plain final-output
// mode does not, so the UI explicitly says when an exact count is unavailable.
func usageFromOutput(out string) (inputTokens, outputTokens int, reported bool) {
	var result struct {
		Usage *struct {
			InputTokens              int `json:"input_tokens"`
			OutputTokens             int `json:"output_tokens"`
			CacheReadInputTokens     int `json:"cache_read_input_tokens"`
			CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
		} `json:"usage"`
	}
	if json.Unmarshal([]byte(out), &result) != nil || result.Usage == nil {
		return 0, 0, false
	}
	return result.Usage.InputTokens + result.Usage.CacheReadInputTokens + result.Usage.CacheCreationInputTokens, result.Usage.OutputTokens, true
}

// jsonObject strips a claude-CLI envelope and markdown fences, returning the
// first {...} JSON object in the CLI output.
func jsonObject(out string) (string, error) {
	text := out
	var envelope struct {
		Result  string `json:"result"`
		IsError bool   `json:"is_error"`
	}
	if err := json.Unmarshal([]byte(out), &envelope); err == nil && envelope.Result != "" {
		if envelope.IsError {
			return "", fmt.Errorf("AI CLI reported an error: %.120s", envelope.Result)
		}
		text = envelope.Result
	}
	start := strings.Index(text, "{")
	end := strings.LastIndex(text, "}")
	if start < 0 || end <= start {
		return "", fmt.Errorf("no JSON object in AI output: %.120q", text)
	}
	return text[start : end+1], nil
}

// ExtractText pulls {"text": ...} out of CLI output — the expansion-work
// response format.
func ExtractText(out string) (string, error) {
	obj, err := jsonObject(out)
	if err != nil {
		return "", err
	}
	var body struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal([]byte(obj), &body); err != nil {
		return "", fmt.Errorf("bad expansion JSON: %v", err)
	}
	if strings.TrimSpace(body.Text) == "" {
		return "", fmt.Errorf("empty expansion text")
	}
	return strings.TrimSpace(body.Text), nil
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	if len(s) > 160 {
		s = s[:160]
	}
	return s
}

// RecursionGuard reports whether a transcript path belongs to one of OUR
// explanation child sessions. Headless `claude -p` runs write transcripts
// under ~/.claude/projects/<encoded-cwd>/ like any session — without this
// check the daemon would tail its own explanation output and loop forever.
// Child sessions run with cwd .../unjargond-translator, whose
// encoded form survives in the transcript path.
func RecursionGuard(path string) bool {
	return strings.Contains(path, "unjargond-translator")
}
