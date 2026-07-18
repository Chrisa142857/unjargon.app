# HANDOFF.md — unjargon.app
Orientation for the coding agent. Read this first; it tells you which docs are authoritative and what to build.

---

## 1. What this project is

**unjargon.app** — "subtitles for your agents." A hackathon project (category: Work & Productivity) for vibe coders and vibe researchers who run Claude Code / Codex on machines they don't fully understand output from (laptops, Linux HPC clusters, remote boxes). Agents love initials and jargon; users don't know them in context. unjargon watches agent transcripts wherever agents run, and serves a live plain-language translation plus a click-to-learn glossary in the browser.

Owner: Ziquan (wzq10101@gmail.com). Domain: unjargon.app.

## 2. Document map (read in this order)

| File | Status | What it's for |
|---|---|---|
| `unjargon-spec.md` | **AUTHORITATIVE (v3)** | Current product spec: feature hierarchy, Unjargon Stream UX, single-call pipeline, MVP cut lines, demo script, risks |
| `vibe-wiki-spec.md` | Superseded (v2) — **still required reading** | v3 references it for full architecture detail: collector internals, install/service mechanics, HPC notes, transcript-discovery guarantee, backend/API/schema, deploy |
| `prototype-spec.md` | Historical (v1, Mac-native) | Origin of the L1/L2/L3 explanation design and extraction prompt rules. Skim only |
| `motivation-research.md` | Context | Competitive landscape + gap analysis; use for README/pitch copy, not for engineering |

Rule of conflict: v3 > v2 > v1. Product name is **unjargon** everywhere (v2 says "vibe-wiki", v1 says "AgentLens" — both renamed).

## 3. Locked decisions (do not relitigate)

- **Two components:** `unjargond` collector (Go, single static binary, darwin/linux × amd64/arm64) + web app (Next.js full-stack + Postgres). Collector is dumb (tail + ship); all LLM work server-side.
- **Capture = transcript files, not wrappers/screen.** Claude Code: `~/.claude/projects/**/*.jsonl` (append-only JSONL). Primary discovery via a `SessionStart` hook the installer registers in `~/.claude/settings.json` (hook input contains `transcript_path`; collector listens on localhost). Directory watch = fallback. Codex (`~/.codex/sessions/**`) is a nice-to-have drop-in parser.
- **User-level services, no root:** launchd LaunchAgent (macOS); `systemd --user` (Linux); plain background process + PID file (HPC without systemd user sessions). Polling fallback (~2s mtime) on NFS/Lustre where inotify is unreliable.
- **Killer feature = the Unjargon Stream** (auto-scrolling plain-language subtitles per agent message), then annotated-original expansion, then term chips/wiki. Default view requires zero clicks to understand.
- **One LLM call per debounced message** (≈2s debounce, Claude Haiku, strict JSON) returns `{subtitle, annotations[], terms[]}`. L1 eager; L2/L3 lazy on click, cached.
- **Trust rules in the rewrite prompt:** never soften failures; numbers/outcomes/filenames verbatim; skip trivial messages (acks, tool chatter); ≤3 sentences per subtitle; never invent terms not in the text; cap ~6 new terms/message.
- **Realtime = SSE**, not WebSockets. **Auth:** GitHub OAuth or magic link for web; bearer device-tokens for collectors. **Deploy:** Vercel + Neon/Supabase Postgres (or single Railway service).

## 4. Build order (MVP, thin end-to-end slice first)

1. **Monorepo scaffold:** `collector/` (Go) + `web/` (Next.js + Postgres via Prisma/Drizzle). Shared: none (JSON over HTTPS is the contract).
2. **Walking skeleton:** collector tails one hardcoded JSONL → `POST /api/ingest` → store → SSE → raw text renders in `/live`. Get this working before any LLM code.
3. **Translation pipeline:** debounce → Haiku call → `{subtitle, annotations, terms}` → subtitle stream UI with ▸ expansion and highlight taps.
4. **Term cards:** L1 from extraction; `POST /api/terms/:id/expand` for lazy L2/L3 (L3 prompt includes source-message snippet).
5. **Hardening for demo:** hook-based discovery, offline buffer + backoff, installer script (`install.sh` with `--token`), NFS polling fallback, `unjargond replay fixture.jsonl` command (deterministic demo fallback — record a real session as fixture early!).
6. Nice-to-have order: calibration slider → global toggle (⌘J) → `/wiki` page → Codex parser → quiz.

Definition of demo-done: two collectors (Mac laptop + Linux VM) feeding one `/live` stream in a browser, phone-friendly layout, term card opens with L3 grounded in the actual message.

## 5. Key implementation gotchas (learned during design)

- CC's JSONL entry format is **internal and version-drifts** — parse defensively: take assistant-role text blocks only, ignore unknown fields, keep parser per-tool behind an interface, test against recorded fixtures.
- Consume **only complete lines** when tailing (keep a remainder buffer per file); track byte offsets per file.
- Transcripts can contain secrets → collector runs a redaction pass (key-like strings, `.env` content) before sending.
- Claude Code on the web (cloud sandbox) leaves no local transcript — out of scope, don't chase it.
- Streaming means many small appends per message — the 2s debounce is what batches them into one translation call.

## 6. Open questions (owner input needed — don't block, pick the default)

- Postgres ORM choice (default: Drizzle) and Vercel vs Railway (default: whichever deploys first try).
- Calibration slider copy/levels (default: new / amateur / expert).
- Exact redaction rules (default: regex for common key formats + refuse `.env`-like blobs).

## 7. Pitch one-liner (for README)

> Agents love initials and jargon; users don't know them in context. unjargon is subtitles for your agents — full-speed agents anywhere, understanding everywhere.

---

## 8. Current deployment and installer state (July 2026)

- **Hosted backend:** a single owner-managed Render service is configured at
  `https://unjargon.onrender.com`. GitHub Pages builds set
  `NEXT_PUBLIC_API_BASE` from the `UNJARGON_API_BASE` repository variable; its
  fallback is the same Render URL.
- **Frontend:** GitHub Pages deploys on every push to `main` via
  `.github/workflows/pages.yml`. The `/live` empty state shows a centered,
  copy-paste collector install command. Do not re-add a persistent top banner;
  it was intentionally removed.
- **Installer:** `install.sh` is served from GitHub raw content and downloads
  binaries from GitHub Releases. It prompts for a short-lived pairing code
  created by the signed-in user in `/live`; it never asks for a Render secret:

  ```sh
  curl -fsSL https://raw.githubusercontent.com/Chrisa142857/unjargon.app/main/install.sh \
    | sh -s -- --server https://unjargon.onrender.com
  ```

  The first release is `v0.1.0`, with `darwin/linux × amd64/arm64` binaries.
  `.github/workflows/release-collector.yml` builds and publishes the next
  release when manually dispatched with a tag.
- **Verification:** GitHub Pages and the collector release workflow both last
  completed successfully after the changes above. Local frontend `npm ci` was
  not reliable in the development checkout (`ENOTEMPTY` in generated
  `node_modules`); use the clean GitHub Actions build as the recorded check.

## 9. Hosted-user implementation (July 2026)

The application now has the minimal hosted-user boundary:

- Google OAuth creates an HttpOnly, signed browser session.
- `users`, `pairings`, `devices.user_id`, and hashed per-device tokens are in
  `drizzle/0003_users.sql`.
- `/api/ingest` accepts only a paired device credential; the global
  `INGEST_TOKEN` is obsolete.
- Bootstrap and SSE reads are filtered by device owner. Generic L1/L2 terms
  remain shared; L3 and learned state are in `user_terms`.
- Render's dashboard is only for the owner's infrastructure administration;
  it must not be the customer/admin interface for the application.

Render is the owner's infrastructure dashboard, not a customer interface.

## 10. Minimum hosted-user migration (do this, skip the rest)

Render is owner-managed infrastructure. Users need ordinary individual
accounts; do not add workspaces, memberships, or app-level admin roles until
the product actually needs shared teams.

1. Use managed Postgres before inviting users; bundled database storage is
   ephemeral.
2. Apply `0003_users.sql` (the container entrypoint does this on deploy).
3. Remaining hardening: require owner checks on every legacy auxiliary route
   (`/api/wiki`, digest detail, and local-work endpoints) before exposing them
   to more than the owner.

Add teams/workspaces, customer-facing admin screens, and provider OAuth only
when a real customer requires them. The owner manages deployment, logs, and
environment in Render's web UI.

Signing in with a Claude/Codex-associated identity does **not** authorize a
web service to read local histories. The right UX is: sign in → pair this
machine → run the collector once. The collector already watches local Claude
and Codex transcript directories and can discover existing local JSONL files;
cloud-only sessions remain out of scope unless their provider exposes a
separate, consented export/API integration.

## 11. Current collector safety and progress work (July 18, 2026)

- Latest source commits: `1c742af` adds the central import-progress card;
  `01ee3c3`/`f146860` add the local-AI budget; `e4ac375`/`69f1809` change
  history processing to wait for the next budget window instead of marking
  remaining history as skipped. Collector release `v0.1.3` is published.
- Local translation is shared by **both Claude Code and Codex transcripts**
  and every supported collector binary (macOS/Linux × amd64/arm64). The
  release workflow now runs `go test ./...` before building all four targets.
- The local budget is persisted at `~/.local/state/unjargond/ai-budget.json`:
  no more than 30 local AI subprocesses, each killed after 30 seconds, in a
  rolling five-hour window (15 minutes / 5% runtime). It also covers digest
  work. This controls executable time, not a provider-reported token meter.
### Truthful import status and ETA (implemented July 18, 2026)

The persisted, globally chronological work queue is **Postgres itself**:
untranslated messages (`translated_at IS NULL`), ordered by message time
across every session and device a user owns. This satisfies the retention
requirements strictly better than a collector-side file — `total`,
`completed`, and rate survive collector *and* server restarts; the
budget-reset time survives restarts in `~/.local/state/unjargond/ai-budget.json`.

- Collectors always ship raw immediately. An exhausted budget no longer
  sleeps inside `Complete()` (which used to stall tailing for up to 5 hours);
  it returns `ErrBudgetWait` and the message ships untranslated.
- A no-key server leaves non-trivial messages **queued**, never marks them
  skipped (`web/src/lib/translate.ts`); collectors claim them oldest-first via
  `GET/POST /api/work/translate` (5-min claim reaping, mirrors digest work)
  and run them within the same budget. Nothing is permanently skipped.
- `POST /api/status` (paired-device auth) stores per-device budget state
  (`devices.import_status`: used/limit/paused-until). Migration:
  `drizzle/0004_translate_queue.sql`.
- `/api/bootstrap` returns `progress.{messages, translated, ratePerHour,
  pausedUntil}`. `ratePerHour` counts translations finished in the last hour
  (from `translated_at`) — **never inferred from upload recency**.
- The `/live` card shows `completed / total`, a real progress bar, the
  budget-pause resume time, and an ETA computed only from the measured rate;
  it stays visible until the queue is empty. Raw history is browsable
  immediately throughout.
- Because unjargon spends the **user's own AI credentials**, budget usage is
  always on screen: a persistent `AI used/limit` header chip (per-device
  breakdown in the tooltip, amber when ≥80% or resting) plus an
  "AI calls used (your credentials)" line in the import card.

Verified end-to-end locally: no-key server queues → chronological claim
(oldest `ts` first across sessions) → daemon work loop translates with a stub
CLI, delivers, reports status → bootstrap and the `/live` card show 5/7 with
paused-until + ETA. `go test ./...`, `tsc --noEmit`, and eslint pass.

### Shared jargon knowledge base (July 18, 2026)

The single backend's glossary is a cross-user knowledge base that saves AI
credit: `terms` rows (generic L1/L2) are global, so one user's extraction
spend teaches everyone.

- **Zero-AI matching at ingest** (`web/src/lib/glossary.ts`): every ingested
  message is matched against the shared glossary (SQL `position()` +
  word-boundary check); sightings are recorded immediately, so known terms
  appear on a user's board before any translation — even budget-paused or
  with no AI CLI. A unique index on `term_sightings(term_id, message_id)`
  (`drizzle/0005_shared_glossary.sql`) keeps this and the translation path
  from double-counting.
- Server translation prompts now list exactly the known terms present in the
  message (was: first 80 globally) — dedupe stays correct as the glossary
  grows. L2 expansions were already shared (cached on the term row); L1 is
  first-seen-wins, so later re-extractions never overwrite.
- **Term cards default to the shared basic explanation only** (L1 + L2 —
  generic, cached once globally, no per-user AI spend). The in-context L3
  requires querying the user's own stream with AI, so it is strictly opt-in:
  an "explain in my sessions · 1 AI call" button sends
  `POST /api/terms/:id/expand {level:"grounding"}`; a cached L3 returns
  free. The response carries `l3Available` (false on a no-key server, which
  also cannot generate L2 — routing expansions through the collector work
  queue is the noted next step for no-key deployments).
- **Privacy boundary (enforced, not prompt-only —
  `drizzle/0006_private_keywords.sql`):** only generic vocabulary
  ("term"/"initial" kinds, `terms.user_id NULL`) is shared. "keyword" terms
  (file names, commands, internal artifact names) carry `terms.user_id` and
  are per-user rows: never matched, listed, or expanded for anyone else, and
  the same string produces separate rows per owner (unique index
  `terms_owner_key` on `COALESCE(user_id,0), key`). The unauthenticated
  `GET /api/prompt` template bakes in shared vocabulary only. L2 generation
  is a separate snippet-free call (`conceptTool`) so no transcript content
  can reach the shared row; L3 keeps the user's own source snippet and is
  cached per-user (`user_terms`), with `expandTerm` and the learned route
  returning 404 for another user's keyword. Sightings/sessions remain
  owner-filtered. Further mechanical guards (July 18): artifact-shaped
  strings (paths, files, dotted modules) are forced to kind "keyword"
  regardless of the model's label; a would-be-shared term whose L1/domain
  mentions the project name or a slash path is demoted to a user-owned row
  (`looksProjectSpecific` in translate.ts); the translation prompts state
  that L1/domain are shown to other users and must stay generic;
  `drizzle/0007_leak_cleanup.sql` scrubs any pre-0006 cross-user sightings,
  user_terms rows, and annotation refs tied to now-private terms.
- Verified: user B ingested a raw message mentioning terms user A had paid
  for — B's board showed them with A's L1s at zero AI spend; a later
  translation re-emitting the term neither duplicated the sighting nor
  overwrote the L1.

Deliberate ceiling: the collector does not pre-count assistant messages
before shipping — raw shipping has no AI cost, so the server total stabilizes
within minutes of install and stays truthful; add a local pre-inventory only
if that brief ramp-up proves confusing. Claiming is select-then-update, not
`FOR UPDATE SKIP LOCKED`: two devices polling in the same instant can waste
one budget call; add row locking when multi-device users appear.
