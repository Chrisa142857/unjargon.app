package parse

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"time"
)

// Codex parses Codex CLI rollout JSONL (~/.codex/sessions/YYYY/MM/DD/*.jsonl).
//
// Stateful per file: the session_meta line (first in the file) carries the
// session id and cwd; subsequent response_item lines don't repeat them. The
// filename works as a session-id fallback for files missing the meta line.
type Codex struct {
	sessionID string
	cwd       string
}

func NewCodex(path string) *Codex {
	base := filepath.Base(path)
	return &Codex{sessionID: strings.TrimSuffix(base, filepath.Ext(base))}
}

func (*Codex) Tool() string { return "codex" }

type codexLine struct {
	Timestamp string          `json:"timestamp"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
}

type codexMeta struct {
	ID  string `json:"id"`
	CWD string `json:"cwd"`
}

type codexItem struct {
	Type    string `json:"type"`
	Role    string `json:"role"`
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
}

func (c *Codex) ParseLine(line []byte) (AgentMessage, bool) {
	var l codexLine
	if err := json.Unmarshal(line, &l); err != nil {
		return AgentMessage{}, false
	}
	switch l.Type {
	case "session_meta":
		var meta codexMeta
		if err := json.Unmarshal(l.Payload, &meta); err == nil {
			if meta.ID != "" {
				c.sessionID = meta.ID
			}
			if meta.CWD != "" {
				c.cwd = meta.CWD
			}
		}
		return AgentMessage{}, false
	case "response_item":
		var item codexItem
		if err := json.Unmarshal(l.Payload, &item); err != nil {
			return AgentMessage{}, false
		}
		if item.Type != "message" || item.Role != "assistant" {
			return AgentMessage{}, false
		}
		var parts []string
		for _, b := range item.Content {
			if (b.Type == "output_text" || b.Type == "text") && strings.TrimSpace(b.Text) != "" {
				parts = append(parts, b.Text)
			}
		}
		if len(parts) == 0 {
			return AgentMessage{}, false
		}
		ts, err := time.Parse(time.RFC3339, l.Timestamp)
		if err != nil {
			ts = time.Now().UTC()
		}
		return AgentMessage{
			SessionID: c.sessionID,
			CWD:       c.cwd,
			Timestamp: ts,
			Text:      strings.Join(parts, "\n\n"),
		}, true
	default:
		return AgentMessage{}, false
	}
}
