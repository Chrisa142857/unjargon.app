import { countDistinct, eq } from "drizzle-orm";
import { db, tables } from "@/db";

export const dynamic = "force-dynamic";

// The /wiki dataset: every term with usage counts across machines/sessions.
export async function GET() {
  const rows = await db
    .select({
      id: tables.terms.id,
      term: tables.terms.term,
      domain: tables.terms.domain,
      kind: tables.terms.kind,
      l1: tables.terms.l1,
      l2: tables.terms.l2,
      l3: tables.terms.l3,
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
    .groupBy(tables.terms.id);

  rows.sort(
    (a, b) =>
      a.domain.localeCompare(b.domain) || (b.salience ?? 0) - (a.salience ?? 0),
  );

  return Response.json({ terms: rows });
}
