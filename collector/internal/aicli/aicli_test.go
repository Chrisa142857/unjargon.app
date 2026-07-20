package aicli

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestBudgetCapsFiveHourWindowAcrossRestarts(t *testing.T) {
	state := t.TempDir()
	b := newBudget(state)
	for i := 0; i < 30; i++ {
		if b.reserve() != 0 {
			t.Fatal("budget stopped before 5% limit")
		}
	}
	if b.reserve() <= 0 {
		t.Fatal("budget exceeded 5% limit")
	}
	if _, err := os.Stat(filepath.Join(state, "ai-budget.json")); err != nil {
		t.Fatalf("budget was not persisted: %v", err)
	}
	if newBudget(state).reserve() <= 0 {
		t.Fatal("restart bypassed budget")
	}
}

func TestCompleteReturnsBudgetWaitWithoutBlocking(t *testing.T) {
	tr := &Translator{Command: []string{"true"}, budget: newBudget(t.TempDir())}
	for range 30 {
		tr.budget.reserve()
	}
	start := time.Now()
	_, err := tr.Complete("prompt")
	var wait *ErrBudgetWait
	if !errors.As(err, &wait) {
		t.Fatalf("want ErrBudgetWait, got %v", err)
	}
	if time.Since(start) > time.Second {
		t.Fatal("Complete blocked instead of returning on an exhausted budget")
	}
	if !wait.Until.After(time.Now()) {
		t.Fatalf("Until must be in the future, got %s", wait.Until)
	}
	if used, limit, reset := tr.BudgetStatus(); used != 30 || limit != 30 || reset.IsZero() {
		t.Fatalf("BudgetStatus() = %d/%d reset %s", used, limit, reset)
	}
}

func TestRecursionGuard(t *testing.T) {
	if !RecursionGuard("/home/u/.claude/projects/-home-u--local-state-unjargond-unjargond-translator/abc.jsonl") {
		t.Error("explanation child transcript must be guarded")
	}
	if RecursionGuard("/home/u/.claude/projects/-home-u-code-myapp/abc.jsonl") {
		t.Error("normal transcript must not be guarded")
	}
}

func TestDetectUsesCodexWhenClaudeIsMissing(t *testing.T) {
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "codex"), []byte("#!/bin/sh\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin)
	t.Setenv("UNJARGON_TRANSLATE_CMD", "")
	tr, err := Detect("auto", t.TempDir())
	if err != nil || tr == nil {
		t.Fatalf("Detect(auto) = %v, %v", tr, err)
	}
	if got, want := strings.Join(tr.Command, " "), "codex exec --skip-git-repo-check --ephemeral --sandbox read-only"; got != want {
		t.Fatalf("command = %q, want %q", got, want)
	}
}
