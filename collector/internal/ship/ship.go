// Package ship posts batches of agent messages to the unjargon web app.
// Message text passes through the redaction pass on batch construction, so
// secrets never leave the machine — not even into the offline queue.
package ship

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/chrisa142857/unjargon.app/collector/internal/parse"
	"github.com/chrisa142857/unjargon.app/collector/internal/redact"
)

type Shipper struct {
	ServerURL string // e.g. https://unjargon.app
	Token     string // bearer device token
	Device    string // human-readable device name (hostname by default)
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

const maxMessagesPerRequest = 20

// RetryAfterError preserves the server's daily-cap backoff so a large
// backfill stays on disk instead of retrying every collector poll.
type RetryAfterError struct{ Until time.Time }

func (e *RetryAfterError) Error() string {
	return fmt.Sprintf("ingest paused until %s", e.Until.UTC().Format(time.RFC3339))
}

// PartialError contains only the unacknowledged tail of a chunked batch.
// The offline queue replaces its current file with Remaining(), so successful
// history chunks are never replayed after a free-tier pause.
type PartialError struct {
	Err   error
	Batch Batch
}

func (e *PartialError) Error() string { return e.Err.Error() }
func (e *PartialError) Unwrap() error { return e.Err }
func (e *PartialError) Remaining() []byte {
	data, _ := json.Marshal(e.Batch)
	return data
}

// FromMessages builds a redacted batch for one tool. All messages must share
// a session (the tailer works per transcript file, so this holds naturally).
func (s *Shipper) FromMessages(tool string, msgs []parse.AgentMessage) Batch {
	if len(msgs) == 0 {
		return Batch{}
	}
	b := Batch{
		Device:    s.Device,
		Tool:      tool,
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
func (s *Shipper) Send(tool string, msgs []parse.AgentMessage) error {
	if len(msgs) == 0 {
		return nil
	}
	return s.SendBatch(s.FromMessages(tool, msgs))
}

func (s *Shipper) SendBatch(b Batch) error {
	for start := 0; start < len(b.Messages); start += maxMessagesPerRequest {
		part := b
		end := start + maxMessagesPerRequest
		if end > len(b.Messages) {
			end = len(b.Messages)
		}
		part.Messages = b.Messages[start:end]
		body, err := json.Marshal(part)
		if err != nil {
			return err
		}
		if err := s.sendRaw(body); err != nil {
			return &PartialError{Err: err, Batch: Batch{
				Device: b.Device, Tool: b.Tool, SessionID: b.SessionID, CWD: b.CWD,
				Messages: b.Messages[start:],
			}}
		}
	}
	return nil
}

// SendRaw posts an already-marshaled offline batch. Reparse it so buffered
// pre-D1 batches receive the same safe request chunking as live sends.
func (s *Shipper) SendRaw(body []byte) error {
	var batch Batch
	if err := json.Unmarshal(body, &batch); err == nil && len(batch.Messages) > 0 {
		return s.SendBatch(batch)
	}
	return s.sendRaw(body)
}

func (s *Shipper) sendRaw(body []byte) error {
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
		if resp.StatusCode == http.StatusTooManyRequests {
			until := retryAfter(resp.Header.Get("Retry-After"))
			resp.Body.Close()
			return &RetryAfterError{Until: until}
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

func retryAfter(value string) time.Time {
	if seconds, err := strconv.Atoi(strings.TrimSpace(value)); err == nil && seconds > 0 {
		return time.Now().Add(time.Duration(seconds) * time.Second)
	}
	if when, err := http.ParseTime(value); err == nil && when.After(time.Now()) {
		return when
	}
	return time.Now().Add(time.Minute)
}

// RetryUntil unwraps a server-provided Retry-After pause from a partial batch.
func RetryUntil(err error) (time.Time, bool) {
	var retry *RetryAfterError
	if errors.As(err, &retry) {
		return retry.Until, true
	}
	return time.Time{}, false
}
