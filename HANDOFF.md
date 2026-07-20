# unjargon handoff

Last updated: 2026-07-20

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
- Cloudflare D1: `unjargon` in ENAM, reached only through
  `https://unjargon-d1.unjargon-eab918.workers.dev/query`.
- Render is one shared service managed by the project owner; users sign in
  with Google and pair a collector with a short-lived pairing code.
- There is no shared `INGEST_TOKEN`. The collector receives a per-device
  bearer credential after pairing.
- Required Render secrets: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `AUTH_SECRET`, `APP_URL=https://unjargon.onrender.com`,
  `D1_GATEWAY_URL`, and `D1_GATEWAY_TOKEN`. The last two point to the
  authenticated `d1-worker/` Worker, which uses Cloudflare's native D1
  binding. Render holds no Cloudflare account token and has no
  `DATABASE_URL`. Server AI additionally requires both
  `UNJARGON_ALLOW_SERVER_AI=1` and `ANTHROPIC_API_KEY`; keep the opt-in flag
  unset for a zero-cost deployment.

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

On D1 Free, collector requests are split to 20 messages and the server uses
conservative daily import/detection ceilings. Backlog is paused—not skipped—at
the ceiling and resumes after 00:00 UTC via the collector heartbeat. The
collector honors `Retry-After`, keeps only the unacknowledged tail of a partial
upload, and reads giant transcript files in 1 MiB pieces. The limits default
to 4,000 incoming messages and 750 shared detections/day and can be adjusted with
`D1_DAILY_INGEST_MESSAGES` / `D1_DAILY_DETECTION_MESSAGES`.

For a large history, detection remains zero-AI and chronological. It works in
50-message batches, reuses glossary lookups within each batch, keeps only the
latest 200 raw messages in the browser, and reports the D1 daily-window pause
instead of a false one-hour completion estimate.

`translated_at`, subtitle fields, digest table, and keyword rows remain in the
fresh D1 baseline for compatibility with the current app data shape. New
UI/API paths do not use the legacy fields. `web/drizzle/` is the archived
Postgres migration history; apply only `web/d1/0000_init.sql` to a fresh D1.

## AI calls

Automatic detection has no model call on Render or the collector.

- `POST /api/terms/:id/expand` requires `{action:"concept"}` or
  `{action:"grounding"}`. Missing action returns 400.
- `GET /api/terms/:id/expand` only reads cached/pending state; it cannot queue
  or generate an explanation.
- Server AI requires both `UNJARGON_ALLOW_SERVER_AI=1` and
  `ANTHROPIC_API_KEY`. Leave the opt-in flag unset for a zero-cost deployment;
  with both set, Render fulfils the explicit request and incurs provider usage.
- Without one, `/api/work/expand` queues the request for the paired collector.
  The local CLI budget remains capped at 30 × 30 seconds per rolling 5 hours.
- A no-key server queues only when at least one of the user's collectors has
  recently reported local explanations enabled; otherwise the button returns
  a clear setup error instead of waiting forever.
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
| `web/src/db/` | SQLite schema plus Render-to-D1 Worker proxy client |
| `web/d1/0000_init.sql` | fresh, idempotent Cloudflare D1 baseline |
| `d1-worker/` | authenticated Worker that is the only D1 binding holder |
| `web/src/lib/expand.ts` | explicit-only L2/L3 explanation flow |
| `web/src/app/live/stream.tsx` | raw stream, detection progress, explicit buttons |
| `web/src/app/wiki/wiki.tsx` | same explicit explanation rule in the wiki |
| `collector/` | transcript discovery/redaction/shipping; optional expansion worker only |
| `install.sh` | macOS/Linux installation and zero-AI user-facing notice |

## Checks run locally

```sh
cd web
npm run check:d1
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

Publish this large-history fix, trigger a collector release, and reinstall it
on a test macOS and Linux machine. Pair it, import existing Claude Code and
Codex history, and use `/live` to confirm the shared daily-window progress and
automatic next-day resume.
