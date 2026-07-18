import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq } from "drizzle-orm";
import { db, tables } from "@/db";
import {
  TRANSLATION_MODEL,
  conceptSystemPrompt,
  conceptTool,
  conceptUserPrompt,
  groundingSystemPrompt,
  groundingTool,
  groundingUserPrompt,
} from "@/lib/prompts";
import { getCalibration } from "@/lib/settings";
import { serverCanLLM } from "@/lib/digest";

// Lazy L2/L3 generation. Two separate calls — a privacy AND cost boundary:
// L2 (basic concept) is generic, generated without any transcript content,
// and cached on the shared terms row — one call ever, for everyone. L3
// ("in your session") must query the user's own stream with AI, so it is
// strictly OPT-IN: never generated unless the user explicitly asks
// (grounding: true); a card shows only the shared basic explanation by
// default.

const SNIPPET_MAX = 1200;

export async function expandTerm(
  termId: number,
  userId: number,
  opts: { sourceMessageId?: number; grounding?: boolean } = {},
): Promise<
  { l2: string | null; l3: string | null; l3Available: boolean } | null
> {
  const [term] = await db
    .select()
    .from(tables.terms)
    .where(eq(tables.terms.id, termId));
  if (!term) return null;
  // Another user's private keyword: not visible, not expandable.
  if (term.userId !== null && term.userId !== userId) return null;
  const [profile] = await db.select().from(tables.userTerms).where(and(eq(tables.userTerms.userId, userId), eq(tables.userTerms.termId, termId)));
  const l3Available = serverCanLLM();

  let l2 = term.l2;
  if (!l2 && serverCanLLM()) {
    l2 = await callConcept({ term: term.term, domain: term.domain, l1: term.l1 });
    await db.update(tables.terms).set({ l2 }).where(eq(tables.terms.id, termId));
  }

  // Cached L3 is free to return; generating one happens only on request.
  let l3 = profile?.l3 ?? null;
  if (!l3 && opts.grounding && serverCanLLM()) {
    const sourceMessageId = opts.sourceMessageId;
    // Find the source message for grounding L3 (must belong to this user).
    let source: { text: string; sessionId: number } | null = null;
    if (sourceMessageId) {
      const [m] = await db
        .select({ text: tables.messages.text, sessionId: tables.messages.sessionId })
        .from(tables.messages)
        .innerJoin(tables.sessions, eq(tables.messages.sessionId, tables.sessions.id))
        .innerJoin(tables.devices, eq(tables.sessions.deviceId, tables.devices.id))
        .where(and(eq(tables.messages.id, sourceMessageId), eq(tables.devices.userId, userId)));
      source = m ?? null;
    }
    if (!source) {
      const [sighting] = await db
        .select({ text: tables.messages.text, sessionId: tables.messages.sessionId })
        .from(tables.termSightings)
        .innerJoin(
          tables.messages,
          eq(tables.termSightings.messageId, tables.messages.id),
        )
        .innerJoin(tables.sessions, eq(tables.messages.sessionId, tables.sessions.id))
        .innerJoin(tables.devices, eq(tables.sessions.deviceId, tables.devices.id))
        .where(and(eq(tables.termSightings.termId, termId), eq(tables.devices.userId, userId)))
        .orderBy(desc(tables.termSightings.id))
        .limit(1);
      source = sighting ?? null;
    }

    let projectName: string | null = null;
    if (source) {
      const [session] = await db
        .select({ cwd: tables.sessions.cwd })
        .from(tables.sessions)
        .where(eq(tables.sessions.id, source.sessionId));
      projectName = session?.cwd?.split("/").filter(Boolean).pop() ?? null;
    }
    const snippet = (source?.text ?? "(no source message recorded)").slice(0, SNIPPET_MAX);

    l3 = await callGrounding({
      term: term.term,
      domain: term.domain,
      l1: term.l1,
      projectName,
      snippet,
    });
    await db.insert(tables.userTerms).values({ userId, termId, l3 }).onConflictDoUpdate({ target: [tables.userTerms.userId, tables.userTerms.termId], set: { l3 } });
  }

  return { l2, l3, l3Available };
}

function requireLLM() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY not set (set it, or UNJARGON_FAKE_TRANSLATOR=1 for offline dev)",
    );
  }
}

// L2: generic concept, shared row — NO transcript content in the call.
async function callConcept(input: {
  term: string;
  domain: string;
  l1: string;
}): Promise<string> {
  if (process.env.UNJARGON_FAKE_TRANSLATOR === "1") {
    console.warn("[expand] UNJARGON_FAKE_TRANSLATOR=1 — using offline fake, NOT the real model");
    return (
      FAKE_EXPANSIONS[input.term.toLowerCase()]?.level2 ??
      `${input.l1} (Offline fake L2 — set ANTHROPIC_API_KEY for a real explanation of “${input.term}”.)`
    );
  }
  requireLLM();
  const client = new Anthropic();
  const resp = await client.messages.create({
    model: TRANSLATION_MODEL,
    max_tokens: 500,
    system: conceptSystemPrompt(await getCalibration()),
    messages: [{ role: "user", content: conceptUserPrompt(input) }],
    tools: [conceptTool],
    tool_choice: { type: "tool", name: "emit_concept" },
  });
  const block = resp.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new Error("no tool_use block in concept response");
  }
  const level2 = (block.input as { level2?: string }).level2?.trim();
  if (!level2) throw new Error("concept missing level2");
  return level2;
}

// L3: grounded in the user's own source message, cached per-user only.
async function callGrounding(input: {
  term: string;
  domain: string;
  l1: string;
  projectName: string | null;
  snippet: string;
}): Promise<string> {
  if (process.env.UNJARGON_FAKE_TRANSLATOR === "1") {
    console.warn("[expand] UNJARGON_FAKE_TRANSLATOR=1 — using offline fake, NOT the real model");
    return (
      FAKE_EXPANSIONS[input.term.toLowerCase()]?.level3 ??
      `The agent mentioned “${input.term}” while working on ${input.projectName ?? "your project"}: “${input.snippet.slice(0, 140)}…” (Offline fake L3.)`
    );
  }
  requireLLM();
  const client = new Anthropic();
  const resp = await client.messages.create({
    model: TRANSLATION_MODEL,
    max_tokens: 500,
    system: groundingSystemPrompt(await getCalibration()),
    messages: [{ role: "user", content: groundingUserPrompt(input) }],
    tools: [groundingTool],
    tool_choice: { type: "tool", name: "emit_grounding" },
  });
  const block = resp.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new Error("no tool_use block in grounding response");
  }
  const level3 = (block.input as { level3?: string }).level3?.trim();
  if (!level3) throw new Error("grounding missing level3");
  return level3;
}

// Offline fakes (UNJARGON_FAKE_TRANSLATOR=1): hand-written expansions for the
// fixture's headline terms, template fallback otherwise. Loudly logged.
const FAKE_EXPANSIONS: Record<string, { level2: string; level3: string }> = {
  "stiff ode": {
    level2:
      "A stiff system is one where some things change in microseconds while others take hours — like filming a hummingbird and a glacier in the same shot. A normal solver must use the hummingbird's shutter speed for everything, so it crawls; if it tries bigger steps, the fast part explodes into nonsense. Solvers made for stiffness handle both timescales at once.",
    level3:
      "Your sim-pipeline reaction network couples fast binding kinetics with slow degradation — that spread is why runs took forever and sometimes produced NaNs. The agent switched to a stiff-capable solver (BDF) so the simulation stays stable with big time steps; the outcome message reports all 12 regression tests passing and the benchmark going from 127.4s to 3.1s.",
  },
  bdf: {
    level2:
      "BDF (backward differentiation formulas) is a family of solvers that decide each step by looking at where the system is heading, not just where it is — like steering a car by looking through the windshield instead of the rearview mirror. That makes each step more work, but the method stays stable even with large steps on hard problems.",
    level3:
      "The agent chose BDF via scipy.integrate.solve_ivp to replace RK4 in sim/solver.py because your system is stiff. It's the standard prescription: implicit and A-stable, so the NaN blowups stop and the run finishes about 40× faster (3.1s vs 127.4s).",
  },
};
