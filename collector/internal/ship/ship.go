// Package ship posts batches of agent messages to the unjargon web app.
package ship

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/chrisa142857/unjargon.app/collector/internal/parse"
)

type Shipper struct {
	ServerURL string // e.g. https://unjargon.app
	Token     string // bearer device token
	Device    string // human-readable device name (hostname by default)
	Tool      string // "claude-code", "codex", ...
	Client    *http.Client
}

type wireMessage struct {
	TS   string `json:"ts"`
	Text string `json:"text"`
}

type wireBatch struct {
	Device    string        `json:"device"`
	Tool      string        `json:"tool"`
	SessionID string        `json:"session_id"`
	CWD       string        `json:"cwd"`
	Messages  []wireMessage `json:"messages"`
}

// Send posts one batch. All messages in a batch share a session (the tailer
// works per transcript file, so this holds naturally). Retries a few times
// with backoff; a full offline disk buffer comes in the hardening step.
func (s *Shipper) Send(msgs []parse.AgentMessage) error {
	if len(msgs) == 0 {
		return nil
	}
	batch := wireBatch{
		Device:    s.Device,
		Tool:      s.Tool,
		SessionID: msgs[0].SessionID,
		CWD:       msgs[0].CWD,
	}
	for _, m := range msgs {
		batch.Messages = append(batch.Messages, wireMessage{
			TS:   m.Timestamp.UTC().Format(time.RFC3339Nano),
			Text: m.Text,
		})
	}
	body, err := json.Marshal(batch)
	if err != nil {
		return err
	}

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
