# Prototype Spec — "AgentLens" (working title)
### A macOS learning layer for Claude Code & Codex
Target users: vibe coders & vibe researchers · Hackathon category: Work & Productivity

---

## 1. Product in One Paragraph

A Mac menu bar app with a floating overlay panel. It silently watches Claude Code / Codex session transcripts on disk, extracts the jargon and keywords from each new agent message, groups them by domain, and renders them as clickable chips. Click a chip → a layered explanation (one-liner → basic concept → why the agent is using it here). By the time the agent finishes, the user understands enough to judge the result.

**Core loop:** agent works → jargon appears in overlay → user clicks & learns → user judges output with confidence.

---

## 2. Why Transcript Watching (capture decision)

Claude Code writes every session as an append-only JSONL file at `~/.claude/projects/<encoded-project-path>/<session-id>.jsonl` — one JSON object per line, new events appended as new lines ([format docs](https://claude-dev.tools/docs/jsonl-format), [Simon Willison's transcript tools](https://github.com/simonw/claude-code-transcripts)). Codex CLI similarly writes rollout JSONL files under `~/.codex/sessions/YYYY/MM/DD/`.

This gives us:

- **Zero setup** — no wrapper command, no terminal plugin, works with any terminal or IDE.
- **Clean structured text** — actual message objects, not ANSI-escaped screen scrape.
- **Real-time** — append-only files + FSEvents = new messages within milliseconds.

⚠️ Known risk: the JSONL entry format is internal and can change between CC versions. Mitigation: parse defensively (extract only `message.content` text blocks, ignore unknown fields), keep parsers per-tool behind a protocol.

---

## 3. UX Flow

### First run
1. Launch app → menu bar icon appears.
2. Onboarding asks for folder access to `~/.claude` and `~/.codex` (plain file access, no special permissions needed) + Anthropic/OpenAI API key for extraction.
3. App detects active sessions automatically; if multiple, most-recently-modified wins (session picker in menu).

### During an agent session
1. User works in CC/Codex as usual. Overlay panel floats on the right edge (always-on-top NSPanel, non-activating so it never steals focus).
2. Each new **assistant message** triggers extraction. New terms slide in as chips, grouped under domain headers, e.g.:

```
┌─ AgentLens ────────────────────────┐
│ ● watching: claude — my-webapp     │
│                                    │
│ ▾ Web Security          (3 new)    │
│   [CORS] [JWT] [middleware]        │
│ ▾ Databases                        │
│   [migration] [ORM] [N+1 query]    │
│ ▾ Statistics                       │
│   [p-value] [bootstrap]            │
│                                    │
│ 42 terms this session · quiz me ⚡ │
└────────────────────────────────────┘
```

3. Click a chip → detail card with **three layers** (progressive disclosure):
   - **L1 — one-liner:** "CORS: a browser rule controlling which websites may call your API."
   - **L2 — basic concept:** 3-4 sentences with an analogy, no assumed background.
   - **L3 — in your context:** "The agent added CORS headers because your frontend (localhost:3000) and API (localhost:8000) are different origins — without this, the browser blocks the requests." ← generated from the actual message the term appeared in.
4. Terms persist across the session (a growing glossary), deduped; a chip glows when it reappears.

### Design principles
- **Glanceable, never blocking.** The overlay never interrupts the agent or demands input.
- **Calm.** New terms accumulate quietly; no toasts, no sounds.
- **Learned state.** Once a user has opened a term, it dims. Unopened terms stay bright — a visual "here's what you don't know yet."

---

## 4. Architecture

```
┌─────────────────────────── macOS app (SwiftUI) ───────────────────────────┐
│                                                                           │
│  SessionWatcher                Extractor                 Overlay UI       │
│  ───────────────               ──────────                ───────────      │
│  FSEvents on                   Batches new agent         NSPanel          │
│  ~/.claude/projects/**  ──►    text → LLM call    ──►    (.nonactivating, │
│  ~/.codex/sessions/**          (Haiku / gpt-mini)        .floating)       │
│                                                          SwiftUI views    │
│  • tail JSONL (byte offset     • extraction prompt                        │
│    per file, read only         • JSON schema output      MenuBarExtra     │
│    appended lines)             • dedupe vs glossary      (session picker, │
│  • parser per tool             • on-click: L2/L3         pause, quiz)     │
│    (CCParser, CodexParser)       lazy generation                          │
│                                                                           │
│                       GlossaryStore (SQLite / SwiftData)                  │
│         terms, domains, layers, source-message refs, learned-state        │
└───────────────────────────────────────────────────────────────────────────┘
```

### Components

**SessionWatcher.** `FSEventStream` on the two root dirs. Per file, remember byte offset; on change, read only new bytes, split lines, JSON-decode. Filter to assistant-role text content. Emits `AgentMessage(text, tool, sessionID, cwd)`.

**Extractor.** On each new message (debounced ~2s so streaming chunks batch into one call):

- Model: Claude Haiku (cheap, fast) with strict JSON output.
- Input: the new agent text + list of already-known session terms (for dedupe) + the project dir name (context hint).
- Output schema:

```json
{
  "terms": [
    {
      "term": "CORS",
      "domain": "Web Security",
      "level1": "Browser rule controlling which sites may call your API.",
      "salience": 0.9
    }
  ]
}
```

- L1 is generated eagerly (it's tiny). L2/L3 generated lazily on first click, cached in GlossaryStore. L3 prompt includes the original agent message snippet.
- Extraction prompt core instructions: *extract only terms a non-expert wouldn't know; skip common words; assign a short domain label, reusing existing session domains when close; rate salience; never invent terms not present in the text.*

**Overlay UI.** `NSPanel` with `.nonactivatingPanel` + `.floating` level, pinned to screen edge, collapsible to a slim badge showing unread-term count. Detail card slides over the list. `MenuBarExtra` for settings/session switching.

**GlossaryStore.** SwiftData/SQLite. Enables: cross-session memory ("you've seen JWT in 4 projects"), dimming of learned terms, and the stretch quiz feature.

### Cost estimate
A heavy CC session ≈ 200 agent messages → ~100 debounced Haiku calls ≈ a few cents. Negligible.

---

## 5. MVP Scope (hackathon cut lines)

**Must ship (the demo):**

1. Watch Claude Code transcripts (CC only — add Codex parser if time allows; the protocol makes it a drop-in).
2. Live extraction → domain-grouped chips in floating overlay.
3. Click chip → L1/L2/L3 card, L3 grounded in the actual agent message.
4. Session glossary with learned/unlearned dimming.

**Nice to have:** Codex support · quiz-me mode (generate 3 questions from session glossary) · cross-session term memory · "explain this whole step" (paragraph-level, not just terms).

**Explicitly out (say so on the slide):** intercepting/approving agent actions (gotoHuman's territory) · developer traces (LangSmith's territory) · Windows/Linux.

---

## 6. Demo Script (3 min)

1. **Hook (30s):** "You asked Claude Code to fix your app. It says it's 'adding CORS middleware and rotating the JWT secret.' Do you approve? …You have no idea what that means. That's the problem."
2. **Live (90s):** Run a real CC task in one terminal. Overlay populates with domains + chips in real time. Click `CORS` → show L1 → L2 → L3 ("in *your* project…"). Click a stats term to show it works beyond code (vibe researcher angle).
3. **Close (60s):** Glossary view — "18 things you didn't know 3 minutes ago, and the agent never slowed down." Gap table from the motivation doc: observability for humans, not engineers.

---

## 7. Key Risks & Mitigations

| Risk | Mitigation |
|---|---|
| CC transcript format changes between versions | Defensive parsing; only rely on role + text content; parser isolated behind protocol |
| Extraction too noisy (chips for everything) | Salience threshold + "already known" dedupe list in prompt + cap ~6 new terms/message |
| Overlay steals focus / annoys | Non-activating panel, collapsible, no animation storms |
| Multiple concurrent sessions | Most-recently-modified file wins; manual picker in menu bar |
| Streaming partial lines in JSONL | Only consume complete lines; keep remainder buffer per file |

---

## 8. Positioning Recap (ties to motivation doc)

Claude Code's own Learning/Explanatory modes prove demand but change the agent's behavior and slow it down. AgentLens is **decoupled**: the agent runs at full speed in default mode; the learning happens in a parallel layer, works across CC *and* Codex, and covers any domain the agent touches — not just code. Observability for humans, not engineers.
