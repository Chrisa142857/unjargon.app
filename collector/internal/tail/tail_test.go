package tail

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCompleteLinesOnly(t *testing.T) {
	path := filepath.Join(t.TempDir(), "s.jsonl")
	tl := New(path)

	// Missing file: no lines, no error.
	if lines, err := tl.Poll(); err != nil || lines != nil {
		t.Fatalf("missing file: lines=%v err=%v", lines, err)
	}

	// A partial line must not be consumed.
	if err := os.WriteFile(path, []byte(`{"a":1}`+"\n"+`{"b":`), 0o644); err != nil {
		t.Fatal(err)
	}
	lines, err := tl.Poll()
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 1 || string(lines[0]) != `{"a":1}` {
		t.Fatalf("got %q, want just the complete line", lines)
	}

	// Completing the line delivers it, stitched across polls.
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	f.WriteString("2}\n")
	f.Close()
	lines, err = tl.Poll()
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 1 || string(lines[0]) != `{"b":2}` {
		t.Fatalf("got %q, want the stitched line", lines)
	}

	// Nothing new → nothing returned.
	if lines, _ := tl.Poll(); len(lines) != 0 {
		t.Fatalf("expected no lines, got %q", lines)
	}
}

func TestPollBoundsLargeHistoryRead(t *testing.T) {
	path := filepath.Join(t.TempDir(), "large.jsonl")
	line := []byte(`{"message":"history"}` + "\n")
	data := make([]byte, 0, maxReadBytes+len(line))
	for len(data) <= maxReadBytes {
		data = append(data, line...)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	tailer := New(path)
	first, err := tailer.Poll()
	if err != nil {
		t.Fatal(err)
	}
	if len(first) == 0 || tailer.Offset() > maxReadBytes {
		t.Fatalf("first poll lines=%d offset=%d", len(first), tailer.Offset())
	}
	second, err := tailer.Poll()
	if err != nil || len(second) == 0 || tailer.Offset() != int64(len(data)) {
		t.Fatalf("second poll lines=%d offset=%d err=%v", len(second), tailer.Offset(), err)
	}
}
