// Package ship posts batches of agent messages to the unjargon web app.
// Message text passes through the redaction pass on batch construction, so
// secrets never leave the machine — not even into the offline queue.
package ship

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/chrisa142857/unjargon.app/collector/internal/parse"
	"github.com/chrisa142857/unjargon.app/collector/internal/redact"
)

type Shipper struct {
	ServerURL string // e.g. https://unjargon.app
	Token     string // bearer device token
	Device    string // human-readable device name (hostname by default)
	Tool      string // "claude-code", "codex", ...
	Client    *http.Client
}

type Message struct {
	TS   string `json:"ts"`
	Text string `json:"text"`
}

type Batch struct {
	Device    string    `json:"device"`
	Tool      string    `json:"tool"`
	SessionID string    `json:"session_id"`
	CWD       string    `json:"cwd"`
	Messages  []Message `json:"messages"`
}

// FromMessages builds a redacted batch. All messages must share a session
// (the tailer works per transcript file, so this holds naturally).
func (s *Shipper) FromMessages(msgs []parse.AgentMessage) Batch {
	if len(msgs) == 0 {
		return Batch{}
	}
	b := Batch{
		Device:    s.Device,
		Tool:      s.Tool,
		SessionID: msgs[0].SessionID,
		CWD:       msgs[0].CWD,
	}
	for _, m := range msgs {
		b.Messages = append(b.Messages, Message{
			TS:   m.Timestamp.UTC().Format(time.RFC3339Nano),
			Text: redact.Clean(m.Text),
		})
	}
	return b
}

// Send posts messages as one batch, with internal retry/backoff.
func (s *Shipper) Send(msgs []parse.AgentMessage) error {
	if len(msgs) == 0 {
		return nil
	}
	return s.SendBatch(s.FromMessages(msgs))
}

func (s *Shipper) SendBatch(b Batch) error {
	body, err := json.Marshal(b)
	if err != nil {
		return err
	}
	return s.SendRaw(body)
}

// SendRaw posts an already-marshaled batch (used when flushing the offline
// queue). Retries transient failures with exponential backoff; auth and
// malformed-request errors fail immediately.
func (s *Shipper) SendRaw(body []byte) error {
	client := s.Client
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	var lastErr error
	for attempt, delay := 0, time.Second; attempt < 4; attempt, delay = attempt+1, delay*2 {
		if attempt > 0 {
			time.Sleep(delay)
		}
		req, err := http.NewRequest(http.MethodPost, s.ServerURL+"/api/ingest", bytes.NewReader(body))
		if err != nil {
			return err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+s.Token)
		resp, err := client.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		resp.Body.Close()
		if resp.StatusCode == http.StatusOK {
			return nil
		}
		lastErr = fmt.Errorf("ingest returned %s", resp.Status)
		if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusBadRequest {
			return lastErr // retrying won't help
		}
	}
	return lastErr
}
