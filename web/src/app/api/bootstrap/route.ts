import { and, count, countDistinct, desc, eq, gte, isNotNull, isNull, max, min, ne, sql } from "drizzle-orm";
import { db, tables } from "@/db";
import { requireUser } from "@/lib/auth";
import { isHighConfidenceTerm } from "@/lib/detect";
import { detectionDailyLimit, scheduleDetection, utcDayStart } from "@/lib/detection";
import { collectorLimits } from "@/lib/collector-limits";
import { loadMessageUsage } from "@/lib/counters";

export const dynamic = "force-dynamic";

// /live polls this route, so its cost is paid over and over for as long as a
// tab stays open. Everything below is either an indexed lookup or served from
// the snapshot cache: the glossary and the per-device aggregates are recomputed
// only once the detector has actually moved, which a two-row watermark tells us
// far more cheaply than the aggregates themselves.
const SNAPSHOT_MAX_AGE_MS = 60_000;
const SNAPSHOT_LIMIT = 256;
type Snapshot = { watermark: string; at: number; progress: DeviceProgress; terms: unknown[] };
type DeviceProgress = {
  detected: number;
  ratePerHour: number;
  sessions: number;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
  lastImportedAt: string | null;
};
const globalForBootstrap = globalThis as unknown as { __unjargonLiveSnapshots?: Map<string, Snapshot> };
const snapshots = (globalForBootstrap.__unjargonLiveSnapshots ??= new Map());

// /live deliberately returns only a selected machine's glossary. Raw agent
// messages remain private local files and are never read back for this page.
export async function GET(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  scheduleDetection(user.id);

  const devices = await db
    .select({ id: tables.devices.id, name: tables.devices.name, lastSeenAt: tables.devices.lastSeenAt, importStatus: tables.devices.importStatus })
    .from(tables.devices)
    .where(and(eq(tables.devices.userId, user.id), isNotNull(tables.devices.tokenHash)))
    .orderBy(desc(tables.devices.lastSeenAt));
  const requested = Number(new URL(req.url).searchParams.get("device"));
  const selected = devices.find((device) => device.id === requested) ?? devices[0] ?? null;
  if (!selected) {
    return Response.json({ devices: [], selectedDeviceId: null, progress: emptyProgress(), limits: publicLimits(), terms: [] });
  }

  const today = utcDayStart();
  const usage = await loadMessageUsage({ userId: user.id, deviceId: selected.id, dayStart: today });
  // Both halves of the watermark are indexed: the primary key for the newest
  // message, and messages_detected_at for the day's detections.
  const [{ newestMessageId }] = await db
    .select({ newestMessageId: max(tables.messages.id) })
    .from(tables.messages);
  const [{ detectedToday }] = await db
    .select({ detectedToday: count(tables.messages.id) })
    .from(tables.messages)
    .where(gte(tables.messages.detectedAt, today));

  const cacheKey = `${user.id}:${selected.id}`;
  const watermark = `${newestMessageId ?? 0}:${detectedToday}`;
  const cached = snapshots.get(cacheKey);
  // The watermark covers everything the snapshot is built from, except the
  // last-hour detection rate, which falls with the clock alone. Once that rate
  // has reached zero there is nothing left to decay, so an idle page can hold
  // its snapshot until the detector moves again and never pay for these two
  // queries at all.
  const usable = cached
    && cached.watermark === watermark
    && (cached.progress.ratePerHour === 0 || Date.now() - cached.at < SNAPSHOT_MAX_AGE_MS);
  const snapshot = usable ? cached : await loadSnapshot(user.id, selected.id, watermark);
  // Re-inserting moves the key to the end of the Map's order, so the eviction
  // below drops the device nobody has polled for longest.
  snapshots.delete(cacheKey);
  snapshots.set(cacheKey, snapshot);
  for (const key of snapshots.keys()) {
    if (snapshots.size <= SNAPSHOT_LIMIT) break;
    snapshots.delete(key);
  }

  return Response.json({
    devices: devices.map((device) => ({ id: device.id, name: device.name, lastSeenAt: device.lastSeenAt.toISOString() })),
    selectedDeviceId: selected.id,
    limits: publicLimits(usage),
    progress: {
      messages: usage.deviceStored,
      ...snapshot.progress,
      dailyDetectionLimit: detectionDailyLimit,
      dailyDetectionUsed: Number(detectedToday),
      ...aiUsage(selected.importStatus),
    },
    terms: snapshot.terms,
  });
}

// The two queries that scale with a device's history. Recomputed only when the
// watermark moves, so an idle tab re-polls without touching them at all.
async function loadSnapshot(userId: number, deviceId: number, watermark: string): Promise<Snapshot> {
  const hourAgo = Date.now() - 3600_000;
  const [progress] = await db
    .select({
      detected: count(tables.messages.detectedAt),
      detectedLastHour: count(sql`case when ${tables.messages.detectedAt} > ${hourAgo} then 1 end`),
      sessions: countDistinct(tables.sessions.id),
      firstMessageAt: min(tables.messages.ts).mapWith(tables.messages.ts),
      lastMessageAt: max(tables.messages.ts).mapWith(tables.messages.ts),
      lastImportedAt: max(tables.messages.createdAt).mapWith(tables.messages.createdAt),
    })
    .from(tables.messages)
    .innerJoin(tables.sessions, eq(tables.messages.sessionId, tables.sessions.id))
    .where(eq(tables.sessions.deviceId, deviceId));

  const rows = await db
    .select({
      id: tables.terms.id,
      term: tables.terms.term,
      domain: tables.terms.domain,
      kind: tables.terms.kind,
      l1: tables.terms.l1,
      l3: tables.userTerms.l3,
      salience: tables.terms.salience,
      learnedAt: tables.userTerms.learnedAt,
      createdAt: tables.terms.createdAt,
      lastSeenAt: max(tables.messages.ts),
    })
    .from(tables.terms)
    .innerJoin(tables.termSightings, eq(tables.termSightings.termId, tables.terms.id))
    .innerJoin(tables.messages, eq(tables.messages.id, tables.termSightings.messageId))
    .innerJoin(tables.sessions, eq(tables.messages.sessionId, tables.sessions.id))
    .leftJoin(tables.userTerms, and(eq(tables.userTerms.termId, tables.terms.id), eq(tables.userTerms.userId, userId)))
    .where(and(eq(tables.sessions.deviceId, deviceId), isNull(tables.terms.userId), ne(tables.terms.kind, "keyword")))
    .groupBy(tables.terms.id, tables.userTerms.l3, tables.userTerms.learnedAt);

  return {
    watermark,
    at: Date.now(),
    progress: {
      detected: Number(progress.detected),
      ratePerHour: Number(progress.detectedLastHour),
      sessions: Number(progress.sessions),
      firstMessageAt: progress.firstMessageAt?.toISOString() ?? null,
      lastMessageAt: progress.lastMessageAt?.toISOString() ?? null,
      lastImportedAt: progress.lastImportedAt?.toISOString() ?? null,
    },
    terms: rows.filter((term) => isHighConfidenceTerm(term.term, term.salience)).map((term) => ({
      ...term, learnedAt: term.learnedAt?.toISOString() ?? null, lastSeenAt: (term.lastSeenAt ?? term.createdAt).toISOString(),
    })),
  };
}

function publicLimits(used: Partial<Record<keyof typeof collectorLimits, number>> = {}) {
  return {
    deviceDaily: { used: used.deviceDaily ?? 0, limit: collectorLimits.deviceDaily },
    userDaily: { used: used.userDaily ?? 0, limit: collectorLimits.userDaily },
    globalDaily: { used: used.globalDaily ?? 0, limit: collectorLimits.globalDaily },
    deviceStored: { used: used.deviceStored ?? 0, limit: collectorLimits.deviceStored },
    globalStored: { used: used.globalStored ?? 0, limit: collectorLimits.globalStored },
  };
}

function emptyProgress() {
  return { messages: 0, detected: 0, ratePerHour: 0, dailyDetectionLimit: detectionDailyLimit, dailyDetectionUsed: 0, sessions: 0, firstMessageAt: null, lastMessageAt: null, ...aiUsage(null) };
}

function aiUsage(raw: string | null) {
  try {
    const status = JSON.parse(raw ?? "") as { budgetUsed?: unknown; budgetLimit?: unknown; inputTokens?: unknown; outputTokens?: unknown; tokensReported?: unknown };
    return { aiCallsUsed: Number(status.budgetUsed) || 0, aiCallsLimit: Number(status.budgetLimit) || 0, aiInputTokens: Number(status.inputTokens) || 0, aiOutputTokens: Number(status.outputTokens) || 0, aiTokensReported: status.tokensReported === true };
  } catch {
    return { aiCallsUsed: 0, aiCallsLimit: 0, aiInputTokens: 0, aiOutputTokens: 0, aiTokensReported: false };
  }
}
