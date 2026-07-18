// Package aicli is local-translate mode: instead of the server holding an
// API key, the collector reuses the AI credentials already on this machine
// by spawning a fresh headless session of the user's own AI CLI
// (`claude -p`) for each agent message.
//
// Transparency contract: live translation reuses the user's AI CLI, but is
// capped at 5% of a five-hour local runtime window. It can be turned off with
// -local-translate=off (the server then translates if it has a key).
//
// The prompt template is NOT hard-coded here — it is fetched from the web
// app's GET /api/prompt, so all prompting stays in web/src/lib/prompts.ts.
package aicli

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/chrisa142857/unjargon.app/collector/internal/parse"
)

// Messages shorter than this can't contain explainable jargon; skip them
// locally instead of wasting one of the user's AI calls (mirrors the server).
const trivialLength = 20

// Short TTL: the template carries the server's current glossary and domain
// labels (for dedupe), which grow as the session runs.
const templateTTL = 30 * time.Second
const callTimeout = 30 * time.Second
const budgetWindow = 5 * time.Hour
const budgetLimit = budgetWindow / 20 // 5% of a five-hour window

var errBudget = errors.New("local AI budget reached")

type budgetUse struct {
	At time.Time `json:"at"`
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

func (b *budget) reserve() bool {
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
		return false
	}
	b.uses = append(b.uses, budgetUse{At: time.Now()})
	data, _ := json.Marshal(b.uses)
	_ = os.WriteFile(b.path, data, 0o600)
	return true
}

type Translator struct {
	ServerURL string
	Command   []string // CLI invocation; the prompt is appended as final arg
	Dir       string   // cwd for child sessions — see RecursionGuard
	Model     string   // passed via --model when using the default claude CLI
	budget    *budget

	mu         sync.Mutex
	template   string
	templateAt time.Time
}

// Detect builds a Translator according to mode ("auto" | "on" | "off").
// In auto mode it quietly returns nil when no AI CLI is available.
func Detect(mode, serverURL, stateDir string) (*Translator, error) {
	if mode == "off" {
		return nil, nil
	}
	cmd, model := commandFromEnv()
	if cmd == nil {
		if _, err := exec.LookPath("claude"); err != nil {
			if mode == "on" {
				return nil, fmt.Errorf("local-translate=on but no `claude` CLI on PATH (and UNJARGON_TRANSLATE_CMD unset)")
			}
			return nil, nil
		}
		cmd = []string{"claude", "--output-format", "json", "-p"}
	}
	// Child sessions run in a marker directory so the daemon can recognize
	// (and never tail) the transcripts they generate. See RecursionGuard.
	dir := stateDir + "/unjargond-translator"
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return &Translator{
		ServerURL: serverURL,
		Command:   cmd,
		Dir:       dir,
		Model:     model,
		budget:    newBudget(stateDir),
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
	return fmt.Sprintf("%s (model %s, fresh headless session per message, cwd %s)",
		strings.Join(t.Command, " "), t.Model, t.Dir)
}

// Notice is the transparency banner logged at startup.
func (t *Translator) Notice() string {
	return "local-translate mode ON: unjargon makes at most 30 short AI calls per 5 hours\n" +
		"  using YOUR credentials via: " + t.Describe() + "\n" +
		"  This reserves at most 15 minutes (5%) of local AI runtime. Disable with -local-translate=off\n" +
		"  (translation then happens server-side if the server has an API key)."
}

// Translate runs one message through the user's AI CLI. Errors are returned
// so the caller can leave msg.Translation nil (server-side fallback).
func (t *Translator) Translate(msg *parse.AgentMessage) error {
	if strings.TrimSpace(msg.Text) == "" || len(strings.TrimSpace(msg.Text)) < trivialLength {
		msg.Translation = &parse.Translation{Skip: true}
		return nil
	}
	tmpl, err := t.fetchTemplate()
	if err != nil {
		return fmt.Errorf("fetch prompt template: %w", err)
	}
	out, err := t.Complete(strings.Replace(tmpl, "{{MESSAGE}}", msg.Text, 1))
	if err != nil {
		if errors.Is(err, errBudget) {
			msg.Translation = &parse.Translation{Skip: true}
			return nil
		}
		return err
	}
	result, err := extractTranslation([]byte(out))
	if err != nil {
		return err
	}
	msg.Translation = result
	return nil
}

// Complete runs an arbitrary prompt through the user's AI CLI and returns the
// raw output (a claude-style JSON envelope or bare text). Used for digest
// work fetched from the server.
func (t *Translator) Complete(prompt string) (string, error) {
	if !t.budget.reserve() {
		return "", errBudget
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
		return "", fmt.Errorf("%s: %v (%s)", t.Command[0], err, firstLine(stderr.String()))
	}
	return stdout.String(), nil
}

// ExtractSummary pulls {"summary": ...} out of CLI output (envelope, fenced,
// or bare JSON) — the digest-work response format.
func ExtractSummary(out string) (string, error) {
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
	var body struct {
		Summary string `json:"summary"`
	}
	if err := json.Unmarshal([]byte(text[start:end+1]), &body); err != nil {
		return "", fmt.Errorf("bad digest JSON: %v", err)
	}
	if strings.TrimSpace(body.Summary) == "" {
		return "", fmt.Errorf("empty digest summary")
	}
	return strings.TrimSpace(body.Summary), nil
}

// extractTranslation handles both a claude-CLI JSON envelope ({"result":
// "..."}), possibly with markdown fences inside, and bare JSON output.
func extractTranslation(out []byte) (*parse.Translation, error) {
	text := string(out)
	var envelope struct {
		Result  string `json:"result"`
		IsError bool   `json:"is_error"`
	}
	if err := json.Unmarshal(out, &envelope); err == nil && envelope.Result != "" {
		if envelope.IsError {
			return nil, fmt.Errorf("AI CLI reported an error: %.120s", envelope.Result)
		}
		text = envelope.Result
	}
	start := strings.Index(text, "{")
	end := strings.LastIndex(text, "}")
	if start < 0 || end <= start {
		return nil, fmt.Errorf("no JSON object in AI output: %.120q", text)
	}
	var tr parse.Translation
	if err := json.Unmarshal([]byte(text[start:end+1]), &tr); err != nil {
		return nil, fmt.Errorf("bad translation JSON: %v", err)
	}
	if !tr.Skip && strings.TrimSpace(tr.Subtitle) == "" {
		tr = parse.Translation{Skip: true} // nothing useful came back
	}
	return &tr, nil
}

func (t *Translator) fetchTemplate() (string, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.template != "" && time.Since(t.templateAt) < templateTTL {
		return t.template, nil
	}
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(t.ServerURL + "/api/prompt")
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("GET /api/prompt: %s", resp.Status)
	}
	var body struct {
		Template string `json:"template"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return "", err
	}
	if !strings.Contains(body.Template, "{{MESSAGE}}") {
		return "", fmt.Errorf("prompt template missing {{MESSAGE}} placeholder")
	}
	t.template = body.Template
	t.templateAt = time.Now()
	return t.template, nil
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
// translation child sessions. Headless `claude -p` runs write transcripts
// under ~/.claude/projects/<encoded-cwd>/ like any session — without this
// check the daemon would tail its own translation output and translate it,
// forever. Child sessions run with cwd .../unjargond-translator, whose
// encoded form survives in the transcript path.
func RecursionGuard(path string) bool {
	return strings.Contains(path, "unjargond-translator")
}
