package ship

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestSendBatchChunksForD1(t *testing.T) {
	var sizes []int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		var batch Batch
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&batch); err != nil {
			t.Fatal(err)
		}
		sizes = append(sizes, len(batch.Messages))
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	batch := Batch{Device: "test", Tool: "codex", SessionID: "session"}
	for range 41 {
		batch.Messages = append(batch.Messages, Message{TS: "2026-07-20T00:00:00Z", Text: "message"})
	}
	if err := (&Shipper{ServerURL: server.URL}).SendBatch(batch); err != nil {
		t.Fatal(err)
	}
	want := []int{20, 20, 1}
	if len(sizes) != len(want) {
		t.Fatalf("requests = %v, want %v", sizes, want)
	}
	for i := range want {
		if sizes[i] != want[i] {
			t.Fatalf("requests = %v, want %v", sizes, want)
		}
	}
}

func TestSendBatchKeepsOnlyUnsentMessagesAfterRetryAfter(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if requests == 2 {
			w.Header().Set("Retry-After", "60")
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	batch := Batch{Device: "test", Tool: "codex", SessionID: "session"}
	for range 41 {
		batch.Messages = append(batch.Messages, Message{TS: "2026-07-20T00:00:00Z", Text: "message"})
	}
	err := (&Shipper{ServerURL: server.URL}).SendBatch(batch)
	var partial *PartialError
	if !errors.As(err, &partial) {
		t.Fatalf("error = %v, want partial batch", err)
	}
	var remaining Batch
	if err := json.Unmarshal(partial.Remaining(), &remaining); err != nil {
		t.Fatal(err)
	}
	if len(remaining.Messages) != 21 {
		t.Fatalf("remaining messages = %d, want 21", len(remaining.Messages))
	}
	if until, ok := RetryUntil(err); !ok || until.Before(time.Now().Add(55*time.Second)) {
		t.Fatalf("retry until = %s, ok=%t", until, ok)
	}
}
