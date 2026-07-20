# unjargon handoff

Last updated: 2026-07-19

## Product boundary

unjargon is a jargon detector and optional explainer for Claude Code and
Codex. It is **not** a message-subtitle product and it does not create session
digests.

- Agent messages stay verbatim in `/live`.
- Terms, acronyms, and their message spans become clickable chips.
- Paths, URLs, flags, commands, package/module names, filenames, and code
  identifiers are deliberately excluded from detection.
- Opening a term never calls AI. The two visible explanation buttons are the
  only AI entrypoints and are labelled `· 1 AI call`.

## Deployment

- Render backend: `https://unjargon.onrender.com`
- Public landing page: GitHub Pages for `Chrisa142857/unjargon.app`
- Render is one shared service managed by the project owner; users sign in
  with Google and pair a collector with a short-lived pairing code.
- There is no shared `INGEST_TOKEN`. The collector receives a per-device
  bearer credential after pairing.
- Required Render secrets: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `AUTH_SECRET`, `APP_URL=https://unjargon.onrender.com`, and durable
  `DATABASE_URL` if persistent data is wanted. `ANTHROPIC_API_KEY` is optional
  and only serves explicit explanation clicks.

## Current zero-AI pipeline

1. `unjargond` tails Claude Code/Codex JSONL, redacts text, and ships raw
   assistant messages.
2. `POST /api/ingest` stores the message, publishes its raw SSE event, then
   schedules `web/src/lib/detection.ts`.
3. The detector works oldest-first in bounded server batches, including
   already-uploaded history once `/api/bootstrap` is opened.
4. `web/src/lib/detect.ts` uses the bundled De-Jargonizer BBC frequency data,
   acronym rules, code/artifact masking, contextual-word rules, and a simple
   per-user weirdness score. The source and license are in
   `web/data/README.md`.
5. Detector results upsert only shared generic `term` / `initial` rows,
   create sightings + neutral annotations, set `messages.detected_at` as the
   processed marker, and publish a `detection` SSE event.

`translated_at`, subtitle fields, digest table, and keyword rows remain in the
database schema for compatibility with already deployed databases. New UI/API
paths do not use them. Migration `0009_detection.sql` adds `detected_at`, so
every pre-existing message receives the zero-AI pass once.

## AI calls

Automatic detection has no model call on Render or the collector.

- `POST /api/terms/:id/expand` requires `{action:"concept"}` or
  `{action:"grounding"}`. Missing action returns 400.
- `GET /api/terms/:id/expand` only reads cached/pending state; it cannot queue
  or generate an explanation.
- With `ANTHROPIC_API_KEY`, Render fulfils the explicit request.
- Without one, `/api/work/expand` queues the request for the paired collector.
  The local CLI budget remains capped at 30 × 30 seconds per rolling 5 hours.
- New collectors use `-local-explain` / `UNJARGON_LOCAL_EXPLAIN`; `auto`
  selects Claude Code or Codex when present. The old `-local-translate`
  setting is only a compatibility alias and no longer translates messages.
- `/api/prompt` and `/api/work/translate` were removed. That causes an old
  collector to stop before calling its old automatic local model path; release
  and reinstall a new collector binary to remove its dead code cleanly.

## Key files

| File | Purpose |
|---|---|
| `web/src/lib/detect.ts` | deterministic De-Jargonizer/rule detector |
| `web/src/lib/detection.ts` | persistence, history scheduling, annotations, SSE |
| `web/src/lib/expand.ts` | explicit-only L2/L3 explanation flow |
| `web/src/app/live/stream.tsx` | raw stream, detection progress, explicit buttons |
| `web/src/app/wiki/wiki.tsx` | same explicit explanation rule in the wiki |
| `collector/` | transcript discovery/redaction/shipping; optional expansion worker only |
| `install.sh` | macOS/Linux installation and zero-AI user-facing notice |

## Checks run locally

```sh
cd web
npm run check:detector
npm run lint
npx tsc --noEmit
npm run build
```

The detector check asserts that `ODE`, `RK4`, `BDF`, and `stiff` are found
while the dotted `scipy.integrate.solve_ivp` artifact is excluded. The build
now uses system fonts, so it does not depend on Google Fonts being reachable.

Run this before release:

```sh
cd collector && gofmt -w cmd/unjargond/main.go internal/aicli/aicli.go internal/daemon/daemon.go internal/ship/ship.go internal/parse/parse.go && go test ./...
```

## Next practical step

After publishing a collector release, reinstall it on a test macOS and Linux
machine. Pair it, import existing Claude Code and Codex history, and use
`/live` to confirm progress advances and a term card performs no network
`POST` until an explicit explanation button is pressed.
