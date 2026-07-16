# Motivation & Landscape Research
### Learn While Agents Work — Hackathon Category: Work & Productivity

---

## 1. The Problem

AI agents increasingly do jobs that fall **outside the user's own knowledge base** — nobody knows everything. This creates a growing asymmetry:

> The agent knows more about the task than the person delegating it. The user cannot judge the progress, cannot evaluate the outcome, and cannot tell a good result from a plausible-looking bad one.

Research on human-AI trust calibration confirms this is a real, measured problem: lay users systematically **over-rely or under-rely** on AI output, and verifying output outside one's expertise is "cognitively and temporally demanding" ([arXiv: Trust Calibration in XAI](https://arxiv.org/pdf/2605.18036), [Alignment Debt](https://arxiv.org/pdf/2511.09663)).

**Our idea:** a companion layer that teaches the user the relevant knowledge *while* the agent works — so their judgment grows alongside the agent's output.

---

## 2. Existing Products (verified against primary sources)

### 2.1 Agent observability — built for developers, not understanding

| Product | What it actually does (from product pages) |
|---|---|
| [LangSmith Observability](https://www.langchain.com/langsmith/observability) | "See exactly what your agent is doing step by step. Pinpoint the issues hurting latency, cost, and response quality." Traces, monitoring dashboards, cost tracking, LLM-as-judge evals. |
| [Langfuse](https://langfuse.com/blog/2024-07-ai-agent-observability-with-langfuse) | Captures every agent step (LLM calls, tool invocations, retrievals) as structured traces for inspection and evaluation. |
| [AgentOps](https://aimultiple.com/agentic-monitoring) | Multi-agent tracking of collaboration and behavior. |

**Verdict:** these show *what* the agent did, in raw engineering terms (traces, tokens, latency). They assume the viewer already has the expertise to interpret it. No teaching, no plain-language explanation for the domain non-expert.

### 2.2 Human-in-the-loop approval layers — control without comprehension

| Product | What it actually does |
|---|---|
| [gotoHuman](https://www.gotohuman.com/) | "Custom human reviews to approve and edit any agent action." Review templates, Agent Inbox, Slack/email notifications, retry loops. Used by Deloitte, Carrefour, Air NZ. |
| [Velt / agno HITL guides](https://velt.dev/blog/why-ai-agents-need-approval-layer) | Approval checkpoints for critical agent actions. |

**Verdict:** these give users a *pause button and an approve button* — but do nothing to ensure the user understands what they're approving. The knowledge gap remains; approval becomes rubber-stamping.

**Correction from verification:** [HumanLayer](https://www.humanlayer.dev/) (YC), originally a human-in-the-loop approval SDK, has **pivoted** into an AI coding IDE / "software factory." Notably, its new tagline is *"Do not outsource the thinking"* — structured checkpoints (Questions → Research → Design → Structure → Plan → Implement) so engineers stay aligned with the agent. This validates the problem we're targeting, but their solution is workflow checkpoints **for professional engineers**, not knowledge-building for non-experts.

### 2.3 Learning modes bolted onto AI tools — closest in spirit, narrowest in scope

| Product | What it actually does |
|---|---|
| [Claude Code Explanatory & Learning styles](https://www.engadget.com/ai/anthropic-brings-claudes-learning-mode-to-regular-users-and-devs-170018471.html) (Anthropic, Aug 2025) | Explanatory: Claude narrates architecture decisions and tradeoffs like a senior dev mentoring a junior. Learning: Claude leaves `#TODO` gaps for the human to fill in. |
| ChatGPT Study Mode / [Claude learning mode](https://www.tomsguide.com/ai/claudes-new-learning-modes-take-on-chatgpts-study-mode-heres-what-they-do) | Socratic guidance instead of direct answers. |
| Cursor Ask Mode ([docs](https://cursor.com/docs)) | Q&A that explains code, errors, and concepts without making changes. |
| [Replit Learn](https://learn.replit.com/) | Courses teaching AI-assisted building; community-built [agent skill](https://replit.discourse.group/t/built-an-agent-skill-that-makes-replit-agent-help-you-learn-not-just-produce-code/10572) to "help you learn, not just produce code." |

**Verdict:** the strongest evidence that "teach while the AI works" resonates — Anthropic and OpenAI both shipped it. But every instance is (a) **confined to coding or study**, (b) a mode *of the same agent* rather than an independent layer, and (c) it slows the agent down (trade-off between doing and teaching baked into one model).

### 2.4 Standalone AI learning tools — teaching disconnected from doing

[Luminary](https://www.useluminary.ai/blog/best-ai-learning-tools), [YouLearn](https://www.youlearn.ai/), [Turbo AI](https://www.turbo.ai/) turn content into layered explanations, quizzes, and notes. **Verdict:** learning happens in a separate session, detached from any real delegated task. No connection to an agent's live work.

### 2.5 Enterprise XAI / transparency suites — compliance, not comprehension

[Fiddler AI, SuperAGI Transparency Suite](https://superagi.com/top-10-tools-for-achieving-ai-transparency-and-explainability-in-enterprise-settings/), [IBM XAI](https://www.ibm.com/think/topics/explainable-ai) target model governance, audit trails, and regulatory needs (EU AI Act, NIST AI RMF). Audience: risk and security teams — not the end user delegating a task.

---

## 3. The Gap

```
                     shows agent activity   teaches the user   for non-experts   during live work
Observability             ✓                       ✗                  ✗                 ✓
Approval layers           ~ (checkpoints)         ✗                  ~                 ✓
Learning modes (coding)   ✓                       ✓                  ✗ (devs)          ✓
Learning tools            ✗                       ✓                  ✓                 ✗
Enterprise XAI            ✓                       ✗                  ✗ (auditors)      ~
────────────────────────────────────────────────────────────────────────────────────────
Our product               ✓                       ✓                  ✓                 ✓
```

Every existing product picks at most three. Nobody delivers **just-in-time domain teaching, layered to the user's level, synchronized with an agent's in-flight work, for people outside the domain**.

---

## 4. Positioning

**One-liner:** *Observability for humans, not engineers.*

While an agent works on a task outside your expertise, a parallel learning layer explains the domain concepts behind each step — so by the time the agent finishes, you're equipped to judge, challenge, and trust the result. Delegation stops being a black box and becomes a learning loop.

**Why now:**

1. Agents are moving from coding (expert users) to everyday work (non-expert users) — the judgment gap is widening fast.
2. Anthropic and OpenAI shipping learning modes proves demand; both stopped at coding/study contexts.
3. HumanLayer's pivot to "do not outsource the thinking" shows the market recognizes comprehension — not just approval — is the bottleneck for trusting agents.

---

*Sources verified July 15, 2026 by fetching product pages directly: langchain.com/langsmith/observability, humanlayer.dev, gotohuman.com, learn.replit.com; learning-mode claims cross-checked against Engadget and Anthropic coverage.*
