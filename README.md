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

- **`/live` — the Unjargon Stream.** Every agent message arrives already translated
  into 1-3 plain sentences; trivial chatter passes through untouched. ▸ expands the
  verbatim original with jargon highlighted; tap a highlight for a sentence-level
  rewrite, go deeper for the L1/L2/L3 term card (L3 is grounded in *your* session).
  ⌘/ctrl-J flips the whole stream to originals as you outgrow the subtitles, and the
  calibration selector (new / technical amateur / expert) tunes every rewrite.
- **`/wiki` — the durable glossary.** Everything your agents taught you, across all
  machines and sessions, searchable and grouped by domain.
- **Trust rules, enforced in the prompt and in code:** failures are never softened,
  numbers/outcomes/filenames are copied verbatim, terms are never invented, and the
  annotated original is always one tap away.

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

## Install a collector (any machine your agents run on)

```sh
curl -fsSL https://unjargon.app/install.sh | sh -s -- --token uj_xxx
```

No root, no runtime deps. The installer drops a single static binary in
`~/.local/bin`, registers a Claude Code `SessionStart` hook (so the collector is
told the exact transcript path the moment a session starts — directory watching
of `~/.claude/projects/**` remains as fallback), and starts `unjargond` as a
user-level service: launchd on macOS, `systemd --user` on Linux, or a plain
background process with a PID file on HPC login nodes without user sessions.

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
cp .env.example .env.local   # fill in DATABASE_URL, ANTHROPIC_API_KEY, INGEST_TOKEN
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
