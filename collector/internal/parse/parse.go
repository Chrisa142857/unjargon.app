// Package parse turns raw transcript lines into AgentMessages.
//
// Transcript formats are internal to the agent tools and version-drift, so
// parsers are defensive: extract assistant-role text blocks only, ignore
// unknown fields and unknown line types, and never fail hard on one bad line.
package parse

import (
	"strings"
	"time"
)

// AgentMessage is one assistant message extracted from a transcript.
type AgentMessage struct {
	SessionID string
	CWD       string
	Timestamp time.Time
	Text      string
}

// Parser parses one complete transcript line. ok is false for lines that
// carry no assistant text (user turns, tool results, unknown types, garbage).
// A Parser instance belongs to ONE transcript file: some formats (Codex)
// carry session metadata only on their first line, so parsers may be stateful.
type Parser interface {
	Tool() string
	ParseLine(line []byte) (msg AgentMessage, ok bool)
}

// ForPath returns a fresh parser for a transcript path. Claude Code is the
// default; paths under a .codex directory get the Codex rollout parser.
func ForPath(path string) Parser {
	if strings.Contains(path, "/.codex/") || strings.Contains(path, "codex") {
		return NewCodex(path)
	}
	return ClaudeCode{}
}
