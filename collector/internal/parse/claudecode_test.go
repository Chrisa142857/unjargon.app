package parse

import (
	"bufio"
	"os"
	"strings"
	"testing"
)

func TestClaudeCodeFixture(t *testing.T) {
	f, err := os.Open("../../fixtures/session.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	var msgs []AgentMessage
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 1024*1024), 16*1024*1024)
	p := ClaudeCode{}
	for sc.Scan() {
		if m, ok := p.ParseLine(sc.Bytes()); ok {
			msgs = append(msgs, m)
		}
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}

	// The fixture has 4 assistant messages carrying text; tool_use-only
	// messages, user turns, tool results, summary and snapshot lines are skipped.
	if len(msgs) != 4 {
		t.Fatalf("got %d messages, want 4", len(msgs))
	}
	for _, m := range msgs {
		if m.SessionID != "9a2b7c1e-4f3d-4e8a-b6c5-2d1a9e8f7b3c" {
			t.Errorf("wrong sessionID: %q", m.SessionID)
		}
		if m.CWD != "/home/wei/projects/sim-pipeline" {
			t.Errorf("wrong cwd: %q", m.CWD)
		}
		if strings.Contains(m.Text, "Jacobian eigenvalues span many orders") {
			t.Error("thinking block leaked into text")
		}
	}
	if !strings.Contains(msgs[1].Text, "stiff") {
		t.Errorf("expected the stiff-ODE message second, got: %.80q", msgs[1].Text)
	}
	if !strings.Contains(msgs[3].Text, "40× faster") {
		t.Errorf("expected the outcome message last, got: %.80q", msgs[3].Text)
	}
}

func TestClaudeCodeGarbage(t *testing.T) {
	p := ClaudeCode{}
	for _, line := range []string{
		"",
		"not json",
		`{"type":"assistant"}`,
		`{"type":"assistant","message":{"role":"assistant","content":"plain string"}}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"x"}]}}`,
		`{"type":"unknown-future-type","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}`,
	} {
		if _, ok := p.ParseLine([]byte(line)); ok {
			t.Errorf("line should not parse: %q", line)
		}
	}
}
