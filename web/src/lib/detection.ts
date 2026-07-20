import { and, asc, count, eq, gte, isNull } from "drizzle-orm";
import { db, tables } from "@/db";
import { publish, type DetectionEvent } from "@/lib/bus";
import { detectJargon } from "@/lib/detect";

// Fifty rows bounds D1 work without increasing the daily Free-plan allowance.
const BATCH_SIZE = 50;
const L1 = "Detected without AI. Select this term if you want an explanation.";
export const detectionDailyLimit = (() => {
  // Conservative Free-plan default. Increase only after checking D1 Row Metrics.
  const value = Number(process.env.D1_DAILY_DETECTION_MESSAGES ?? 1_000);
  return Number.isInteger(value) && value > 0 ? value : 1_000;
})();

export function utcDayStart() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

const globalForDetection = globalThis as unknown as {
  __unjargonDetectionUsers?: Set<number>;
  __unjargonDetectionRequested?: Set<number>;
  __unjargonDetectionWakeups?: Map<number, number>;
  __unjargonDetectionDone?: Set<number>;
};
const running = (globalForDetection.__unjargonDetectionUsers ??= new Set());
const requested = (globalForDetection.__unjargonDetectionRequested ??= new Set());
const wakeups = (globalForDetection.__unjargonDetectionWakeups ??= new Map());
const done = (globalForDetection.__unjargonDetectionDone ??= new Set());

function nextUtcMidnight() {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) + 1_000;
}

function wakeAfterQuotaReset(userId: number) {
  const until = nextUtcMidnight();
  if ((wakeups.get(userId) ?? 0) >= until) return;
  wakeups.set(userId, until);
  // ponytail: this is in-process. The collector's status heartbeat and a
  // /live reload also call scheduleDetection after a cold restart.
  setTimeout(() => {
    if (wakeups.get(userId) === until) wakeups.delete(userId);
    scheduleDetection(userId);
  }, Math.max(1_000, until - Date.now()));
}

// A bootstrap or ingest schedules one bounded batch. Re-scheduling after each
// batch keeps a large history responsive while still finishing oldest-first.
export function scheduleDetection(userId: number, newWork = false) {
  if (newWork) done.delete(userId);
  if (done.has(userId)) return;
  const wakeup = wakeups.get(userId);
  if (wakeup && wakeup > Date.now()) return;
  if (wakeup) wakeups.delete(userId);
  if (running.has(userId)) {
    requested.add(userId);
    return;
  }
  running.add(userId);
  setTimeout(async () => {
    let result: "done" | "more" | "quota" = "done";
    let failed = false;
    try {
      result = await detectBatch(userId);
    } catch (err) {
      failed = true;
      console.error(`[detect] user ${userId} batch failed:`, err);
    } finally {
      running.delete(userId);
    }
    if (failed) {
      requested.delete(userId);
    } else if (result === "quota") {
      requested.delete(userId);
      wakeAfterQuotaReset(userId);
    } else if (result === "more" || requested.delete(userId)) {
      scheduleDetection(userId);
    } else {
      done.add(userId);
    }
  }, 0);
}

async function detectBatch(userId: number) {
  const [{ today }] = await db
    .select({ today: count(tables.messages.id) })
    .from(tables.messages)
    .where(gte(tables.messages.detectedAt, utcDayStart()));
  const usedToday = Number(today);
  const remaining = Math.max(0, detectionDailyLimit - usedToday);
  if (remaining === 0) return "quota" as const;
  const batchSize = Math.min(BATCH_SIZE, remaining);
  const rows = await db
    .select({ message: tables.messages })
    .from(tables.messages)
    .innerJoin(tables.sessions, eq(tables.messages.sessionId, tables.sessions.id))
    .innerJoin(tables.devices, eq(tables.sessions.deviceId, tables.devices.id))
    .where(and(eq(tables.devices.userId, userId), isNull(tables.messages.detectedAt)))
    .orderBy(asc(tables.messages.ts), asc(tables.messages.id))
    .limit(batchSize);
  if (rows.length === 0) return "done" as const;

  const sharedTerms = new Map<string, SharedTerm>();
  for (const [index, { message }] of rows.entries()) {
    await storeDetection(message, userId, sharedTerms, usedToday + index + 1);
  }
  if (rows.length >= remaining) return "quota" as const;
  return rows.length === batchSize ? "more" as const : "done" as const;
}

type SharedTerm = {
  id: number;
  term: string;
  domain: string;
  kind: string;
  l1: string;
  salience: number | null;
};

async function storeDetection(
  message: typeof tables.messages.$inferSelect,
  userId: number,
  sharedTerms: Map<string, SharedTerm>,
  dailyDetectionUsed: number,
) {
  // Only candidates from detectJargon reach this path. In particular, do not
  // re-match old glossary words against raw text: that would reintroduce
  // chips inside paths, commands, and code identifiers.
  const byKey = new Map<string, { id: number; term: string }>();
  const newTerms: DetectionEvent["newTerms"] = [];

  for (const detected of detectJargon(message.text)) {
    const key = detected.term.toLowerCase();
    let term = sharedTerms.get(key);
    if (!term) {
      const [inserted] = await db
        .insert(tables.terms)
        .values({
          key,
          term: detected.term,
          kind: detected.kind,
          domain: detected.kind === "initial" ? "Acronym" : "Technical vocabulary",
          l1: L1,
          salience: detected.confidence,
        })
        .onConflictDoNothing()
        .returning();
      term = inserted;
      if (!term) {
        [term] = await db
          .select()
          .from(tables.terms)
          .where(and(eq(tables.terms.key, key), isNull(tables.terms.userId)));
      }
    }
    if (!term) continue;
    sharedTerms.set(key, term);
    byKey.set(key, { id: term.id, term: term.term });
    // The browser may not have this shared term yet, even when another user
    // created it first. It de-duplicates terms it already has.
    newTerms.push({
      id: term.id,
      term: term.term,
      domain: term.domain,
      kind: term.kind,
      l1: term.l1,
      salience: term.salience,
    });
  }

  const annotations: DetectionEvent["annotations"] = [];
  for (const term of [...byKey.values()].slice(0, 6)) {
    const span = exactSpan(message.text, term.term);
    if (!span) continue;
    await db
      .insert(tables.termSightings)
      .values({ termId: term.id, messageId: message.id })
      .onConflictDoNothing();
    const [annotation] = await db
      .insert(tables.annotations)
      .values({
        messageId: message.id,
        span,
        sentenceRewrite: "Detected jargon — select the term for an explanation.",
        termId: term.id,
      })
      .returning();
    annotations.push({
      id: annotation.id,
      span: annotation.span,
      sentenceRewrite: annotation.sentenceRewrite,
      termId: annotation.termId,
    });
  }

  await db
    .update(tables.messages)
    .set({ detectedAt: new Date(), claimedAt: null })
    .where(eq(tables.messages.id, message.id));
  publish({
    userId,
    type: "detection",
    messageId: message.id,
    sessionId: message.sessionId,
    dailyDetectionUsed,
    annotations,
    newTerms,
  });
}

function exactSpan(text: string, term: string) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.match(new RegExp(`(^|[^A-Za-z0-9])(${escaped})(?=$|[^A-Za-z0-9])`, "i"))?.[2] ?? null;
}
