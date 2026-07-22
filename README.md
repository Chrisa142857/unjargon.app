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

> Find the technical terms your agents use. Get a public reference for free,
> then ask for an in-context explanation only when you choose.

unjargon watches Claude Code and Codex transcripts on macOS and Linux, sends
redacted assistant messages to your account, and builds a live jargon board.
The message remains verbatim. Paths, flags, commands, packages, and code
identifiers are intentionally not treated as jargon.

## Zero-AI by default

History import and jargon detection make **zero AI calls**. The server uses:

1. the published De-Jargonizer BBC word-frequency data to reject ordinary
   uppercase English;
2. high-confidence technical acronyms and curated technical/contextual
   vocabulary; and
3. artifact-shape rules that ignore paths, flags, commands, packages, and
   identifiers.

The dataset is bundled in `web/data/`; its source and license are recorded in
[`web/data/README.md`](web/data/README.md). Rare-word frequency is not used as
an automatic chip source: it measures unfamiliarity, not whether a word has a
distinct glossary meaning. Opening a detected term can show a public Wikipedia
summary plus Google and Wikipedia links. That lookup sends only the detected
term, never a transcript, and makes no AI call.

When a user taps **“explain in my sessions · 1 AI call”**, unjargon first shows
a per-request confirmation that warns about local Claude Code/Codex usage and
the selected excerpt—or the most recent matching message when the user opens a
glossary term. Only a confirmed request can reach AI.
unjargon uses server AI only when both
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

## Built with Codex + GPT-5.6 Terra

unjargon was built **entirely by Codex with GPT-5.6 Terra** during OpenAI
Build Week — the builder wrote no code by hand. The primary build session is
`019f717b-b276-7660-9d7a-d3419838978e`.

Codex was used throughout, end to end. It turned the product from a
transcript collector into a privacy-conscious, zero-AI jargon tool: it
implemented and tested the Claude Code/Codex parsers, tightened the detector
so code-shaped text is not treated as jargon, wired the Render + Cloudflare
D1 deployment, and repeatedly verified the public app and installer end to
end. Connected to the builder's GitHub, Render, and Cloudflare accounts,
Codex shipped every deploy itself, and it fanned out subagent audits —
detector false-positive analysis over thousands of annotations, free-tier
cost and quota reviews, and deployment readiness — ending in a final review
with no remaining P0/P1 findings. Key product decisions were to make history
import and detection free of AI calls, make public references the default
explanation, and require a clear confirmation before a user spends any AI
credit for an in-context explanation.

The collaboration was deliberately iterative. The builder found the early
medium- and high-effort passes unsatisfactory, then requested ultra-effort
execution for most remaining work; those later passes completed the requested
implementation, debugging, deployment, and verification tasks. Codex and
GPT-5.6 Terra were used to build and validate the project, while unjargon's
runtime detector intentionally remains zero-AI by default.

The repository's earlier history also contains now-superseded iterations
written with other AI coding agents; during Build Week, Codex rewrote that
work into the current zero-AI product. No code was written by hand at any
stage.

## Development

```sh
cd web
npm install
npm run check:d1
npm run check:detector
npm run check:reference
npm run lint
npm run dev

cd ../collector
go test ./...
go build -o unjargond ./cmd/unjargond
```

A full local run of the web app needs, in `web/.env.local`: `D1_GATEWAY_URL`
and `D1_GATEWAY_TOKEN` (from the DEPLOY.md Worker gateway setup), plus
`AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `APP_URL`
(e.g. `http://localhost:3000`) for Google sign-in. The check scripts above
run offline against the bundled dataset and fixtures — no env needed.

Server AI needs both `UNJARGON_ALLOW_SERVER_AI=1` and `ANTHROPIC_API_KEY` and
is used only by the explicit, confirmed in-session explanation button.
`UNJARGON_FAKE_TRANSLATOR=1` provides deterministic, on-demand explanation
text for demos.

### Sample data

Recorded agent sessions live in `collector/fixtures/` (`session.jsonl` for
Claude Code, `codex-session.jsonl` for Codex). They feed the parser tests
(`go test ./...`), and you can replay one against a paired server to see the
whole pipeline work without waiting for a live agent:

```sh
./unjargond replay fixtures/session.jsonl -server http://localhost:3000 -token <device token>
```

The zero-AI detector's word-frequency dataset is bundled in `web/data/`
(source and license in [`web/data/README.md`](web/data/README.md)).

See [`HANDOFF.md`](HANDOFF.md) for current deployment and implementation notes.
See [`DEPLOY.md`](DEPLOY.md) to create the free D1 database and Worker gateway.
