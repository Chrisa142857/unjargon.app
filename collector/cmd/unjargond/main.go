// unjargond is the unjargon.app collector: a dumb tail-and-ship daemon that
// watches agent transcript files (Claude Code JSONL) and posts new assistant
// messages to the unjargon web app. All LLM work happens server-side.
package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"github.com/chrisa142857/unjargon.app/collector/internal/parse"
	"github.com/chrisa142857/unjargon.app/collector/internal/ship"
	"github.com/chrisa142857/unjargon.app/collector/internal/tail"
)

const usage = `unjargond — the unjargon.app collector

Usage:
  unjargond run    -file <transcript.jsonl> [flags]   tail a live transcript and ship it
  unjargond replay <fixture.jsonl> [flags]            replay a recorded session with pacing

Common flags:
  -server URL   unjargon web app (default http://localhost:3000, env UNJARGON_SERVER)
  -token  TOK   device bearer token (env UNJARGON_TOKEN)
  -device NAME  device name shown in the UI (default hostname)

Replay flags:
  -delay DUR    pause between shipped messages (default 2s)
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	switch os.Args[1] {
	case "run":
		cmdRun(os.Args[2:])
	case "replay":
		cmdReplay(os.Args[2:])
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

func commonFlags(fs *flag.FlagSet) (server, token, device *string) {
	server = fs.String("server", envOr("UNJARGON_SERVER", "http://localhost:3000"), "unjargon web app URL")
	token = fs.String("token", os.Getenv("UNJARGON_TOKEN"), "device bearer token")
	device = fs.String("device", hostname(), "device name")
	return
}

// cmdRun tails one transcript file (walking-skeleton mode; hook-based
// discovery of transcripts arrives in the hardening step).
func cmdRun(args []string) {
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	server, token, device := commonFlags(fs)
	file := fs.String("file", "", "transcript JSONL file to tail (required)")
	interval := fs.Duration("interval", 2*time.Second, "poll interval")
	fs.Parse(args)
	if *file == "" {
		log.Fatal("run: -file is required")
	}

	parser := parse.ClaudeCode{}
	shipper := &ship.Shipper{ServerURL: *server, Token: *token, Device: *device, Tool: parser.Tool()}
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

// cmdReplay pushes a recorded fixture through the same tail→parse→ship
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
