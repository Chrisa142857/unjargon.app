import { and, count, countDistinct, desc, eq, inArray, max, min, ne } from "drizzle-orm";
import { db, tables } from "@/db";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Everything /live needs on first paint, in one round-trip. The UI fetches
// client-side (rather than server-rendering) so the same static export can
// run on GitHub Pages against a remote API.
//
// Long sessions: messages already covered by a digest are collapsed —
// the response carries digest cards plus only the uncovered tail.
export async function GET(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  const digestRows = await db
    .select()
    .from(tables.digests)
    .innerJoin(tables.sessions, eq(tables.digests.sessionId, tables.sessions.id))
    .innerJoin(tables.devices, eq(tables.sessions.deviceId, tables.devices.id))
    .where(and(ne(tables.digests.summary, ""), eq(tables.devices.userId, user.id)))
    .orderBy(desc(tables.digests.id))
    .limit(200);
  const digests = digestRows.map((r) => r.digests).reverse();

  // A collector cannot know a stable total while its agent keeps writing, so
  // expose the records actually received instead of manufacturing a percentage.
  const [progress] = await db
    .select({
      messages: count(tables.messages.id),
      sessions: countDistinct(tables.sessions.id),
      firstMessageAt: min(tables.messages.ts),
      lastMessageAt: max(tables.messages.ts),
      lastImportedAt: max(tables.messages.createdAt),
    })
    .from(tables.messages)
    .innerJoin(tables.sessions, eq(tables.messages.sessionId, tables.sessions.id))
    .innerJoin(tables.devices, eq(tables.sessions.deviceId, tables.devices.id))
    .where(eq(tables.devices.userId, user.id));

  // Per session, everything up to the newest digest is covered.
  const coveredTo = new Map<number, number>();
  for (const d of digests) {
    coveredTo.set(
      d.sessionId,
      Math.max(coveredTo.get(d.sessionId) ?? 0, d.toMessageId),
    );
  }

  const rows = await db
    .select({
      id: tables.messages.id,
      sessionId: tables.messages.sessionId,
      ts: tables.messages.ts,
      text: tables.messages.text,
      subtitle: tables.messages.subtitle,
      importance: tables.messages.importance,
      translatedAt: tables.messages.translatedAt,
      device: tables.devices.name,
      tool: tables.sessions.tool,
      cwd: tables.sessions.cwd,
    })
    .from(tables.messages)
    .innerJoin(tables.sessions, eq(tables.messages.sessionId, tables.sessions.id))
    .innerJoin(tables.devices, eq(tables.sessions.deviceId, tables.devices.id))
    .where(eq(tables.devices.userId, user.id))
    .orderBy(desc(tables.messages.id))
    .limit(100);
  const uncovered = rows.filter(
    (r) => r.id > (coveredTo.get(r.sessionId) ?? 0),
  );

  const ids = uncovered.map((r) => r.id);
  const annotationRows =
    ids.length > 0
      ? await db
          .select()
          .from(tables.annotations)
          .where(inArray(tables.annotations.messageId, ids))
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
    .where(eq(tables.devices.userId, user.id))
    .groupBy(tables.terms.id, tables.userTerms.l3, tables.userTerms.learnedAt);

  return Response.json({
    calibration: user.calibration,
    progress: {
      messages: Number(progress.messages),
      sessions: Number(progress.sessions),
      firstMessageAt: progress.firstMessageAt?.toISOString() ?? null,
      lastMessageAt: progress.lastMessageAt?.toISOString() ?? null,
      lastImportedAt: progress.lastImportedAt?.toISOString() ?? null,
    },
    digests: digests.map((d) => ({
      id: d.id,
      sessionId: d.sessionId,
      fromMessageId: d.fromMessageId,
      toMessageId: d.toMessageId,
      fromTs: d.fromTs.toISOString(),
      toTs: d.toTs.toISOString(),
      messageCount: d.messageCount,
      summary: d.summary,
    })),
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
    messages: uncovered.reverse().map((r) => ({
      id: r.id,
      sessionId: r.sessionId,
      device: r.device,
      tool: r.tool,
      cwd: r.cwd,
      ts: r.ts.toISOString(),
      text: r.text,
      subtitle: r.subtitle,
      importance: r.importance,
      translated: r.translatedAt !== null,
      annotations: annotationsByMessage.get(r.id) ?? [],
    })),
  });
}
