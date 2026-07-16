# unjargon.app

> Agents love initials and jargon; users don't know them in context. unjargon is
> subtitles for your agents — full-speed agents anywhere, understanding everywhere.

unjargon watches agent transcripts (Claude Code, Codex) wherever your agents run —
laptop, remote box, HPC login node — and serves a live plain-language translation
plus a click-to-learn glossary in the browser. Observability for humans, not engineers.

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

## Development

```sh
# web app
cd web
cp .env.example .env.local   # fill in DATABASE_URL, ANTHROPIC_API_KEY, INGEST_TOKEN
npm install
npm run dev

# collector
cd collector
go build ./cmd/unjargond
./unjargond replay fixtures/session.jsonl   # deterministic demo replay
```

Secrets live in env vars only — never commit keys.

## Docs

Product spec and architecture live in the markdown docs at the repo root:
`HANDOFF.md` (start here) → `unjargon-spec.md` (v3, authoritative) →
`vibe-wiki-spec.md` (v2, architecture detail).
