package buffer

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

type partialError struct{ error }

func (partialError) Remaining() []byte { return []byte(`{"v":"remaining"}`) }

func TestPushFlushOrder(t *testing.T) {
	q, err := New(t.TempDir() + "/queue")
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range []string{"a", "b", "c"} {
		if err := q.Push(map[string]string{"v": s}); err != nil {
			t.Fatal(err)
		}
	}
	if q.Len() != 3 {
		t.Fatalf("len=%d want 3", q.Len())
	}

	// First flush: network down after the first batch → stops, keeps order.
	var got []string
	sent, _ := q.Flush(func(raw []byte) error {
		if len(got) == 1 {
			return errors.New("network down")
		}
		got = append(got, string(raw))
		return nil
	})
	if sent != 1 || q.Len() != 2 {
		t.Fatalf("sent=%d len=%d, want 1 sent, 2 left", sent, q.Len())
	}

	// Network back: the rest flushes in order.
	sent, err = q.Flush(func(raw []byte) error {
		got = append(got, string(raw))
		return nil
	})
	if err != nil || sent != 2 || q.Len() != 0 {
		t.Fatalf("sent=%d err=%v len=%d", sent, err, q.Len())
	}
	for i, want := range []string{`{"v":"a"}`, `{"v":"b"}`, `{"v":"c"}`} {
		if got[i] != want {
			t.Errorf("order[%d]=%s want %s", i, got[i], want)
		}
	}
}

func TestFlushReplacesPartiallyAcknowledgedBatch(t *testing.T) {
	q, err := New(t.TempDir() + "/queue")
	if err != nil {
		t.Fatal(err)
	}
	if err := q.Push(map[string]string{"v": "all"}); err != nil {
		t.Fatal(err)
	}
	_, err = q.Flush(func([]byte) error { return partialError{errors.New("daily cap")} })
	if err == nil {
		t.Fatal("want partial failure")
	}
	entries, err := os.ReadDir(q.Dir)
	if err != nil || len(entries) != 1 {
		t.Fatalf("entries = %v, err = %v", entries, err)
	}
	data, err := os.ReadFile(filepath.Join(q.Dir, entries[0].Name()))
	if err != nil {
		t.Fatal(err)
	}
	if got, want := string(data), `{"v":"remaining"}`; got != want {
		t.Fatalf("queued = %s, want %s", got, want)
	}
}
