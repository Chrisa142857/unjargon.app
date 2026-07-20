import { and, countDistinct, eq, isNull, ne } from "drizzle-orm";
import { db, tables } from "@/db";
import { requireUser } from "@/lib/auth";
import { isHighConfidenceTerm } from "@/lib/detect";

export const dynamic = "force-dynamic";

// The /wiki dataset: every term with usage counts across machines/sessions.
export async function GET(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  const rows = await db
    .select({
      id: tables.terms.id,
      term: tables.terms.term,
      domain: tables.terms.domain,
      kind: tables.terms.kind,
      l1: tables.terms.l1,
      l3: tables.userTerms.l3,
      salience: tables.terms.salience,
      sightings: countDistinct(tables.termSightings.messageId),
      sessions: countDistinct(tables.messages.sessionId),
      devices: countDistinct(tables.sessions.deviceId),
    })
    .from(tables.terms)
    .leftJoin(
      tables.termSightings,
      eq(tables.termSightings.termId, tables.terms.id),
    )
    .leftJoin(
      tables.messages,
      eq(tables.messages.id, tables.termSightings.messageId),
    )
    .leftJoin(
      tables.sessions,
      eq(tables.sessions.id, tables.messages.sessionId),
    )
    .innerJoin(tables.devices, eq(tables.sessions.deviceId, tables.devices.id))
    .leftJoin(tables.userTerms, and(eq(tables.userTerms.termId, tables.terms.id), eq(tables.userTerms.userId, user.id)))
    .where(and(eq(tables.devices.userId, user.id), isNull(tables.terms.userId), ne(tables.terms.kind, "keyword")))
    .groupBy(tables.terms.id, tables.userTerms.l3);

  const visibleRows = rows.filter((term) =>
    isHighConfidenceTerm(term.term, term.salience),
  );
  visibleRows.sort(
    (a, b) =>
      a.domain.localeCompare(b.domain) || (b.salience ?? 0) - (a.salience ?? 0),
  );

  return Response.json({ terms: visibleRows });
}
