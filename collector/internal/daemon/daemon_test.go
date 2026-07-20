package daemon

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/chrisa142857/unjargon.app/collector/internal/ship"
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

func TestReportStatusWithoutExpander(t *testing.T) {
	var got struct {
		BudgetUsed  int `json:"budget_used"`
		BudgetLimit int `json:"budget_limit"`
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Error(err)
		}
	}))
	defer server.Close()

	d := &Daemon{cfg: Config{Shipper: &ship.Shipper{ServerURL: server.URL, Token: "test"}}}
	d.reportStatus()
	if got.BudgetUsed != 0 || got.BudgetLimit != 0 {
		t.Fatalf("status = %d/%d, want disabled 0/0", got.BudgetUsed, got.BudgetLimit)
	}
}
