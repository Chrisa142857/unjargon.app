import { and, eq, isNull, ne } from "drizzle-orm";
import { db, tables } from "@/db";
import { requireUser } from "@/lib/auth";
import { isHighConfidenceTerm } from "@/lib/detect";
import { wikipediaReference } from "@/lib/reference";

export const dynamic = "force-dynamic";

// A public source lookup is zero-AI and receives only the detected term.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  const termId = Number((await params).id);
  if (!Number.isInteger(termId) || termId <= 0) {
    return Response.json({ error: "invalid term id" }, { status: 400 });
  }
  const [term] = await db
    .select({ term: tables.terms.term, salience: tables.terms.salience })
    .from(tables.terms)
    .innerJoin(tables.termSightings, eq(tables.termSightings.termId, tables.terms.id))
    .innerJoin(tables.messages, eq(tables.messages.id, tables.termSightings.messageId))
    .innerJoin(tables.sessions, eq(tables.sessions.id, tables.messages.sessionId))
    .innerJoin(tables.devices, eq(tables.devices.id, tables.sessions.deviceId))
    .where(and(
      eq(tables.terms.id, termId),
      eq(tables.devices.userId, user.id),
      isNull(tables.terms.userId),
      ne(tables.terms.kind, "keyword"),
    ))
    .limit(1);
  if (!term || !isHighConfidenceTerm(term.term, term.salience)) {
    return Response.json({ error: "term not found" }, { status: 404 });
  }
  return Response.json({ reference: await wikipediaReference(term.term) });
}
