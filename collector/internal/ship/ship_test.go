package ship

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
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
