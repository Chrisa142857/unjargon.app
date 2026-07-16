import Anthropic from "@anthropic-ai/sdk";
import { desc, eq } from "drizzle-orm";
import { db, tables } from "@/db";
import {
  TRANSLATION_MODEL,
  expansionSystemPrompt,
  expansionTool,
  expansionUserPrompt,
} from "@/lib/prompts";

// Lazy L2/L3 generation for a term, cached on the terms row. L3 is grounded
// in a source message: the one the user tapped from when provided, else the
// term's most recent sighting.

const SNIPPET_MAX = 1200;

export async function expandTerm(
  termId: number,
  sourceMessageId?: number,
): Promise<{ l2: string; l3: string; cached: boolean } | null> {
  const [term] = await db
    .select()
    .from(tables.terms)
    .where(eq(tables.terms.id, termId));
  if (!term) return null;
  if (term.l2 && term.l3) {
    return { l2: term.l2, l3: term.l3, cached: true };
  }

  // Find the source message for grounding L3.
  let source: { text: string; sessionId: number } | null = null;
  if (sourceMessageId) {
    const [m] = await db
      .select({ text: tables.messages.text, sessionId: tables.messages.sessionId })
      .from(tables.messages)
      .where(eq(tables.messages.id, sourceMessageId));
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
      .where(eq(tables.termSightings.termId, termId))
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

  const result = await callExpander({
    term: term.term,
    domain: term.domain,
    l1: term.l1,
    projectName,
    snippet,
  });

  await db
    .update(tables.terms)
    .set({ l2: result.level2, l3: result.level3 })
    .where(eq(tables.terms.id, termId));

  return { l2: result.level2, l3: result.level3, cached: false };
}

async function callExpander(input: {
  term: string;
  domain: string;
  l1: string;
  projectName: string | null;
  snippet: string;
}): Promise<{ level2: string; level3: string }> {
  if (process.env.UNJARGON_FAKE_TRANSLATOR === "1") {
    return fakeExpand(input);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY not set (set it, or UNJARGON_FAKE_TRANSLATOR=1 for offline dev)",
    );
  }
  const client = new Anthropic();
  const resp = await client.messages.create({
    model: TRANSLATION_MODEL,
    max_tokens: 800,
    system: expansionSystemPrompt("new"),
    messages: [{ role: "user", content: expansionUserPrompt(input) }],
    tools: [expansionTool],
    tool_choice: { type: "tool", name: "emit_expansion" },
  });
  const block = resp.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new Error("no tool_use block in response");
  }
  const out = block.input as { level2?: string; level3?: string };
  if (!out.level2?.trim() || !out.level3?.trim()) {
    throw new Error("expansion missing level2/level3");
  }
  return { level2: out.level2.trim(), level3: out.level3.trim() };
}

// Offline fake (UNJARGON_FAKE_TRANSLATOR=1): hand-written expansions for the
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

function fakeExpand(input: {
  term: string;
  domain: string;
  l1: string;
  projectName: string | null;
  snippet: string;
}): { level2: string; level3: string } {
  console.warn("[expand] UNJARGON_FAKE_TRANSLATOR=1 — using offline fake, NOT the real model");
  const canned = FAKE_EXPANSIONS[input.term.toLowerCase()];
  if (canned) return canned;
  return {
    level2: `${input.l1} (Offline fake L2 — set ANTHROPIC_API_KEY for a real explanation of “${input.term}”.)`,
    level3: `The agent mentioned “${input.term}” while working on ${input.projectName ?? "your project"}: “${input.snippet.slice(0, 140)}…” (Offline fake L3.)`,
  };
}
