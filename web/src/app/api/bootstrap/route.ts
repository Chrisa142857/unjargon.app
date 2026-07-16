import { desc, eq, inArray } from "drizzle-orm";
import { db, tables } from "@/db";
import { getCalibration } from "@/lib/settings";

export const dynamic = "force-dynamic";

// Everything /live needs on first paint, in one round-trip. The UI fetches
// client-side (rather than server-rendering) so the same static export can
// run on GitHub Pages against a remote API.
export async function GET() {
  const rows = await db
    .select({
      id: tables.messages.id,
      sessionId: tables.messages.sessionId,
      ts: tables.messages.ts,
      text: tables.messages.text,
      subtitle: tables.messages.subtitle,
      translatedAt: tables.messages.translatedAt,
      device: tables.devices.name,
      tool: tables.sessions.tool,
      cwd: tables.sessions.cwd,
    })
    .from(tables.messages)
    .innerJoin(tables.sessions, eq(tables.messages.sessionId, tables.sessions.id))
    .innerJoin(tables.devices, eq(tables.sessions.deviceId, tables.devices.id))
    .orderBy(desc(tables.messages.id))
    .limit(100);

  const ids = rows.map((r) => r.id);
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

  const termRows = await db.select().from(tables.terms);

  return Response.json({
    calibration: await getCalibration(),
    terms: termRows.map((t) => ({
      id: t.id,
      term: t.term,
      domain: t.domain,
      l1: t.l1,
      l2: t.l2,
      l3: t.l3,
      salience: t.salience,
    })),
    messages: rows.reverse().map((r) => ({
      id: r.id,
      sessionId: r.sessionId,
      device: r.device,
      tool: r.tool,
      cwd: r.cwd,
      ts: r.ts.toISOString(),
      text: r.text,
      subtitle: r.subtitle,
      translated: r.translatedAt !== null,
      annotations: annotationsByMessage.get(r.id) ?? [],
    })),
  });
}
