// unjargond is the unjargon.app collector: a dumb tail-and-ship daemon that
// watches agent transcript files (Claude Code JSONL) and posts new assistant
// messages to the unjargon web app. All LLM work happens server-side.
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/chrisa142857/unjargon.app/collector/internal/daemon"
	"github.com/chrisa142857/unjargon.app/collector/internal/parse"
	"github.com/chrisa142857/unjargon.app/collector/internal/ship"
	"github.com/chrisa142857/unjargon.app/collector/internal/tail"
)

const usage = `unjargond — the unjargon.app collector

Usage:
  unjargond run [flags]                daemon: hook + directory discovery, tail everything
  unjargond run -file <t.jsonl>        tail a single transcript (testing/simple setups)
  unjargond replay <fixture.jsonl>     replay a recorded session with pacing
  unjargond hook                       (used as a Claude Code SessionStart hook)

Common flags:
  -server URL   unjargon web app (default http://localhost:3000, env UNJARGON_SERVER)
  -token  TOK   device bearer token (env UNJARGON_TOKEN)
  -device NAME  device name shown in the UI (default hostname, env UNJARGON_DEVICE)

Config file: ~/.config/unjargond/env (KEY=VALUE lines) is loaded at startup;
flags > environment > config file.
`

func main() {
	loadEnvFile(filepath.Join(configHome(), "unjargond", "env"))
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	switch os.Args[1] {
	case "run":
		cmdRun(os.Args[2:])
	case "replay":
		cmdReplay(os.Args[2:])
	case "hook":
		cmdHook(os.Args[2:])
	default:
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func hostname() string {
	h, err := os.Hostname()
	if err != nil {
		return "unknown-device"
	}
	return h
}

func home() string {
	h, err := os.UserHomeDir()
	if err != nil {
		return "."
	}
	return h
}

func configHome() string {
	if x := os.Getenv("XDG_CONFIG_HOME"); x != "" {
		return x
	}
	return filepath.Join(home(), ".config")
}

func stateHome() string {
	if x := os.Getenv("XDG_STATE_HOME"); x != "" {
		return x
	}
	return filepath.Join(home(), ".local", "state")
}

// loadEnvFile applies KEY=VALUE lines from the installer-written config;
// real environment variables win.
func loadEnvFile(path string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok || k == "" {
			continue
		}
		if os.Getenv(k) == "" {
			os.Setenv(k, strings.Trim(v, `"'`))
		}
	}
}

func commonFlags(fs *flag.FlagSet) (server, token, device *string) {
	server = fs.String("server", envOr("UNJARGON_SERVER", "http://localhost:3000"), "unjargon web app URL")
	token = fs.String("token", os.Getenv("UNJARGON_TOKEN"), "device bearer token")
	device = fs.String("device", envOr("UNJARGON_DEVICE", hostname()), "device name")
	return
}

func cmdRun(args []string) {
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	server, token, device := commonFlags(fs)
	file := fs.String("file", "", "tail a single transcript file instead of running discovery")
	listen := fs.String("listen", envOr("UNJARGON_LISTEN", "127.0.0.1:4577"), "hook-notification listen address ('' disables)")
	watch := fs.String("watch", envOr("UNJARGON_WATCH", filepath.Join(home(), ".claude", "projects")), "comma-separated directories to scan for transcripts")
	stateDir := fs.String("state", filepath.Join(stateHome(), "unjargond"), "state directory (offsets, offline queue, pid)")
	interval := fs.Duration("interval", 2*time.Second, "poll interval")
	fs.Parse(args)

	parser := parse.ClaudeCode{}
	shipper := &ship.Shipper{ServerURL: *server, Token: *token, Device: *device, Tool: parser.Tool()}

	// Single-file mode: the walking-skeleton path, still handy for tests
	// and "just watch this one file" setups.
	if *file != "" {
		tailer := tail.New(*file)
		log.Printf("tailing %s → %s (device %q, poll %s)", *file, *server, *device, *interval)
		for {
			lines, err := tailer.Poll()
			if err != nil {
				log.Printf("poll: %v", err)
			}
			var msgs []parse.AgentMessage
			for _, line := range lines {
				if m, ok := parser.ParseLine(line); ok {
					msgs = append(msgs, m)
				}
			}
			if len(msgs) > 0 {
				if err := shipper.Send(msgs); err != nil {
					log.Printf("ship: %v", err)
				} else {
					log.Printf("shipped %d message(s)", len(msgs))
				}
			}
			time.Sleep(*interval)
		}
	}

	// Daemon mode. PID file makes double-starts no-ops (HPC .bashrc installs).
	if err := os.MkdirAll(*stateDir, 0o700); err != nil {
		log.Fatal(err)
	}
	pidPath := filepath.Join(*stateDir, "unjargond.pid")
	if pid, running := pidAlive(pidPath); running {
		log.Printf("unjargond already running (pid %d) — nothing to do", pid)
		return
	}
	if err := os.WriteFile(pidPath, []byte(strconv.Itoa(os.Getpid())), 0o600); err != nil {
		log.Fatal(err)
	}
	defer os.Remove(pidPath)

	var roots []string
	for _, r := range strings.Split(*watch, ",") {
		if r = strings.TrimSpace(r); r != "" {
			roots = append(roots, r)
		}
	}
	d, err := daemon.New(daemon.Config{
		Shipper:    shipper,
		Parser:     parser,
		WatchRoots: roots,
		Listen:     *listen,
		StateDir:   *stateDir,
		Interval:   *interval,
	})
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("unjargond daemon: watching %v → %s (device %q, poll %s)", roots, *server, *device, *interval)
	log.Fatal(d.Run())
}

// pidAlive reports whether the PID in the file refers to a live process.
func pidAlive(path string) (int, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || pid <= 0 {
		return 0, false
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return pid, false
	}
	return pid, proc.Signal(syscall.Signal(0)) == nil
}

// cmdHook runs as the Claude Code SessionStart hook: read the hook JSON from
// stdin, forward transcript_path to the local daemon, always exit 0 fast —
// a hook must never break or slow the user's session.
func cmdHook(args []string) {
	fs := flag.NewFlagSet("hook", flag.ExitOnError)
	listen := fs.String("listen", envOr("UNJARGON_LISTEN", "127.0.0.1:4577"), "daemon hook-notification address")
	fs.Parse(args)

	input, _ := io.ReadAll(io.LimitReader(os.Stdin, 1<<20))
	var hook struct {
		TranscriptPath string `json:"transcript_path"`
	}
	if err := json.Unmarshal(input, &hook); err != nil || hook.TranscriptPath == "" {
		return
	}
	body, _ := json.Marshal(map[string]string{"transcript_path": hook.TranscriptPath})
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Post("http://"+*listen+"/notify", "application/json", bytes.NewReader(body))
	if err == nil {
		resp.Body.Close()
	}
}

// cmdReplay pushes a recorded fixture through the same parse→redact→ship
// pipeline, pacing messages so the stream looks live. Deterministic demo
// fallback per the spec.
func cmdReplay(args []string) {
	fs := flag.NewFlagSet("replay", flag.ExitOnError)
	server, token, device := commonFlags(fs)
	delay := fs.Duration("delay", 2*time.Second, "pause between messages")
	// Accept "replay <fixture> [flags]" — stdlib flag parsing stops at the
	// first positional arg, so pull the path out before parsing flags.
	var fixture string
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		fixture, args = args[0], args[1:]
	}
	fs.Parse(args)
	if fixture == "" && fs.NArg() == 1 {
		fixture = fs.Arg(0)
	}
	if fixture == "" {
		log.Fatal("replay: exactly one fixture path required")
	}

	parser := parse.ClaudeCode{}
	shipper := &ship.Shipper{ServerURL: *server, Token: *token, Device: *device, Tool: parser.Tool()}
	tailer := tail.New(fixture)
	lines, err := tailer.Poll()
	if err != nil {
		log.Fatalf("read fixture: %v", err)
	}

	sent := 0
	for _, line := range lines {
		m, ok := parser.ParseLine(line)
		if !ok {
			continue
		}
		if sent > 0 {
			time.Sleep(*delay)
		}
		if err := shipper.Send([]parse.AgentMessage{m}); err != nil {
			log.Fatalf("ship: %v", err)
		}
		sent++
		log.Printf("replayed message %d (%d bytes)", sent, len(m.Text))
	}
	log.Printf("replay complete: %d message(s) sent", sent)
}
