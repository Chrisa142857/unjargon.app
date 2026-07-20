---
title: unjargon
emoji: 📺
colorFrom: gray
colorTo: yellow
sdk: docker
app_port: 7860
pinned: false
license: mit
short_description: Zero-AI jargon detection for Claude Code and Codex
---

# unjargon.app

> Find the technical terms your agents use. Explain one only when you choose.

unjargon watches Claude Code and Codex transcripts on macOS and Linux, sends
redacted assistant messages to your account, and builds a live jargon board.
The message remains verbatim. Paths, flags, commands, packages, and code
identifiers are intentionally not treated as jargon.

## Zero-AI by default

History import and jargon detection make **zero AI calls**. The server uses:

1. the published De-Jargonizer BBC word-frequency data to reject ordinary
   uppercase English;
2. high-confidence technical initialisms and curated technical/contextual
   vocabulary; and
3. artifact-shape rules that ignore paths, flags, commands, packages, and
   identifiers.

The dataset is bundled in `web/data/`; its source and license are recorded in
[`web/data/README.md`](web/data/README.md). Rare-word frequency is not used as
an automatic chip source: it measures unfamiliarity, not whether a word has a
distinct glossary meaning.

When a user taps **“explain what this means · 1 AI call”** or **“explain in my
sessions · 1 AI call”**, unjargon uses server AI only when both
`UNJARGON_ALLOW_SERVER_AI=1` and `ANTHROPIC_API_KEY` are configured; otherwise
it queues that single request for the paired collector's local AI CLI. Leave
the opt-in flag unset for a zero-cost deployment. No card opening, transcript
import, or detector pass calls AI.

## Install a collector

Sign in at [unjargon.onrender.com](https://unjargon.onrender.com), create a
pairing code, then run this on the machine where Claude Code or Codex runs:

```sh
curl -fsSL https://raw.githubusercontent.com/Chrisa142857/unjargon.app/main/install.sh \
  | sh -s -- --server https://unjargon.onrender.com
```

The installer writes a user-level service, imports existing Claude Code and
Codex sessions once, and then tails new sessions. It creates a Claude Code
`SessionStart` hook for quick discovery; directory scanning remains the
cross-tool fallback.

## Architecture

```text
Claude Code / Codex → unjargond → HTTPS → Render (Next.js + SSE)
                                             ↓ private Worker gateway
                                         Cloudflare D1 → browser term board
```

- `collector/` — static Go `unjargond`: discovers transcript JSONL, redacts
  secrets, preserves byte offsets, buffers failed uploads, and ships raw text.
- `web/` — Next.js, Drizzle, D1 schema/proxy client, zero-AI detector, term database, SSE,
  Google login, pairing, and opt-in explanation queue.
- `install.sh` — macOS/Linux installer for the collector service.

## Development

```sh
cd web
npm install
npm run check:d1
npm run check:detector
npm run lint
npm run dev

cd ../collector
go test ./...
go build -o unjargond ./cmd/unjargond
```

Server AI needs both `UNJARGON_ALLOW_SERVER_AI=1` and `ANTHROPIC_API_KEY` and
is used only by explicit explanation buttons. `UNJARGON_FAKE_TRANSLATOR=1`
provides deterministic, on-demand explanation text for demos.

See [`HANDOFF.md`](HANDOFF.md) for current deployment and implementation notes.
See [`DEPLOY.md`](DEPLOY.md) to create the free D1 database and Worker gateway.
