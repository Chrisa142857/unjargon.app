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
- **Installer:** `install.sh` is served from GitHub raw content, asks for the
  ingest credential through `/dev/tty` (so it is not embedded in the webpage
  or shell command), and downloads binaries from GitHub Releases:

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

## 9. Critical product gap: this is not yet multi-user

The deployed service is **one shared prototype**, not a tenant-safe hosted
product:

- No email/login/session auth exists in the application.
- `/api/ingest` authenticates every collector using one global Render
  `INGEST_TOKEN`.
- Devices, sessions, messages, terms, and settings have no `user_id` or
  `workspace_id`; the current API therefore combines data across all users.
- Render's dashboard is only for the owner's infrastructure administration;
  it must not be the customer/admin interface for the application.

**Never expose the Render `INGEST_TOKEN` in browser code or copy-paste UI.**
It is only an interim owner/demo credential. Do not onboard unrelated users
with it.

## 10. Recommended next milestone: hosted multi-user service

Make the single Render backend a proper multi-tenant service before public
onboarding:

1. Add email magic-link/passkey authentication (an identity provider is fine),
   plus `users`, `workspaces`, and `memberships` with an application-level
   `admin` role.
2. Add `workspace_id` to devices, sessions, messages, digests, annotations,
   terms/sightings, and settings. Scope and authorize every API read/write by
   workspace.
3. Replace the global ingest secret with a short-lived browser-to-device
   pairing code and a per-device hashed, revocable credential. The installer
   should exchange the pairing code locally; users never see a Render secret.
4. Keep raw transcripts, subtitles, project paths, session-specific L3
   explanations, and sightings private to a workspace. A global glossary cache
   may reuse only generic canonical L1/L2 definitions; never reuse source text
   or "why this matters in this project" context across users.
5. Use managed external Postgres before relying on the service for user data;
   the bundled Render Postgres path is ephemeral.

Signing in with a Claude/Codex-associated identity does **not** authorize a
web service to read local histories. The right UX is: sign in → pair this
machine → run the collector once. The collector already watches local Claude
and Codex transcript directories and can discover existing local JSONL files;
cloud-only sessions remain out of scope unless their provider exposes a
separate, consented export/API integration.
