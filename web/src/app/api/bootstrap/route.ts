import { and, count, countDistinct, desc, eq, gte, inArray, isNull, max, min, ne, sql } from "drizzle-orm";
import { db, tables } from "@/db";
import { requireUser } from "@/lib/auth";
import { detectionDailyLimit, scheduleDetection, utcDayStart } from "@/lib/detection";

export const dynamic = "force-dynamic";

// Everything /live needs on first paint, in one round-trip. The UI fetches
// client-side (rather than server-rendering) so the same static export can
// run on GitHub Pages against a remote API.
//
export async function GET(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;

  // Start the zero-AI, oldest-first history pass. `detected_at` is separate
  // from legacy AI processing, so existing history is not skipped.
  scheduleDetection(user.id);

  // Truthful import status: completed means jargon detection finished.
  const hourAgo = Date.now() - 3600_000;
  const [progress] = await db
    .select({
      messages: count(tables.messages.id),
      detected: count(tables.messages.detectedAt),
      detectedLastHour: count(
        sql`case when ${tables.messages.detectedAt} > ${hourAgo} then 1 end`,
      ),
      sessions: countDistinct(tables.sessions.id),
      firstMessageAt: min(tables.messages.ts).mapWith(tables.messages.ts),
      lastMessageAt: max(tables.messages.ts).mapWith(tables.messages.ts),
      lastImportedAt: max(tables.messages.createdAt).mapWith(tables.messages.createdAt),
    })
    .from(tables.messages)
    .innerJoin(tables.sessions, eq(tables.messages.sessionId, tables.sessions.id))
    .innerJoin(tables.devices, eq(tables.sessions.deviceId, tables.devices.id))
    .where(eq(tables.devices.userId, user.id));
  const [{ detectedToday }] = await db
    .select({ detectedToday: count(tables.messages.id) })
    .from(tables.messages)
    .where(gte(tables.messages.detectedAt, utcDayStart()));

  const rows = await db
    .select({
      id: tables.messages.id,
      sessionId: tables.messages.sessionId,
      ts: tables.messages.ts,
      text: tables.messages.text,
      detectedAt: tables.messages.detectedAt,
      device: tables.devices.name,
      tool: tables.sessions.tool,
      cwd: tables.sessions.cwd,
    })
    .from(tables.messages)
    .innerJoin(tables.sessions, eq(tables.messages.sessionId, tables.sessions.id))
    .innerJoin(tables.devices, eq(tables.sessions.deviceId, tables.devices.id))
    .where(eq(tables.devices.userId, user.id))
    .orderBy(desc(tables.messages.id))
    .limit(99);
  const ids = rows.map((r) => r.id);
  const annotationRows =
    ids.length > 0
      ? await db
          .select({
            id: tables.annotations.id,
            messageId: tables.annotations.messageId,
            span: tables.annotations.span,
            sentenceRewrite: tables.annotations.sentenceRewrite,
            termId: tables.annotations.termId,
          })
          .from(tables.annotations)
          .innerJoin(tables.terms, eq(tables.annotations.termId, tables.terms.id))
          .where(and(
            inArray(tables.annotations.messageId, ids),
            isNull(tables.terms.userId),
            ne(tables.terms.kind, "keyword"),
          ))
      : [];
  const annotationsByMessage = new Map<
    number,
    { id: number; span: string; sentenceRewrite: string; termId: number | null }[]
  >();
  for (const a of annotationRows) {
    const list = annotationsByMessage.get(a.messageId) ?? [];
    list.push({
      id: a.id,
      span: a.span,
      sentenceRewrite: a.sentenceRewrite,
      termId: a.termId,
    });
    annotationsByMessage.set(a.messageId, list);
  }

  // Terms with recency (latest sighting) — the chip board sorts by it.
  const termRows = await db
    .select({
      id: tables.terms.id,
      term: tables.terms.term,
      domain: tables.terms.domain,
      kind: tables.terms.kind,
      l1: tables.terms.l1,
      l2: tables.terms.l2,
      l3: tables.userTerms.l3,
      salience: tables.terms.salience,
      learnedAt: tables.userTerms.learnedAt,
      createdAt: tables.terms.createdAt,
      lastSeenAt: max(tables.messages.ts),
    })
    .from(tables.terms)
    .innerJoin(
      tables.termSightings,
      eq(tables.termSightings.termId, tables.terms.id),
    )
    .innerJoin(
      tables.messages,
      eq(tables.messages.id, tables.termSightings.messageId),
    )
    .innerJoin(tables.sessions, eq(tables.messages.sessionId, tables.sessions.id))
    .innerJoin(tables.devices, eq(tables.sessions.deviceId, tables.devices.id))
    .leftJoin(tables.userTerms, and(eq(tables.userTerms.termId, tables.terms.id), eq(tables.userTerms.userId, user.id)))
    .where(and(eq(tables.devices.userId, user.id), isNull(tables.terms.userId), ne(tables.terms.kind, "keyword")))
    .groupBy(tables.terms.id, tables.userTerms.l3, tables.userTerms.learnedAt);

  return Response.json({
    calibration: user.calibration,
    progress: {
      messages: Number(progress.messages),
      detected: Number(progress.detected),
      ratePerHour: Number(progress.detectedLastHour),
      dailyDetectionLimit: detectionDailyLimit,
      dailyDetectionUsed: Number(detectedToday),
      sessions: Number(progress.sessions),
      firstMessageAt: progress.firstMessageAt?.toISOString() ?? null,
      lastMessageAt: progress.lastMessageAt?.toISOString() ?? null,
      lastImportedAt: progress.lastImportedAt?.toISOString() ?? null,
    },
    terms: termRows.map((t) => ({
      id: t.id,
      term: t.term,
      domain: t.domain,
      kind: t.kind,
      l1: t.l1,
      l2: t.l2,
      l3: t.l3,
      salience: t.salience,
      learnedAt: t.learnedAt?.toISOString() ?? null,
      lastSeenAt: (t.lastSeenAt ?? t.createdAt).toISOString(),
    })),
    messages: rows.reverse().map((r) => ({
      id: r.id,
      sessionId: r.sessionId,
      device: r.device,
      tool: r.tool,
      cwd: r.cwd,
      ts: r.ts.toISOString(),
      text: r.text,
      detected: r.detectedAt !== null,
      annotations: annotationsByMessage.get(r.id) ?? [],
    })),
  });
}
