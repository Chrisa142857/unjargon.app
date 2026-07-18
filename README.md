---
title: unjargon
emoji: 📺
colorFrom: gray
colorTo: yellow
sdk: docker
app_port: 7860
pinned: false
license: mit
short_description: Subtitles for your agents — live plain-language translation
---

# unjargon.app

> Agents love initials and jargon; users don't know them in context. unjargon is
> subtitles for your agents — full-speed agents anywhere, understanding everywhere.

unjargon watches agent transcripts (Claude Code, Codex) wherever your agents run —
laptop, remote box, HPC login node — and serves a live plain-language translation
plus a click-to-learn glossary in the browser. Observability for humans, not engineers.

- **`/live` — the term board first.** The primary surface is not the agent's words
  but what they're teaching you: every picked keyword, initial, and domain term,
  grouped by domain, freshest first — bright until you open it, dimmed once learned.
  Tap a chip for the collapsed card (term + one-line explanation); open it for the
  long in-context explanation grounded in the message it came from. A one-line strip
  shows the agent's latest activity.
- **The stream, one toggle away.** The full subtitle feed (1-3 plain sentences per
  message, trivial chatter passed through untouched) with ▸ to the verbatim
  annotated original — fidelity is always reachable, just never the default. ⌘/ctrl-J
  flips subtitles ⇄ originals; the calibration selector (new / technical amateur /
  expert) tunes every rewrite.
- **Long sessions collapse, they don't scroll.** Older stretches of the stream roll
  up into digest cards ("Tue 09:00–13:13 · 24 updates: sped up the pipeline 41s→6s,
  fixed two failing tests…") built from the subtitles under the same trust rules —
  tap to re-expand the real messages, which are always still there. A ★ highlights
  toggle filters to decisions, outcomes, and failures only (every message gets an
  importance score from the same single translation call).
- **`/wiki` — the durable glossary.** Everything your agents taught you, across all
  machines and sessions, searchable and grouped by domain.
- **Trust rules, enforced in the prompt and in code:** failures are never softened,
  numbers/outcomes/filenames are copied verbatim, terms are never invented, and the
  annotated original is always one tap away.

## Who pays for the AI? (transparency)

**By default, no API key is needed anywhere.** unjargond runs *local-translate
mode*: for each agent message it spawns a fresh headless session of the AI CLI
already installed and signed in on that machine (`claude -p`, haiku by default)
and ships the finished translation. That means:

- Translation uses **your existing Claude subscription/account** — roughly one
  extra lightweight AI call per substantive agent message (trivial acks are
  skipped without a call). unjargond announces this at startup, every time.
- Turn it off with `-local-translate=off` (or `UNJARGON_LOCAL_TRANSLATE=off`);
  the server then translates instead, if it has an `ANTHROPIC_API_KEY`.
- `UNJARGON_TRANSLATE_MODEL` picks the model (default `haiku`);
  `UNJARGON_TRANSLATE_CMD` swaps in a different AI CLI entirely.
- The prompt is fetched from the server's `GET /api/prompt` so the trust rules
  live in exactly one file (`web/src/lib/prompts.ts`) either way.
- Local translations pass through the same redaction pass as raw text before
  leaving the machine, and the server re-applies the same sanitizer caps.
- unjargond never tails the transcripts of its own translation sessions
  (they run in a marker directory the daemon refuses to track).

## How it works

```
  Mac laptop ──┐
  (unjargond)  │
               ├──HTTPS──►  unjargon.app  ──SSE──►  any browser, any OS
  HPC node ────┤            (Next.js + Postgres,
  (unjargond)  │             one Haiku call per message)
  remote box ──┘
```

- **`collector/`** — `unjargond`, a single static Go binary. Tails agent transcript
  JSONL files (byte offsets, complete lines only), extracts assistant text defensively,
  redacts secrets, and ships batches to the web app. Runs as a user-level service
  (launchd / `systemd --user` / plain background process on HPC). No root, no runtime deps.
- **`web/`** — Next.js + Drizzle + Postgres. Ingest API, a debounced single-LLM-call
  translation pipeline (`{subtitle, annotations, terms}`), SSE fan-out, and the
  **Unjargon Stream** at `/live`: auto-scrolling plain-language subtitles for every
  agent message, with the annotated original one tap away and layered term cards
  (L1/L2/L3) behind every highlighted term.

## Deploy for free

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Chrisa142857/unjargon.app)

Backend: one click on Render's card-free tier (`render.yaml`). Frontend:
GitHub Pages via the bundled workflow. Full steps and caveats: `DEPLOY.md`.

## Install a collector (any machine your agents run on)

```sh
curl -fsSL https://raw.githubusercontent.com/Chrisa142857/unjargon.app/main/install.sh \
  | sh -s -- --server https://unjargon.onrender.com
```

Open the hosted app first and sign in with Google. In the empty stream, create
a short-lived pairing code; the installer prompts for that code and exchanges
it once for a device-only credential. No Render secret is shared with users.

No root, no runtime deps. The installer drops a single static binary in
`~/.local/bin`, registers a Claude Code `SessionStart` hook (so the collector is
told the exact transcript path the moment a session starts — directory watching
of `~/.claude/projects/**` remains as fallback), and starts `unjargond` as a
user-level service: launchd on macOS, `systemd --user` on Linux, or a plain
background process with a PID file on HPC login nodes without user sessions.
It imports existing local Claude Code and Codex transcripts once, then tails
new activity. A large history can use many local translation calls.

Collector guarantees:

- **Polling tailer (~2s mtime), byte offsets, complete lines only** — works on
  NFS/Lustre where inotify silently fails; offsets persist across restarts so
  nothing is shipped twice.
- **Redaction before anything leaves the machine** — common API-key/token
  formats, PEM blocks, JWTs, and `.env`-like blobs are stripped client-side.
- **Offline buffer** — failed batches queue on disk and flush with backoff when
  the network returns (HPC networks flake).

## Development

```sh
# web app
cd web
cp .env.example .env.local   # fill in DATABASE_URL, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, AUTH_SECRET
npm install
npx drizzle-kit push         # create tables
npm run dev

# collector
cd collector
go test ./... && go build -o unjargond ./cmd/unjargond
./unjargond replay fixtures/session.jsonl   # deterministic demo replay
./unjargond run                             # full daemon (hook + dir discovery)
./unjargond run -file path/to/session.jsonl # single-file mode
```

Secrets live in env vars only — never commit keys. Without an
`ANTHROPIC_API_KEY`, set `UNJARGON_FAKE_TRANSLATOR=1` for a deterministic
offline translator (dev/demo fallback; loudly logged, never silent).

## Docs

Product spec and architecture live in the markdown docs at the repo root:
`HANDOFF.md` (start here) → `unjargon-spec.md` (v3, authoritative) →
`vibe-wiki-spec.md` (v2, architecture detail).
