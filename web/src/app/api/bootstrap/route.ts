import { and, count, countDistinct, desc, eq, gte, isNotNull, isNull, max, min, ne, sql } from "drizzle-orm";
import { db, tables } from "@/db";
import { requireUser } from "@/lib/auth";
import { isHighConfidenceTerm } from "@/lib/detect";
import { detectionDailyLimit, scheduleDetection, utcDayStart } from "@/lib/detection";
import { collectorLimits } from "@/lib/collector-limits";

export const dynamic = "force-dynamic";

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

  const hourAgo = Date.now() - 3600_000;
  const today = utcDayStart();
  const [progress] = await db
    .select({
      messages: count(tables.messages.id),
      uploadedToday: count(sql`case when ${tables.messages.createdAt} >= ${today} then 1 end`),
      detected: count(tables.messages.detectedAt),
      detectedLastHour: count(sql`case when ${tables.messages.detectedAt} > ${hourAgo} then 1 end`),
      sessions: countDistinct(tables.sessions.id),
      firstMessageAt: min(tables.messages.ts).mapWith(tables.messages.ts),
      lastMessageAt: max(tables.messages.ts).mapWith(tables.messages.ts),
      lastImportedAt: max(tables.messages.createdAt).mapWith(tables.messages.createdAt),
    })
    .from(tables.messages)
    .innerJoin(tables.sessions, eq(tables.messages.sessionId, tables.sessions.id))
    .where(eq(tables.sessions.deviceId, selected.id));
  const [{ detectedToday }] = await db
    .select({ detectedToday: count(tables.messages.id) })
    .from(tables.messages)
    .where(gte(tables.messages.detectedAt, today));
  const [{ userUploadedToday }] = await db
    .select({ userUploadedToday: count(tables.messages.id) })
    .from(tables.messages)
    .innerJoin(tables.sessions, eq(tables.messages.sessionId, tables.sessions.id))
    .innerJoin(tables.devices, eq(tables.sessions.deviceId, tables.devices.id))
    .where(and(eq(tables.devices.userId, user.id), gte(tables.messages.createdAt, today)));
  const [{ serviceUploadedToday, serviceStored }] = await db
    .select({
      serviceUploadedToday: count(sql`case when ${tables.messages.createdAt} >= ${today} then 1 end`),
      serviceStored: count(tables.messages.id),
    })
    .from(tables.messages);

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
    .leftJoin(tables.userTerms, and(eq(tables.userTerms.termId, tables.terms.id), eq(tables.userTerms.userId, user.id)))
    .where(and(eq(tables.sessions.deviceId, selected.id), isNull(tables.terms.userId), ne(tables.terms.kind, "keyword")))
    .groupBy(tables.terms.id, tables.userTerms.l3, tables.userTerms.learnedAt);

  return Response.json({
    devices: devices.map((device) => ({ id: device.id, name: device.name, lastSeenAt: device.lastSeenAt.toISOString() })),
    selectedDeviceId: selected.id,
    limits: publicLimits({
      deviceDaily: Number(progress.uploadedToday),
      deviceStored: Number(progress.messages),
      userDaily: Number(userUploadedToday),
      globalDaily: Number(serviceUploadedToday),
      globalStored: Number(serviceStored),
    }),
    progress: {
      messages: Number(progress.messages), detected: Number(progress.detected), ratePerHour: Number(progress.detectedLastHour),
      dailyDetectionLimit: detectionDailyLimit, dailyDetectionUsed: Number(detectedToday), sessions: Number(progress.sessions),
      firstMessageAt: progress.firstMessageAt?.toISOString() ?? null, lastMessageAt: progress.lastMessageAt?.toISOString() ?? null,
      lastImportedAt: progress.lastImportedAt?.toISOString() ?? null,
      ...aiUsage(selected.importStatus),
    },
    terms: rows.filter((term) => isHighConfidenceTerm(term.term, term.salience)).map((term) => ({
      ...term, learnedAt: term.learnedAt?.toISOString() ?? null, lastSeenAt: (term.lastSeenAt ?? term.createdAt).toISOString(),
    })),
  });
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
