# HANDOFF.md — unjargon.app

Orientation for the coding agent. This describes the system **as built and
deployed** (July 18, 2026). The original build plan and product specs are
historical — see §9.

Owner: Ziquan (wzq10101@gmail.com). Domain: unjargon.app.

> Agents love initials and jargon; users don't know them in context. unjargon
> is subtitles for your agents — full-speed agents anywhere, understanding
> everywhere.

## 1. What this is

**"Subtitles for your agents."** A Go collector (`unjargond`) tails Claude
Code (`~/.claude/projects/**/*.jsonl`) and Codex (`~/.codex/sessions/**`)
transcripts on any machine the user pairs, redacts secrets, and ships
assistant messages to a Next.js + Drizzle + Postgres web app. The app serves,
live over SSE: a plain-language subtitle per message, a term board of picked
jargon (keywords / terms / initials) with layered explanations
(L1 one-liner → L2 basic concept → L3 "in your sessions"), digests that
collapse long sessions, and a `/wiki` glossary.

## 2. Architecture invariants (current, do not silently break)

- **The user's own AI credentials do the LLM work by default.** Collectors run
  local-translate mode (`claude -p`, model haiku) — the server needs no API
  key. `ANTHROPIC_API_KEY` on the server is an optional override;
  `UNJARGON_FAKE_TRANSLATOR=1` is the offline dev/demo mode.
- **Transparency + budget:** at most 30 local AI subprocesses, each killed
  after 30 s, per rolling 5-hour window (15 min / 5% of local AI runtime),
  persisted in `~/.local/state/unjargond/ai-budget.json`. The budget never
  blocks tailing (`ErrBudgetWait`, never sleep); usage is always shown in the
  UI (header chip + import card). Covers translation, digest, and expansion
  work alike.
- **Trust rules, verbatim in `web/src/lib/prompts.ts` (all prompting lives in
  that one file):** never soften failures; numbers/outcomes/filenames
  verbatim; skip trivial messages; ≤3 sentences per subtitle; never invent
  terms not in the text; cap ~6 new terms/message.
- **Auth:** Google OAuth → HttpOnly signed SameSite=Lax cookie; collectors
  hold hashed per-device tokens obtained via short-lived pairing codes.
  `/api/ingest` accepts only paired-device credentials (the old global
  `INGEST_TOKEN` is gone — never reintroduce it). The authenticated app runs
  **same-origin on the backend**; there is deliberately no CORS.
- **Privacy boundary on the shared glossary:** only generic vocabulary
  ("term"/"initial" kinds, `terms.user_id NULL`) is shared across users.
  "keyword" terms (files, commands, internal artifact names) are per-user
  rows; shared L2 is generated without any transcript content; L3, learned
  state, sightings, messages, digests are all per-user/owner-filtered.
  Enforcement is mechanical (schema + code), not prompt-only — see §7.
- **Realtime = SSE** (in-process bus; swap to LISTEN/NOTIFY if ever
  serverless). Collector is polling-based (~2 s mtime) on purpose: inotify is
  unreliable on NFS/Lustre. Parse transcripts defensively (assistant-role
  text blocks only; per-tool parser behind an interface; fixtures under
  `collector/testdata`). Collector redacts key-like strings and `.env` blobs
  before anything leaves the machine.
- Render's dashboard is the owner's infrastructure admin, never a customer
  interface.

## 3. Repo map

| Path | What it is |
|---|---|
| `collector/cmd/unjargond` | CLI: `run` (daemon), `replay` (fixture demo), `hook` (SessionStart) |
| `collector/internal/daemon` | discovery, tailing, ship, work loops (expand → translate → digest), status reporting |
| `collector/internal/aicli` | local-translate mode: budget, `claude -p` invocation, output parsing, recursion guard |
| `collector/internal/{parse,tail,ship,buffer,redact}` | per-tool parsers, byte-offset tailer, HTTP shipping, offline queue, redaction |
| `web/src/lib/prompts.ts` | ALL prompting (translation, concept L2, grounding L3, digests, local variants) |
| `web/src/lib/{translate,digest,expand,glossary}.ts` | pipelines + the three work queues + zero-AI term matching |
| `web/src/lib/{auth,owner,api,bus}.ts` | cookie/device auth, ownership joins, API base + static-build bounce, SSE bus |
| `web/src/app/live/stream.tsx` | the /live app: term board, stream view, import-progress card, budget chip |
| `web/src/app/api/*` | routes; `work/{translate,digest,expand}` are the collector queues |
| `web/drizzle/*.sql` | migrations 0000–0008, applied by the container entrypoint on every deploy |
| `install.sh`, `deploy/`, `render.yaml`, `Dockerfile` | installer and Render/container deployment |
| `.github/workflows/` | `pages.yml`, `release-collector.yml` (dispatch with a tag), `backend-check.yml` (deployed wiring probe) |

## 4. Deployment and installer

- **Backend:** owner-managed Render service at `https://unjargon.onrender.com`
  (Docker, bundled Postgres unless `DATABASE_URL` is set — bundled storage
  resets on every deploy). Needs env: `AUTH_SECRET`, `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, `APP_URL`.
- **Frontend:** GitHub Pages deploys on every push to `main`
  (`pages.yml`; API base from the `UNJARGON_API_BASE` repo variable, falling
  back to the Render URL). The Pages site is the **landing page**; its static
  `/live`/`/wiki` bounce to the backend origin (`bounceToApiOrigin` in
  `web/src/lib/api.ts`) because cookie auth is same-origin only. Do not
  re-add a persistent top banner; it was intentionally removed.
- **Installer:** no secrets, just a pairing code created by the signed-in
  user in `/live`:

  ```sh
  curl -fsSL https://raw.githubusercontent.com/Chrisa142857/unjargon.app/main/install.sh \
    | sh -s -- --server https://unjargon.onrender.com
  ```

- **Collector releases:** `v0.1.5` is current (expansion work loop; `v0.1.4`
  added the non-blocking budget + translate-work loop). Older installs must
  re-run the install command or their queued work sits unserved.
  `release-collector.yml` runs `go test ./...` before building
  darwin/linux × amd64/arm64.
- **Verification:** dispatch `backend-check.yml` (Actions tab) — it probes
  every endpoint's auth from GitHub's runners, checks build currency (the
  prompt's privacy-rules marker), the OAuth redirect, landing links, and the
  Pages bundle's feature markers. Last run fully green. (The dev sandbox
  cannot reach onrender.com/github.io directly; probe from runners.)

## 5. Import pipeline, work queues, truthful progress

The persisted, globally chronological work queue is **Postgres itself**:
untranslated messages (`translated_at IS NULL`) ordered by message time
across every session/device a user owns. Totals, completions, and rate
survive any restart.

- Collectors always ship raw immediately; an exhausted budget returns
  `ErrBudgetWait` and the message ships untranslated. A no-key server leaves
  non-trivial messages queued — **nothing is ever permanently skipped**.
- Three collector work loops (30 s cycle, order: expansions first — a user is
  actively waiting — then translations oldest-first, then digests), all
  claim/complete with 5-minute claim reaping:
  `GET/POST /api/work/expand[/:id]`, `/api/work/translate`,
  `/api/work/digest[/:id]`.
- `POST /api/status` (device auth) stores per-device budget state on
  `devices.import_status`; `/api/bootstrap` returns
  `progress.{messages, translated, ratePerHour, pausedUntil, budgets[]}`.
  `ratePerHour` counts translations finished in the last hour from
  `translated_at` — **never inferred from upload recency**.
- The `/live` card shows `completed / total`, a real progress bar, the
  budget-pause resume time, and a rate-derived ETA; raw history is browsable
  throughout.

## 6. Shared jargon knowledge base

One user's extraction spend teaches every user, at zero marginal AI cost:

- **Zero-AI matching at ingest** (`web/src/lib/glossary.ts`): messages are
  matched against the shared glossary (SQL `position()` + word-boundary);
  sightings recorded before any translation. Unique index on
  `term_sightings(term_id, message_id)` prevents double-counting.
- Translation prompts list exactly the known terms present in the message
  (scales past any cap); L1 is first-seen-wins.
- **Cards default to the shared basic explanation** (L1 + L2; L2 generated
  once ever, globally, snippet-free). The in-context L3 is strictly opt-in
  ("explain in my sessions · 1 AI call",
  `POST /api/terms/:id/expand {level:"grounding"}`), cached per user. On a
  no-key server both layers queue (`expansion_requests`) for the requesting
  user's own collector; cards show a queued state and poll every 5 s.

## 7. Privacy enforcement detail

- `terms.user_id` (NULL = shared); keywords always owned; uniqueness per
  owner (`terms_owner_key` on `COALESCE(user_id,0), key`) so the same string
  yields separate rows per owner. Foreign private terms are never matched,
  listed, expanded, or learned (404), and never appear in the unauthenticated
  `GET /api/prompt` template.
- Mechanical guards in `translate.ts`: artifact-shaped strings (paths, files,
  dotted modules) are forced to kind "keyword" regardless of the model's
  label; a would-be-shared term whose L1/domain mentions the project name or
  a slash path is demoted to user-owned (`looksProjectSpecific`).
- L2 generation gets no transcript content (separate `conceptTool` call);
  L3 keeps the user's own snippet, cached in `user_terms`.
- `drizzle/0007_leak_cleanup.sql` scrubbed pre-boundary cross-user sightings,
  `user_terms` rows, and annotation refs.

## 8. Job log — July 18, 2026 session

All on `main`, deployed, verified end-to-end (stub-CLI daemon runs, psql
checks, Playwright screenshots, `go test`, `tsc`, eslint, and the deployed
wiring probe). Migrations `0004`–`0008` shipped; collector `v0.1.4`+`v0.1.5`
released.

1. Truthful import status and ETA (§5).
2. AI budget always visible in the UI (§5).
3. Shared jargon knowledge base with zero-AI matching (§6).
4. Privacy boundary on sharing, mechanically enforced (§7).
5. Card cost model: shared layers by default, in-context L3 opt-in (§6).
6. Expansion work queue for no-key servers (§5–6).
7. Deployed wiring verified; static pages bounce to the backend origin (§4).

**Next when needed (nothing is currently required):** managed Postgres before
inviting users (bundled DB resets per deploy); `FOR UPDATE SKIP LOCKED`
claims when multi-device users appear; a local pre-inventory only if the
post-install ramp-up confuses; authenticate `/api/prompt` (new collectors
could send their device token) to serve per-user keyword dedupe in
local-translate templates. Do not add teams/workspaces/admin screens until a
real customer needs them.

## 9. Historical documents

The original specs remain in the repo for product rationale, not for current
architecture — where they conflict with this file, **this file wins** (they
predate local-translate mode, Google auth, per-device pairing, the work
queues, and the Render/Pages deployment):

| File | Status |
|---|---|
| `unjargon-spec.md` (v3) | Product spec: feature hierarchy, stream UX, demo script |
| `vibe-wiki-spec.md` (v2) | Deep architecture background (says "vibe-wiki") |
| `prototype-spec.md` (v1) | Origin of L1/L2/L3 design (says "AgentLens") |
| `motivation-research.md` | Competitive landscape, README/pitch copy |
