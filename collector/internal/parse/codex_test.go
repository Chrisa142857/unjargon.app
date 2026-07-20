package parse

import (
	"bufio"
	"os"
	"strings"
	"testing"
)

func TestCodexFixture(t *testing.T) {
	f, err := os.Open("../../fixtures/codex-session.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	p := NewCodex("/home/wei/.codex/sessions/2026/07/16/rollout-2026-07-16-abc.jsonl")
	var msgs []AgentMessage
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 1024*1024), 16*1024*1024)
	for sc.Scan() {
		if m, ok := p.ParseLine(sc.Bytes()); ok {
			msgs = append(msgs, m)
		}
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}

	// 2 assistant messages; user turns, function calls/outputs, meta,
	// turn_context and event_msg lines are all skipped.
	if len(msgs) != 2 {
		t.Fatalf("got %d messages, want 2", len(msgs))
	}
	for _, m := range msgs {
		// Session id and cwd come from the session_meta line.
		if m.SessionID != "0198a4c2-7d1e-7f3a-9b2c-e5d6f7a8b9c0" {
			t.Errorf("wrong sessionID: %q", m.SessionID)
		}
		if m.CWD != "/home/wei/projects/survey-analysis" {
			t.Errorf("wrong cwd: %q", m.CWD)
		}
	}
	if !strings.Contains(msgs[0].Text, "bootstrap CIs") {
		t.Errorf("unexpected first message: %.80q", msgs[0].Text)
	}
	if !strings.Contains(msgs[1].Text, "p=0.41") {
		t.Errorf("unexpected second message: %.80q", msgs[1].Text)
	}
}

func TestCodexFilenameFallback(t *testing.T) {
	p := NewCodex("/x/.codex/sessions/2026/07/16/rollout-xyz.jsonl")
	m, ok := p.ParseLine([]byte(`{"timestamp":"2026-07-16T15:10:41Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello world, long enough"}]}}`))
	if !ok {
		t.Fatal("should parse")
	}
	if m.SessionID != "rollout-xyz" {
		t.Errorf("fallback session id: %q", m.SessionID)
	}
}

func TestForPath(t *testing.T) {
	if ForPath("/home/u/.claude/projects/x/s.jsonl").Tool() != "claude-code" {
		t.Error("claude path should get CC parser")
	}
	if ForPath("/home/u/.codex/sessions/2026/07/16/r.jsonl").Tool() != "codex" {
		t.Error("codex path should get codex parser")
	}
	if ForPath("/home/u/.claude/projects/codex-notes/s.jsonl").Tool() != "claude-code" {
		t.Error("a Claude project name containing codex should get the Claude parser")
	}
}
