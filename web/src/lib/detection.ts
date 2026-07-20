import { and, asc, count, desc, eq, gte, isNull } from "drizzle-orm";
import { db, tables } from "@/db";
import { publish, type DetectionEvent } from "@/lib/bus";
import { corpusFor, detectJargon } from "@/lib/detect";

const BATCH_SIZE = 10;
const L1 = "Detected without AI. Select this term if you want an explanation.";
export const detectionDailyLimit = (() => {
  // Conservative Free-plan default. Increase only after checking D1 Row Metrics.
  const value = Number(process.env.D1_DAILY_DETECTION_MESSAGES ?? 750);
  return Number.isInteger(value) && value > 0 ? value : 750;
})();

export function utcDayStart() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

const globalForDetection = globalThis as unknown as {
  __unjargonDetectionUsers?: Set<number>;
  __unjargonDetectionRequested?: Set<number>;
};
const running = (globalForDetection.__unjargonDetectionUsers ??= new Set());
const requested = (globalForDetection.__unjargonDetectionRequested ??= new Set());

// A bootstrap or ingest schedules one bounded batch. Re-scheduling after each
// batch keeps a large history responsive while still finishing oldest-first.
export function scheduleDetection(userId: number) {
  if (running.has(userId)) {
    requested.add(userId);
    return;
  }
  running.add(userId);
  setTimeout(async () => {
    let more = false;
    try {
      more = await detectBatch(userId);
    } catch (err) {
      console.error(`[detect] user ${userId} batch failed:`, err);
    } finally {
      running.delete(userId);
    }
    if (more || requested.delete(userId)) scheduleDetection(userId);
  }, 0);
}

async function detectBatch(userId: number) {
  const [{ today }] = await db
    .select({ today: count(tables.messages.id) })
    .from(tables.messages)
    .where(gte(tables.messages.detectedAt, utcDayStart()));
  const remaining = Math.max(0, detectionDailyLimit - Number(today));
  if (remaining === 0) return false;
  const batchSize = Math.min(BATCH_SIZE, remaining);
  const rows = await db
    .select({ message: tables.messages })
    .from(tables.messages)
    .innerJoin(tables.sessions, eq(tables.messages.sessionId, tables.sessions.id))
    .innerJoin(tables.devices, eq(tables.sessions.deviceId, tables.devices.id))
    .where(and(eq(tables.devices.userId, userId), isNull(tables.messages.detectedAt)))
    .orderBy(asc(tables.messages.ts), asc(tables.messages.id))
    .limit(batchSize);
  if (rows.length === 0) return false;

  // ponytail: a recent per-user corpus is enough for weirdness scoring. Add
  // a maintained aggregate only if a large account makes this query visible.
  const recent = await db
    .select({ text: tables.messages.text })
    .from(tables.messages)
    .innerJoin(tables.sessions, eq(tables.messages.sessionId, tables.sessions.id))
    .innerJoin(tables.devices, eq(tables.sessions.deviceId, tables.devices.id))
    .where(eq(tables.devices.userId, userId))
    .orderBy(desc(tables.messages.id))
    .limit(1000);
  const corpus = corpusFor(recent.map((row) => row.text));
  for (const { message } of rows) await storeDetection(message, userId, corpus);
  return rows.length === batchSize && remaining > rows.length;
}

async function storeDetection(
  message: typeof tables.messages.$inferSelect,
  userId: number,
  corpus: ReturnType<typeof corpusFor>,
) {
  // Only candidates from detectJargon reach this path. In particular, do not
  // re-match old glossary words against raw text: that would reintroduce
  // chips inside paths, commands, and code identifiers.
  const byKey = new Map<string, { id: number; term: string }>();
  const newTerms: DetectionEvent["newTerms"] = [];

  for (const detected of detectJargon(message.text, corpus)) {
    const key = detected.term.toLowerCase();
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
    let term = inserted;
    if (!term) {
      [term] = await db
        .select()
        .from(tables.terms)
        .where(and(eq(tables.terms.key, key), isNull(tables.terms.userId)));
    }
    if (!term) continue;
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
    annotations,
    newTerms,
  });
}

function exactSpan(text: string, term: string) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.match(new RegExp(`(^|[^A-Za-z0-9])(${escaped})(?=$|[^A-Za-z0-9])`, "i"))?.[2] ?? null;
}
