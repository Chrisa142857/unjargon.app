# unjargon.app — Prototype Spec v3
### Subtitles for your agents, anywhere they run
Target users: vibe coders & vibe researchers · Hackathon category: Work & Productivity
Supersedes `vibe-wiki-spec.md` (v2). Architecture (Go collector + Next.js web app) carries over unchanged; this version renames the product and re-centers the feature hierarchy around **unjargoning** as the killer feature.

> Historical planning document. The shipping app uses zero-AI public
> Wikipedia/Google references instead of the generic L2 AI layer described
> below; only a user-confirmed in-session explanation can call AI.

---

## 1. Feature Hierarchy (what changed from v2)

**v2 led with knowledge chips; v3 leads with the unjargoned content itself.**

1. **KILLER: the Unjargon Stream.** Agents love initials and jargon; users don't know them *in context*. The primary surface is a live, auto-scrolling feed where every agent message arrives already translated: 1-3 plain-language sentences — *what it's doing, why it matters*. Subtitles for your agent.
2. **KILLER (depth control): the Annotated Original.** Every subtitle expands to the agent's verbatim text with jargon highlighted inline; tap a highlight for the plain-language rewrite of that sentence. Fidelity when you want it, zero reading burden when you don't.
3. **Secondary: domain knowledge chips** (v1/v2's L1/L2/L3 cards) — the "go deeper" layer behind each highlighted term.
4. **Secondary: `/wiki`** — the durable cross-session glossary.

The convenience insight: **the user should never have to ask.** v2 made the user click a chip to get understanding; v3 delivers understanding by default and makes depth optional. Reading the stream costs nothing; everything else is one tap deeper.

---

## 2. The Unjargon Stream — UX spec

```
┌ unjargon ──────────────────────────────────────────────────┐
│ ● hpc-login-03 · claude — sim-pipeline       [sessions ▾]  │
│                                                            │
│ 14:02  Checking your simulation code for the part          │
│        that advances time. ▸                               │
│                                                            │
│ 14:03  Your system mixes very fast and very slow           │
│        changes ("stiff"), so it's switching to a           │
│        solver that stays stable with big time steps.       │
│        It'll rerun the tests to confirm. ▸                 │
│        ┌─ original ─────────────────────────────────┐     │
│        │ The [ODE system] is [stiff], so I'll swap  │     │
│        │ the explicit [RK4] integrator for [BDF]    │     │
│        │ via [scipy.solve_ivp], then re-run the     │     │
│        │ [regression tests].                        │     │
│        └────────────────────────────────────────────┘     │
│                                                            │
│ 14:05  Done — all 12 tests pass, and the run is            │
│        about 40× faster. ▸                                 │
│                                                            │
│ [Numerical Methods · 4] [HPC · 3] [Testing · 2]   quiz ⚡  │
└────────────────────────────────────────────────────────────┘
```

Interaction rules:

- **Default view = subtitles only.** Auto-scroll pinned to newest (pause on hover/scroll-up, like a chat app).
- **▸ expands the annotated original** inline under its subtitle. `[highlighted]` terms tap to a sentence-level rewrite, tap again for the full L1/L2/L3 term card.
- **Global toggle** (`⌘/ctrl-J`): flip the whole stream between subtitles / originals for users who grow past needing translation — the app should make itself progressively unnecessary.
- **Calibration slider** (settings, three stops): *explain like I'm new / technical amateur / expert* — feeds the rewrite prompt; stored per user, refined per domain later.
- **Second-screen first.** The stream is designed for a browser tab or a phone next to the terminal: large type, no chrome, dark mode. This answers "most convenient way" for the HPC user: terminal on the laptop, unjargon on the phone.
- Chips demoted to a footer strip; `/wiki` unchanged from v2.

---

## 3. Pipeline change — one call does everything

v2 called the LLM to extract terms. v3 makes **one Haiku call per debounced agent message** return all three artifacts at once (no extra cost or latency vs v2):

```json
{
  "subtitle": "Your system mixes very fast and very slow changes, so it's switching to a solver that stays stable with big steps.",
  "annotations": [
    { "span": "stiff", "sentence_rewrite": "…", "term_ref": "stiff ODE" },
    { "span": "BDF",   "sentence_rewrite": "…", "term_ref": "BDF" }
  ],
  "terms": [
    { "term": "stiff ODE", "domain": "Numerical Methods", "level1": "…", "salience": 0.9 }
  ]
}
```

Prompt core (additions to v2's extraction rules): *rewrite for the user's calibration level; keep subtitle ≤ 3 sentences; preserve concrete outcomes (numbers, pass/fail, file names) verbatim; never editorialize or soften warnings/errors — if the agent says something failed, the subtitle says it failed.* That last rule is a trust requirement: the translation layer must never become a spin layer.

Skip-list: trivial messages (one-line acks, pure tool chatter) get passed through untranslated — a subtitle stream that rephrases "OK, done" is noise.

Everything else from v2 stands: SSE fan-out, lazy L2/L3, Postgres schema (add `messages.subtitle`, `annotations` table), server-side keys.

---

## 4. Architecture (unchanged from v2, renamed)

- Collector: `unjargond` — Go static binary; launchd (macOS) / systemd --user or tmux fallback (Linux/HPC); SessionStart-hook transcript discovery + directory-watch fallback; NFS polling fallback; offline buffer; redaction. Install: `curl -fsSL https://unjargon.app/install.sh | sh -s -- --token uj_xxx`
- Web: Next.js + Postgres. Pages: `/live` (the Stream), `/wiki`, `/devices`.
- Full detail: see v2 §2–3; only names and the ingest→render pipeline (§3 above) changed.

---

## 5. MVP Scope (revised cut lines)

**Must ship:**

1. Go collector (Linux + macOS), CC parser, hook-based discovery, offline buffer, one-line installer.
2. **The Unjargon Stream**: ingest → single-call translate+annotate+extract → live subtitles via SSE.
3. Annotated-original expansion with tappable highlights → term cards (L1 eager, L2/L3 lazy).
4. Two-device demo (Mac + Linux VM), phone as second screen.

**Nice to have:** calibration slider · global original⇄subtitle toggle · Codex parser · `/wiki` view · quiz mode.

**Explicitly out:** agent approval/control · dev traces · Windows collector · multi-user.

---

## 6. Demo Script (3 min, revised)

1. **Hook (30s):** Show a raw CC message on screen: *"The ODE system is stiff, so I'll swap the explicit RK4 integrator for BDF via solve_ivp."* — "My agent said this on the university cluster. I'm a biologist. Six words in, I'm lost. Agents love initials; users don't know them in context — even my AI assistant said 'MVP scope' to me this week and I had to ask."
2. **Live (100s):** Same task running; phone propped next to the laptop shows the Stream translating in real time: *"Your system mixes very fast and very slow changes…"* Then tap ▸ → annotated original → tap `stiff` → sentence rewrite → term card L3 grounded in *this* project. Second machine (Linux VM over SSH) feeds the same stream — one wiki, every machine.
3. **Close (50s):** `/wiki`: "Everything my agents taught me this week." Positioning line: *Claude Code's learning mode slows your agent and only works where it runs. unjargon is subtitles — full-speed agents anywhere, understanding everywhere.*

---

## 7. New Risks (delta from v2's table)

| Risk | Mitigation |
|---|---|
| Rewrite distorts meaning (worst case: hides an error) | "Never soften failures" prompt rule; outcomes/numbers copied verbatim; annotated original always one tap away |
| Subtitle latency breaks the "live" feel | Debounce 2s + Haiku ≈ subtitles land 3-4s behind the agent — acceptable for reading pace; stream shows a typing indicator while translating |
| Over-translation noise (rephrasing trivial messages) | Skip-list for acks/tool chatter; length threshold |
| Users outgrow subtitles and churn | That's the design: global toggle + calibration slider turn it into the annotation/wiki tool as users level up |

v2's risk table (format drift, NFS, secrets, demo fragility) still applies.
