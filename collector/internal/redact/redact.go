// Package redact strips obvious secrets from agent text before it leaves the
// machine. Default rules per HANDOFF §6: regexes for common key formats plus
// refusal of .env-like blobs. Better to over-redact a hair than to ship a key.
package redact

import (
	"regexp"
	"strings"
)

var patterns = []*regexp.Regexp{
	// PEM private key blocks (first: they contain base64 the other rules miss)
	regexp.MustCompile(`-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----`),
	// Vendor-prefixed API keys/tokens
	regexp.MustCompile(`\bsk-[A-Za-z0-9_-]{16,}\b`),              // OpenAI/Anthropic style (covers sk-ant-…)
	regexp.MustCompile(`\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b`), // GitHub tokens
	regexp.MustCompile(`\bgithub_pat_[A-Za-z0-9_]{22,}\b`),
	regexp.MustCompile(`\bxox[abprs]-[A-Za-z0-9-]{10,}\b`),       // Slack
	regexp.MustCompile(`\bAKIA[0-9A-Z]{16}\b`),                   // AWS access key id
	regexp.MustCompile(`\bAIza[0-9A-Za-z_-]{35}\b`),              // Google API key
	// JWTs
	regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b`),
	// Bearer credentials in headers/snippets
	regexp.MustCompile(`(?i)\b(bearer|authorization:\s*bearer)\s+[A-Za-z0-9._~+/=-]{16,}`),
	// Generic assignments of secret-looking names to non-trivial values
	regexp.MustCompile(`(?i)\b([A-Z0-9_]*(SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY)[A-Z0-9_]*)\s*[=:]\s*['"]?[^\s'"]{8,}['"]?`),
}

// envBlobLine matches one KEY=value line as found in .env files.
var envBlobLine = regexp.MustCompile(`^\s*(export\s+)?[A-Z][A-Z0-9_]{2,}=\S`)

const placeholder = "[redacted]"

// Clean returns text with likely secrets replaced by [redacted]. Runs of 3+
// consecutive .env-style KEY=value lines are collapsed entirely — that's an
// .env file being echoed, refuse the whole blob. Blob detection runs first:
// the per-key patterns would otherwise rewrite lines and break up the run.
func Clean(text string) string {
	text = dropEnvBlobs(text)
	for _, p := range patterns {
		text = p.ReplaceAllString(text, placeholder)
	}
	return text
}

func dropEnvBlobs(text string) string {
	var out, run []string
	flushRun := func() {
		if len(run) >= 3 {
			out = append(out, "[redacted .env-like block]")
		} else {
			out = append(out, run...)
		}
		run = nil
	}
	for _, line := range strings.Split(text, "\n") {
		if envBlobLine.MatchString(line) {
			run = append(run, line)
			continue
		}
		flushRun()
		out = append(out, line)
	}
	flushRun()
	return strings.Join(out, "\n")
}
