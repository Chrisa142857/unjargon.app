package daemon

import (
	"os"
	"path/filepath"
	"testing"
)

func TestBackfillResetsOldOffsetsOnlyOnce(t *testing.T) {
	state := t.TempDir()
	if err := os.WriteFile(filepath.Join(state, "offsets.json"), []byte(`{"old":42}`), 0o600); err != nil {
		t.Fatal(err)
	}
	d, err := New(Config{StateDir: state, BackfillExisting: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := d.offsets.get("old"); ok {
		t.Fatal("backfill did not reset existing offsets")
	}
	d.offsets.set("new", 9)
	if err := d.offsets.save(); err != nil {
		t.Fatal(err)
	}
	d, err = New(Config{StateDir: state, BackfillExisting: true})
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := d.offsets.get("new"); !ok || got != 9 {
		t.Fatalf("backfill reset progress: got %d, exists %t", got, ok)
	}
}
