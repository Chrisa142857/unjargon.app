import Anthropic from "@anthropic-ai/sdk";
import { and, asc, desc, eq, gt, isNotNull, isNull, lt, lte, or } from "drizzle-orm";
import { db, tables } from "@/db";
import {
  EXPLANATION_MODEL,
  groundingSystemPrompt,
  groundingTool,
  groundingUserPrompt,
  localGroundingPrompt,
  type CalibrationLevel,
} from "@/lib/prompts";
import { getUserCalibration } from "@/lib/settings";
import { serverCanLLM } from "@/lib/llm";
import { hasLiveLocalExpander } from "@/lib/local-expander";

// Public references explain a term without AI. This module handles the one
// remaining AI path: an explanation grounded in the user's own session, only
// after that user explicitly confirms it.

const SNIPPET_MAX = 1200;
const CONFIRMATION_TTL_MS = 10 * 60_000;

export class LocalExplainerUnavailable extends Error {}
export class AIConfirmationRequired extends Error {}
export class TermNotInYourSessions extends Error {}

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
  opts: { sourceMessageId?: number; action?: "grounding"; confirmed?: boolean } = {},
): Promise<
  | {
      l3: string | null;
      l3Available: boolean;
      pending: { grounding: boolean };
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
  const pending = { grounding: false };
  const server = serverCanLLM();
  const local = !server && await localExpanderAvailable(userId);

  // Cached in-session explanations are free to return; generating one happens
  // only on the user's explicit, confirmed request.
  let l3 = profile?.l3 ?? null;
  if (!l3 && opts.action === "grounding") {
    requireAIConfirmation(opts.confirmed);
    const src = await groundingSource(termId, userId, opts.sourceMessageId);
    if (server) {
      l3 = await callGrounding(
        await getUserCalibration(userId),
        { term: term.term, domain: term.domain, l1: term.l1, ...src },
      );
      await db.insert(tables.userTerms).values({ userId, termId, l3 }).onConflictDoUpdate({ target: [tables.userTerms.userId, tables.userTerms.termId], set: { l3 } });
    } else {
      if (!local) throw new LocalExplainerUnavailable();
      await replaceUnconfirmedRequest(termId, userId);
      await db
        .insert(tables.expansionRequests)
        .values({ termId, userId, grounding: true, messageId: opts.sourceMessageId ?? null, confirmedAt: new Date() })
        .onConflictDoNothing();
    }
  }
  if (!l3) {
    const requests = await db
      .select({ id: tables.expansionRequests.id })
      .from(tables.expansionRequests)
      .where(and(
        eq(tables.expansionRequests.termId, termId),
        eq(tables.expansionRequests.userId, userId),
        eq(tables.expansionRequests.grounding, true),
        gt(tables.expansionRequests.confirmedAt, confirmationCutoff()),
      ));
    pending.grounding = local && requests.length > 0;
  }

  return { l3, l3Available: true, pending };
}

function requireAIConfirmation(confirmed: boolean | undefined) {
  if (!confirmed) throw new AIConfirmationRequired("AI confirmation required");
}

function confirmationCutoff() {
  return new Date(Date.now() - CONFIRMATION_TTL_MS);
}

// A pre-consent row from an older deployment conflicts with the unique key.
// Remove only stale in-session work, then insert a fresh confirmation.
async function replaceUnconfirmedRequest(termId: number, userId: number) {
  await db
    .delete(tables.expansionRequests)
    .where(and(
      eq(tables.expansionRequests.termId, termId),
      eq(tables.expansionRequests.userId, userId),
      eq(tables.expansionRequests.grounding, true),
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
): Promise<{ snippet: string }> {
  let source: { text: string } | null = null;
  if (sourceMessageId) {
    const [m] = await db
      .select({ text: tables.messages.text })
      .from(tables.messages)
      .innerJoin(tables.sessions, eq(tables.messages.sessionId, tables.sessions.id))
      .innerJoin(tables.devices, eq(tables.sessions.deviceId, tables.devices.id))
      .where(and(eq(tables.messages.id, sourceMessageId), eq(tables.devices.userId, userId)));
    source = m ?? null;
  }
  if (!source) {
    const [sighting] = await db
      .select({ text: tables.messages.text })
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

  if (!source) {
    throw new TermNotInYourSessions("term was not found in your sessions");
  }
  return {
    snippet: source.text.slice(0, SNIPPET_MAX),
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
      eq(tables.expansionRequests.grounding, true),
      isNotNull(tables.expansionRequests.confirmedAt),
      lt(tables.expansionRequests.claimedAt, new Date(Date.now() - CLAIM_TTL_MS)),
    ));
  const [req] = await db
    .select()
    .from(tables.expansionRequests)
    .where(and(
      eq(tables.expansionRequests.userId, userId),
      eq(tables.expansionRequests.grounding, true),
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
      eq(tables.expansionRequests.grounding, true),
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
  const level = await getUserCalibration(userId);
  const src = await groundingSource(req.termId, userId, req.messageId ?? undefined);
  return { id: req.id, prompt: localGroundingPrompt(level, { term: term.term, domain: term.domain, l1: term.l1, ...src }) };
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
  if (!req.grounding) {
    // Defense in depth for queue rows created by a retired server version.
    await db.delete(tables.expansionRequests).where(eq(tables.expansionRequests.id, req.id));
    return false;
  }
  await db
    .insert(tables.userTerms)
    .values({ userId, termId: req.termId, l3: trimmed })
    .onConflictDoUpdate({ target: [tables.userTerms.userId, tables.userTerms.termId], set: { l3: trimmed } });
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

// L3: grounded in the user's own source message, cached per-user only.
async function callGrounding(level: CalibrationLevel, input: {
  term: string;
  domain: string;
  l1: string;
  snippet: string;
}): Promise<string> {
  if (process.env.UNJARGON_FAKE_TRANSLATOR === "1") {
    console.warn("[expand] UNJARGON_FAKE_TRANSLATOR=1 — using offline fake, NOT the real model");
    return (
      FAKE_EXPANSIONS[input.term.toLowerCase()] ??
      `The agent mentioned “${input.term}” in this session: “${input.snippet.slice(0, 140)}…” (Offline fake L3.)`
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

// Offline fakes (UNJARGON_FAKE_TRANSLATOR=1): hand-written in-session
// explanations for fixture terms, template fallback otherwise. Loudly logged.
const FAKE_EXPANSIONS: Record<string, string> = {
  "stiff ode": "Your sim-pipeline reaction network couples fast binding kinetics with slow degradation — that spread is why runs took forever and sometimes produced NaNs. The agent switched to a stiff-capable solver (BDF) so the simulation stays stable with big time steps; the outcome message reports all 12 regression tests passing and the benchmark going from 127.4s to 3.1s.",
  bdf: "The agent chose BDF via scipy.integrate.solve_ivp to replace RK4 in sim/solver.py because your system is stiff. It's the standard prescription: implicit and A-stable, so the NaN blowups stop and the run finishes about 40× faster (3.1s vs 127.4s).",
};
