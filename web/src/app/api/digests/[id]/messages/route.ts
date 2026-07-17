import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { db, tables } from "@/db";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

// The messages a digest card collapsed — fetched when the user expands it.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  const { id } = await params;
  const digestId = Number(id);
  if (!Number.isInteger(digestId) || digestId <= 0) {
    return Response.json({ error: "invalid digest id" }, { status: 400 });
  }
  const [digest] = await db
    .select()
    .from(tables.digests)
    .innerJoin(tables.sessions, eq(tables.digests.sessionId, tables.sessions.id))
    .innerJoin(tables.devices, eq(tables.sessions.deviceId, tables.devices.id))
    .where(and(eq(tables.digests.id, digestId), eq(tables.devices.userId, user.id)));
  if (!digest) {
    return Response.json({ error: "digest not found" }, { status: 404 });
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
    .where(
      and(
        eq(tables.messages.sessionId, digest.digests.sessionId),
        gte(tables.messages.id, digest.digests.fromMessageId),
        lte(tables.messages.id, digest.digests.toMessageId),
      ),
    )
    .orderBy(asc(tables.messages.id));

  const ids = rows.map((r) => r.id);
  const annotationRows =
    ids.length > 0
      ? await db
          .select()
          .from(tables.annotations)
          .where(inArray(tables.annotations.messageId, ids))
      : [];
  const byMessage = new Map<number, typeof annotationRows>();
  for (const a of annotationRows) {
    byMessage.set(a.messageId, [...(byMessage.get(a.messageId) ?? []), a]);
  }

  return Response.json({
    messages: rows.map((r) => ({
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
      annotations: (byMessage.get(r.id) ?? []).map((a) => ({
        id: a.id,
        span: a.span,
        sentenceRewrite: a.sentenceRewrite,
        termId: a.termId,
      })),
    })),
  });
}
