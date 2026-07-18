package aicli

import (
	"os"
	"path/filepath"
	"testing"
)

func TestBudgetCapsFiveHourWindowAcrossRestarts(t *testing.T) {
	state := t.TempDir()
	b := newBudget(state)
	for i := 0; i < 30; i++ {
		if !b.reserve() {
			t.Fatal("budget stopped before 5% limit")
		}
	}
	if b.reserve() {
		t.Fatal("budget exceeded 5% limit")
	}
	if _, err := os.Stat(filepath.Join(state, "ai-budget.json")); err != nil {
		t.Fatalf("budget was not persisted: %v", err)
	}
	if newBudget(state).reserve() {
		t.Fatal("restart bypassed budget")
	}
}

func TestExtractTranslation(t *testing.T) {
	cases := []struct {
		name, in string
		wantSub  string
		wantSkip bool
		wantErr  bool
	}{
		{
			name:    "bare json",
			in:      `{"skip": false, "subtitle": "Plain words.", "annotations": [], "terms": []}`,
			wantSub: "Plain words.",
		},
		{
			name:    "claude envelope with fenced json",
			in:      `{"type":"result","is_error":false,"result":"` + "```json\\n{\\\"skip\\\": false, \\\"subtitle\\\": \\\"From envelope.\\\"}\\n```" + `"}`,
			wantSub: "From envelope.",
		},
		{
			name:     "skip",
			in:       `{"skip": true}`,
			wantSkip: true,
		},
		{
			name:     "empty subtitle degrades to skip",
			in:       `{"skip": false, "subtitle": "  "}`,
			wantSkip: true,
		},
		{
			name:    "no json",
			in:      "sorry, I can't do that",
			wantErr: true,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			tr, err := extractTranslation([]byte(c.in))
			if c.wantErr {
				if err == nil {
					t.Fatalf("expected error, got %+v", tr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if tr.Skip != c.wantSkip || tr.Subtitle != c.wantSub {
				t.Errorf("got skip=%v subtitle=%q", tr.Skip, tr.Subtitle)
			}
		})
	}
}

func TestRecursionGuard(t *testing.T) {
	if !RecursionGuard("/home/u/.claude/projects/-home-u--local-state-unjargond-unjargond-translator/abc.jsonl") {
		t.Error("translator child transcript must be guarded")
	}
	if RecursionGuard("/home/u/.claude/projects/-home-u-code-myapp/abc.jsonl") {
		t.Error("normal transcript must not be guarded")
	}
}
