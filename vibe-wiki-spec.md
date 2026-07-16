# vibe-wiki.app — Prototype Spec v2
### The learning layer for agents running anywhere
Target users: vibe coders & vibe researchers · Hackathon category: Work & Productivity
Supersedes `prototype-spec.md` (Mac-native v1). Product concept, UX layers, and extraction design carry over; deployment architecture is new.

---

## 1. What Changed and Why

Agents don't just run on your laptop. Vibe researchers run Claude Code / Codex on **HPC clusters, remote workstations, and SSH sessions across multiple OSes**. A Mac-only overlay can't see any of that.

New shape:

- **Collector (service-side, OS-specific):** a tiny Go binary running as a user-level service on every machine where agents run — macOS laptop, Linux HPC login node, remote box. It tails agent transcripts and posts new messages to vibe-wiki.app.
- **Web app (user-side, OS-agnostic):** vibe-wiki.app — one live dashboard in any browser, on any OS, aggregating every session from every machine. Extraction, glossary, and the click-to-learn UI all live here.

```
  Mac laptop ──┐
  (collector)  │
               ├──HTTPS──►  vibe-wiki.app  ──SSE──►  any browser, any OS
  HPC node ────┤            (Next.js + Postgres,
  (collector)  │             LLM extraction)
  remote box ──┘
  (collector)
```

One user, N machines, one wiki.

---

## 2. Collector — Go single binary (`vibewiki-agentd`)

**Why Go:** one static binary per platform (darwin/linux × amd64/arm64), zero runtime dependencies — critical on HPC nodes where you can't install anything and don't have root.

**What it does:**

1. Watches `~/.claude/projects/**/*.jsonl` (Claude Code) and `~/.codex/sessions/**/*.jsonl` (Codex). Append-only JSONL; per-file byte offsets, consume only complete new lines (fsnotify + polling fallback for network filesystems — see HPC notes).
2. Parses defensively: extract assistant-role text blocks only, ignore unknown fields (format is internal to CC and version-drifts). Parser-per-tool behind an interface; Codex parser is a drop-in.
3. Posts batches to the web app:

```
POST /api/ingest        Authorization: Bearer <device-token>
{
  "device": "hpc-login-03",
  "tool": "claude-code",
  "session_id": "…",
  "cwd": "/home/wei/projects/sim-pipeline",
  "messages": [ { "ts": "…", "text": "…" } ]
}
```

4. Buffers to local disk when offline (HPC networks flake); retries with backoff. Redaction pass before send (strip obvious secrets: key-like strings, `.env` contents).

**Install & run (user-level, no root anywhere):**

| OS | Mechanism |
|---|---|
| macOS | `launchd` LaunchAgent (`~/Library/LaunchAgents/app.vibewiki.agentd.plist`) |
| Linux (systemd available) | `systemd --user` unit (`~/.config/systemd/user/vibewiki-agentd.service`) |
| Linux (HPC, no systemd user session) | plain background process: `vibewiki-agentd start &` in `.bashrc`/tmux; PID-file so double-starts are no-ops |

One-line install, printed by the web app with the device token baked in:

```
curl -fsSL https://vibe-wiki.app/install.sh | sh -s -- --token vw_xxx
```

Script detects OS/arch, drops the binary in `~/.local/bin`, registers the right service flavor.

**Transcript availability guarantee:**

- CC writes transcripts continuously on whatever machine the `claude` process runs — interactive, headless (`-p`), and Remote Control sessions alike (Remote Control only steers a local session from a browser/phone; execution and transcripts stay on the host).
- **Primary discovery: hooks, not path guessing.** The installer registers a `SessionStart` hook in `~/.claude/settings.json`; every CC hook receives `transcript_path` in its JSON input, so CC itself notifies the collector (localhost ping) of the exact file to tail on every session start. Robust to `CLAUDE_CONFIG_DIR` relocation and future path changes.
- Directory watching of `~/.claude/projects/**` remains as fallback (sessions started before collector install).
- Known gap: Claude Code on the web (cloud-hosted sandbox) runs on Anthropic infra — no local transcript. Out of MVP scope.

**HPC notes (the differentiating detail):**

- Home dirs are often NFS/Lustre → inotify/FSEvents unreliable → collector falls back to 2s mtime polling automatically.
- Login node vs compute node: agents typically run on login/dev nodes where the collector lives; if agents run inside batch jobs, the collector on the shared filesystem still sees the transcripts (same `$HOME`). One collector per host is fine because offsets are tracked per file.
- Outbound HTTPS is normally allowed from login nodes; buffered retry covers proxy-only environments.

---

## 3. Web App — vibe-wiki.app (Next.js + Postgres)

### Pages

**`/live` — the overlay, reborn as a dashboard.** Same UX as v1's panel, now with a device/session switcher:

```
┌ vibe-wiki ─────────────────────────────────────────────┐
│ ● hpc-login-03 · claude — sim-pipeline    [3 sessions ▾]│
│                                                         │
│ ▾ Numerical Methods                          (2 new)    │
│   [Runge-Kutta] [stiff ODE]                             │
│ ▾ HPC                                                   │
│   [MPI rank] [scratch space] [SLURM array]              │
│ ▾ Statistics                                            │
│   [bootstrap CI] [p-hacking]                            │
│                                                         │
│ 42 terms today · quiz me ⚡                              │
└─────────────────────────────────────────────────────────┘
```

Live via SSE (`/api/stream`) — simpler than WebSockets, survives proxies. Click a chip → the same three layers as v1: **L1** one-liner (eager) → **L2** basic concept (lazy) → **L3** "why the agent is using it in *your* session," grounded in the source message (lazy, cached).

**`/wiki` — the personal wiki (name earns itself).** Every term ever extracted, across all machines and sessions: searchable, grouped by domain, learned/unlearned state, "seen in 4 sessions on 2 machines," links back to source messages. This is the durable asset: your delegation history becomes your curriculum.

**`/devices`** — connected collectors, last-seen, install command generator with fresh token.

### Backend

- `POST /api/ingest` → validate token → store message → enqueue extraction.
- Extraction worker: debounce ~2s per session, then one Haiku call with strict JSON output — same prompt design as v1 (only non-expert terms, reuse existing domain labels, salience score, never invent terms, dedupe against session's known list). Cap ~6 new terms/message.
- `GET /api/stream` → SSE fan-out of new terms to the session's viewers.
- L2/L3 generated on first click (`POST /api/terms/:id/expand`), cached.
- Postgres schema: `users`, `devices(token)`, `sessions`, `messages`, `terms(term, domain, l1, l2, l3, salience, learned_at)`, `term_sightings(term_id, message_id)`.
- Auth: magic-link or GitHub OAuth for the web; bearer device-tokens for collectors.
- Deploy: Vercel (app) + Neon/Supabase Postgres, or a single Railway service. Hackathon-trivial.

Cost unchanged: ~100 debounced Haiku calls per heavy session ≈ cents. Server-side keys — collectors never hold LLM credentials.

---

## 4. MVP Scope (hackathon cut lines)

**Must ship:**

1. Go collector for Linux + macOS, Claude Code parser, offline buffer, one-line installer.
2. Ingest → extraction → live chips on `/live` via SSE.
3. L1/L2/L3 term cards, L3 grounded in the source message.
4. Two-device demo: Mac laptop + one Linux box (a cloud VM playing "HPC node" is fine).

**Nice to have:** Codex parser · `/wiki` cross-session view · quiz mode · redaction toggle.

**Explicitly out:** approval/control of agents (gotoHuman's turf) · dev traces (LangSmith's turf) · Windows collector · team/multi-user sharing.

---

## 5. Demo Script (3 min)

1. **Hook (30s):** "My research agent is running on the university cluster over SSH. It just said it's 'switching to an implicit solver because the ODE system is stiff.' I'm a biologist. Should I be worried?"
2. **Live (goal: the two-machine moment, 100s):** Terminal 1: CC session on the laptop. Terminal 2: SSH into Linux VM, CC running there. One browser tab shows **both** feeding the same live wiki. Click `stiff ODE` → L1 → L3: "your simulation in `sim-pipeline` has fast and slow timescales; explicit solvers would need tiny steps — the agent chose implicit to run 100× faster." Audience sees a non-expert become able to judge the agent's decision.
3. **Close (50s):** `/wiki` view — "everything my agents taught me this week, from two machines." Positioning line: *Claude Code's learning mode slows your agent down and only works where it runs. vibe-wiki is decoupled — full-speed agents anywhere, learning everywhere.*

---

## 6. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Transcript format drift (CC internal format) | Defensive parsing (role + text only); parser isolated per tool; integration test against recorded fixtures |
| inotify silent failure on NFS/Lustre | Automatic polling fallback; poll is default when fs type is networked |
| Transcripts contain secrets, now leaving the machine | Client-side redaction pass; document clearly; self-host option as roadmap answer |
| Extraction noise | Salience threshold, dedupe list, 6-term cap (carried from v1) |
| Two-machine live demo fragility | Pre-recorded session JSONL replayable via `vibewiki-agentd replay fixture.jsonl` — same pipeline, deterministic demo fallback |
| Multiple sessions per device | Sessions are first-class (session_id from filename); UI picker, most-recent default |

---

## 7. Positioning Recap

- **vs Claude Code Learning/Explanatory modes:** built into one tool, changes agent behavior, teaches only where the agent runs. vibe-wiki: decoupled, full-speed, cross-tool (CC + Codex), cross-machine, any domain.
- **vs LangSmith/Langfuse:** traces for engineers debugging agents. vibe-wiki: understanding for the human who delegated.
- **vs gotoHuman:** an approve button without comprehension. vibe-wiki builds the comprehension.
- **New angle the pivot unlocks:** *nobody* serves the remote/HPC agent user — observability-for-humans that follows your agents across every machine you run them on.
