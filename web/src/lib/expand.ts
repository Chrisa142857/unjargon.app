import Anthropic from "@anthropic-ai/sdk";
import { and, asc, desc, eq, gt, isNotNull, isNull, lt, lte, or } from "drizzle-orm";
import { db, tables } from "@/db";
import {
  EXPLANATION_MODEL,
  conceptSystemPrompt,
  conceptTool,
  conceptUserPrompt,
  groundingSystemPrompt,
  groundingTool,
  groundingUserPrompt,
  localConceptPrompt,
  localGroundingPrompt,
  type CalibrationLevel,
} from "@/lib/prompts";
import { getUserCalibration } from "@/lib/settings";
import { serverCanLLM } from "@/lib/llm";
import { hasLiveLocalExpander } from "@/lib/local-expander";

// Lazy L2/L3 generation. Two separate calls — a privacy AND cost boundary:
// L2 (basic concept) is generic, generated without any transcript content,
// and cached on the shared terms row — one call ever, for everyone. L3
// ("in your session") must query the user's own stream with AI, so it is
// strictly OPT-IN: never generated unless the user explicitly asks
// (grounding: true); a card shows only the shared basic explanation by
// default.

const SNIPPET_MAX = 1200;
const CONFIRMATION_TTL_MS = 10 * 60_000;

export class LocalExplainerUnavailable extends Error {}
export class AIConfirmationRequired extends Error {}

async function localExpanderAvailable(userId: number) {
  const devices = await db
    .select({ importStatus: tables.devices.importStatus })
    .from(tables.devices)
    .where(eq(tables.devices.userId, userId));
  return hasLiveLocalExpander(devices.map((device) => device.importStatus));
}

export async function expandTerm(
  termId: number,
  userId: number,
  opts: { sourceMessageId?: number; action?: "concept" | "grounding"; confirmed?: boolean } = {},
): Promise<
  | {
      l2: string | null;
      l3: string | null;
      l3Available: boolean;
      pending: { concept: boolean; grounding: boolean };
    }
  | null
> {
  const [term] = await db
    .select()
    .from(tables.terms)
    .where(eq(tables.terms.id, termId));
  if (!term) return null;
  // Another user's private legacy row: not visible, not expandable.
  if (term.userId !== null && term.userId !== userId) return null;
  const [profile] = await db.select().from(tables.userTerms).where(and(eq(tables.userTerms.userId, userId), eq(tables.userTerms.termId, termId)));
  const pending = { concept: false, grounding: false };
  const server = serverCanLLM();
  const local = !server && await localExpanderAvailable(userId);

  let l2 = term.l2;
  if (!l2 && opts.action === "concept") {
    requireAIConfirmation(opts.confirmed);
    if (server) {
      l2 = await callConcept({
        term: term.term,
        domain: term.domain,
        l1: term.l1,
      });
      await db.update(tables.terms).set({ l2 }).where(eq(tables.terms.id, termId));
    } else {
      if (!local) throw new LocalExplainerUnavailable();
      await replaceUnconfirmedRequest(termId, userId, false);
      await db
        .insert(tables.expansionRequests)
        .values({ termId, userId, grounding: false, confirmedAt: new Date() })
        .onConflictDoNothing();
      pending.concept = true;
    }
  }

  // Cached L3 is free to return; generating one happens only on request.
  let l3 = profile?.l3 ?? null;
  if (!l3 && opts.action === "grounding") {
    requireAIConfirmation(opts.confirmed);
    if (server) {
      const src = await groundingSource(termId, userId, opts.sourceMessageId);
      l3 = await callGrounding(
        await getUserCalibration(userId),
        { term: term.term, domain: term.domain, l1: term.l1, ...src },
      );
      await db.insert(tables.userTerms).values({ userId, termId, l3 }).onConflictDoUpdate({ target: [tables.userTerms.userId, tables.userTerms.termId], set: { l3 } });
    } else {
      if (!local) throw new LocalExplainerUnavailable();
      await replaceUnconfirmedRequest(termId, userId, true);
      await db
        .insert(tables.expansionRequests)
        .values({ termId, userId, grounding: true, messageId: opts.sourceMessageId ?? null, confirmedAt: new Date() })
        .onConflictDoNothing();
    }
  }
  if (!l2 || !l3) {
    const requests = await db
      .select({ grounding: tables.expansionRequests.grounding })
      .from(tables.expansionRequests)
      .where(and(
        eq(tables.expansionRequests.termId, termId),
        eq(tables.expansionRequests.userId, userId),
        gt(tables.expansionRequests.confirmedAt, confirmationCutoff()),
      ));
    pending.concept = local && !l2 && requests.some((request) => !request.grounding);
    pending.grounding = local && !l3 && requests.some((request) => request.grounding);
  }

  return { l2, l3, l3Available: true, pending };
}

function requireAIConfirmation(confirmed: boolean | undefined) {
  if (!confirmed) throw new AIConfirmationRequired("AI confirmation required");
}

function confirmationCutoff() {
  return new Date(Date.now() - CONFIRMATION_TTL_MS);
}

// A pre-consent row from an older deployment conflicts with the unique key.
// Remove only rows that cannot be claimed, then insert a fresh confirmation.
async function replaceUnconfirmedRequest(termId: number, userId: number, grounding: boolean) {
  await db
    .delete(tables.expansionRequests)
    .where(and(
      eq(tables.expansionRequests.termId, termId),
      eq(tables.expansionRequests.userId, userId),
      eq(tables.expansionRequests.grounding, grounding),
      or(
        isNull(tables.expansionRequests.confirmedAt),
        lte(tables.expansionRequests.confirmedAt, confirmationCutoff()),
      ),
    ));
}

// The source message grounding L3 (must belong to this user): the one they
// tapped from when provided, else the term's most recent sighting.
async function groundingSource(
  termId: number,
  userId: number,
  sourceMessageId?: number,
): Promise<{ projectName: string | null; snippet: string }> {
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
  return {
    projectName,
    snippet: (source?.text ?? "(no source message recorded)").slice(0, SNIPPET_MAX),
  };
}

// --- collector expansion-work queue (no-key servers) -----------------------

const CLAIM_TTL_MS = 5 * 60_000;

export async function claimExpansionWork(
  userId: number,
): Promise<{ id: number; prompt: string } | null> {
  await db
    .update(tables.expansionRequests)
    .set({ claimedAt: null })
    .where(and(
      isNotNull(tables.expansionRequests.confirmedAt),
      lt(tables.expansionRequests.claimedAt, new Date(Date.now() - CLAIM_TTL_MS)),
    ));
  const [req] = await db
    .select()
    .from(tables.expansionRequests)
    .where(and(
      eq(tables.expansionRequests.userId, userId),
      isNull(tables.expansionRequests.claimedAt),
      gt(tables.expansionRequests.confirmedAt, confirmationCutoff()),
    ))
    .orderBy(asc(tables.expansionRequests.id))
    .limit(1);
  if (!req) return null;
  const claimed = await db
    .update(tables.expansionRequests)
    .set({ claimedAt: new Date() })
    .where(and(
      eq(tables.expansionRequests.id, req.id),
      isNull(tables.expansionRequests.claimedAt),
      gt(tables.expansionRequests.confirmedAt, confirmationCutoff()),
    ))
    .returning();
  if (!claimed[0]) return null; // raced with another of this user's devices
  const [term] = await db.select().from(tables.terms).where(eq(tables.terms.id, req.termId));
  if (!term) {
    await db.delete(tables.expansionRequests).where(eq(tables.expansionRequests.id, req.id));
    return null;
  }
  const base = { term: term.term, domain: term.domain, l1: term.l1 };
  if (!req.grounding) {
    return { id: req.id, prompt: localConceptPrompt(base) };
  }
  const level = await getUserCalibration(userId);
  const src = await groundingSource(req.termId, userId, req.messageId ?? undefined);
  return { id: req.id, prompt: localGroundingPrompt(level, { ...base, ...src }) };
}

export async function completeExpansionWork(
  id: number,
  userId: number,
  text: string,
): Promise<boolean> {
  const trimmed = text.trim().slice(0, 4000);
  if (!trimmed) return false;
  const [req] = await db
    .select()
    .from(tables.expansionRequests)
    .where(and(eq(tables.expansionRequests.id, id), eq(tables.expansionRequests.userId, userId)));
  if (!req) return false;
  if (req.grounding) {
    await db
      .insert(tables.userTerms)
      .values({ userId, termId: req.termId, l3: trimmed })
      .onConflictDoUpdate({ target: [tables.userTerms.userId, tables.userTerms.termId], set: { l3: trimmed } });
  } else {
    // First completion wins; the shared L2 is never overwritten.
    await db
      .update(tables.terms)
      .set({ l2: trimmed })
      .where(and(eq(tables.terms.id, req.termId), isNull(tables.terms.l2)));
  }
  await db.delete(tables.expansionRequests).where(eq(tables.expansionRequests.id, req.id));
  return true;
}

function requireLLM() {
  if (process.env.UNJARGON_ALLOW_SERVER_AI !== "1" || !process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "server AI disabled (set UNJARGON_ALLOW_SERVER_AI=1 and ANTHROPIC_API_KEY, or UNJARGON_FAKE_TRANSLATOR=1 for offline dev)",
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
      `${input.l1} (Offline fake L2 — explicitly enable server AI for a real explanation of “${input.term}”.)`
    );
  }
  requireLLM();
  const client = new Anthropic();
  const resp = await client.messages.create({
    model: EXPLANATION_MODEL,
    max_tokens: 500,
    system: conceptSystemPrompt(),
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
async function callGrounding(level: CalibrationLevel, input: {
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
    model: EXPLANATION_MODEL,
    max_tokens: 500,
    system: groundingSystemPrompt(level),
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
