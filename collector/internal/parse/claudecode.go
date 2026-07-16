package parse

import (
	"encoding/json"
	"strings"
	"time"
)

// ClaudeCode parses Claude Code session JSONL (~/.claude/projects/**/*.jsonl).
type ClaudeCode struct{}

func (ClaudeCode) Tool() string { return "claude-code" }

// ccLine models only the fields we rely on; everything else is ignored.
type ccLine struct {
	Type      string `json:"type"`
	SessionID string `json:"sessionId"`
	CWD       string `json:"cwd"`
	Timestamp string `json:"timestamp"`
	Message   struct {
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

type ccBlock struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

func (ClaudeCode) ParseLine(line []byte) (AgentMessage, bool) {
	var l ccLine
	if err := json.Unmarshal(line, &l); err != nil {
		return AgentMessage{}, false
	}
	if l.Type != "assistant" || l.Message.Role != "assistant" {
		return AgentMessage{}, false
	}

	// Assistant content is a block array; take text blocks only (skip
	// tool_use, thinking, and any block type we don't recognize).
	var blocks []ccBlock
	if err := json.Unmarshal(l.Message.Content, &blocks); err != nil {
		return AgentMessage{}, false
	}
	var parts []string
	for _, b := range blocks {
		if b.Type == "text" && strings.TrimSpace(b.Text) != "" {
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
		SessionID: l.SessionID,
		CWD:       l.CWD,
		Timestamp: ts,
		Text:      strings.Join(parts, "\n\n"),
	}, true
}
