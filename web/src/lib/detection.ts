import { and, count, eq, gte, isNull, ne, sql } from "drizzle-orm";
import { db, tables } from "@/db";
import { publish, type DetectionEvent } from "@/lib/bus";
import { detectJargon } from "@/lib/detect";
import { retainTerm, type TermBudget } from "@/lib/term-budget";

// Fifty rows keeps a large backfill responsive.
const BATCH_SIZE = 50;
const L1 = "Detected without AI. Open the public reference for a basic definition.";
const HISTORY_GRACE_MS = 5 * 60_000;
export const detectionDailyLimit = (() => {
  // A daily ceiling keeps the paid D1 budget predictable.
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
  __unjargonTermBudgets?: Map<number, { budget: TermBudget; at: number }>;
};
const running = (globalForDetection.__unjargonDetectionUsers ??= new Set());
const requested = (globalForDetection.__unjargonDetectionRequested ??= new Set());
const wakeups = (globalForDetection.__unjargonDetectionWakeups ??= new Map());
const done = (globalForDetection.__unjargonDetectionDone ??= new Set());
const budgets = (globalForDetection.__unjargonTermBudgets ??= new Map());

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

// Revoking a device leaves its uploaded backlog permanently undetected, since
// detection skips unpaired machines. Those rows would otherwise sit in the
// messages_undetected_ts partial index forever and be walked by every later
// batch for every user: 809 such rows on the deployed database already cost
// 2,389 rows read per batch. Stamping them with the time they arrived retires
// them from that index without touching the glossary /wiki still shows. A
// later re-pair collects from new messages, matching the fresh secret it gets.
export async function retireUndetectedBacklog(deviceId: number) {
  await db.run(sql`
    update "messages" set "detected_at" = "created_at"
    where "detected_at" is null and "session_id" in (
      select "id" from "sessions" where "device_id" = ${deviceId}
    )
  `);
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
  const rows = await pendingMessages(userId, batchSize);
  if (rows.length === 0) return "done" as const;

  const budget = await termBudgetFor(userId);
  const sharedTerms = new Map<string, SharedTerm>();
  for (const [index, message] of rows.entries()) {
    await storeDetection(message, userId, sharedTerms, budget, usedToday + index + 1);
  }
  if (rows.length >= remaining) return "quota" as const;
  return rows.length === batchSize ? "more" as const : "done" as const;
}

// The oldest messages still awaiting detection. Drizzle's SQLite dialect has
// no index hint, and without one SQLite plans this from devices -> sessions ->
// messages_session_id: it reads every message the user owns and sorts them in a
// temp B-tree only to keep fifty. Measured against the deployed database that
// was 12,338 rows read per batch to return nothing at all. messages_undetected_ts
// is a partial index on (ts) WHERE detected_at IS NULL, so walking it yields the
// oldest undetected rows already ordered and LIMIT ends the scan early. Its
// implicit (ts, rowid) order is exactly the ORDER BY wanted here, because id is
// the rowid. Unpaired machines keep their glossary in /wiki, but their uploaded
// backlog must never consume detection work after the user revokes them.
type PendingMessage = { id: number; sessionId: number; ts: Date; text: string; createdAt: Date };

async function pendingMessages(userId: number, limit: number): Promise<PendingMessage[]> {
  const rows = await db.all<[number, number, number, string, number]>(sql`
    select m."id", m."session_id", m."ts", m."text", m."created_at"
    from "messages" m indexed by "messages_undetected_ts"
    where m."detected_at" is null and m."session_id" in (
      select s."id" from "sessions" s
      join "devices" d on d."id" = s."device_id"
      where d."user_id" = ${userId} and d."token_hash" is not null
    )
    order by m."ts", m."id"
    limit ${limit}
  `);
  return rows.map(([id, sessionId, ts, text, createdAt]) => ({
    id, sessionId, ts: new Date(ts), text, createdAt: new Date(createdAt),
  }));
}

// Which terms this user has already seen. Only detection changes that set, and
// retainTerm adds each key it keeps as the sighting below is written, so the
// loaded copy stays in step with the database and can be held between batches.
// Rebuilding it per batch is a five-table join over every sighting the user
// owns - 49,137 rows read on the deployed database, the most expensive query
// left on this path. Re-seeding hourly keeps a restart or an out-of-band edit
// from pinning a stale set indefinitely.
const BUDGET_TTL_MS = 60 * 60_000;
const BUDGET_LIMIT = 64;

async function termBudgetFor(userId: number): Promise<TermBudget> {
  const cached = budgets.get(userId);
  if (cached && Date.now() - cached.at < BUDGET_TTL_MS) return cached.budget;
  const budget = await loadTermBudget(userId);
  // Re-inserting moves the key last, so the eviction below drops the user
  // whose detector has been idle longest.
  budgets.delete(userId);
  budgets.set(userId, { budget, at: Date.now() });
  for (const key of budgets.keys()) {
    if (budgets.size <= BUDGET_LIMIT) break;
    budgets.delete(key);
  }
  return budget;
}

async function loadTermBudget(userId: number): Promise<TermBudget> {
  const seen = await db
    .select({
      key: tables.terms.key,
      historical: sql<number>`max(case when ${tables.messages.ts} < ${tables.messages.createdAt} - ${HISTORY_GRACE_MS} then 1 else 0 end)`,
    })
    .from(tables.terms)
    .innerJoin(tables.termSightings, eq(tables.termSightings.termId, tables.terms.id))
    .innerJoin(tables.messages, eq(tables.messages.id, tables.termSightings.messageId))
    .innerJoin(tables.sessions, eq(tables.sessions.id, tables.messages.sessionId))
    .innerJoin(tables.devices, eq(tables.devices.id, tables.sessions.deviceId))
    .where(and(eq(tables.devices.userId, userId), isNull(tables.terms.userId), ne(tables.terms.kind, "keyword")))
    .groupBy(tables.terms.key);
  return {
    history: new Set(seen.filter((term) => Number(term.historical)).map((term) => term.key)),
    live: new Set(seen.filter((term) => !Number(term.historical)).map((term) => term.key)),
  };
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
  message: PendingMessage,
  userId: number,
  sharedTerms: Map<string, SharedTerm>,
  budget: TermBudget,
  dailyDetectionUsed: number,
) {
  // Only candidates from detectJargon reach this path. In particular, do not
  // re-match old glossary words against raw text: that would reintroduce
  // chips inside paths, commands, and code identifiers.
  const byKey = new Map<string, { id: number; term: string }>();
  const newTerms: DetectionEvent["newTerms"] = [];
  const historical = message.ts.getTime() < message.createdAt.getTime() - HISTORY_GRACE_MS;

  for (const detected of detectJargon(message.text)) {
    const key = detected.term.toLowerCase();
    if (!retainTerm(budget, key, historical)) continue;
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
        sentenceRewrite: "Detected jargon — open the term for a public reference.",
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
