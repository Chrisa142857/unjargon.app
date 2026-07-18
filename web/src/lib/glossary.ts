import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db, tables } from "@/db";

// The shared jargon knowledge base. Generic vocabulary ("term"/"initial"
// kinds, terms.user_id NULL) is global, so one user's AI spend teaches every
// user: a message that mentions an already-known term surfaces it on its
// owner's board with ZERO AI calls, straight from ingest.
//
// Privacy boundary: "keyword" terms (file names, commands, internal artifact
// names) carry terms.user_id and are only ever matched for their owner —
// project-specific strings and their explanations never cross users. Which
// messages sighted a term (owner-filtered reads) and L3/learned state
// (user_terms) are per-user too; only generic explanations are shared.

// Terms visible to this user (shared vocabulary + their own private
// keywords) that literally appear in this text.
export async function termsInText(
  text: string,
  userId: number,
): Promise<{ id: number; term: string }[]> {
  // ponytail: full-glossary position() scan per message — fine for thousands
  // of terms; move to trigram/FTS matching if the shared glossary outgrows it.
  const candidates = await db
    .select({ id: tables.terms.id, term: tables.terms.term })
    .from(tables.terms)
    .where(
      and(
        or(isNull(tables.terms.userId), eq(tables.terms.userId, userId)),
        sql`position(lower(${tables.terms.term}) in lower(${text})) > 0`,
      ),
    );
  // Word-boundary check so "RK4" doesn't match inside "RK45".
  return candidates.filter((t) =>
    new RegExp(
      `(^|[^A-Za-z0-9])${escapeRegExp(t.term)}($|[^A-Za-z0-9])`,
      "i",
    ).test(text),
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Record sightings of known terms in freshly ingested messages — the no-AI
// path that fills a new user's board from the shared glossary immediately,
// even while their collector is budget-paused or has no AI CLI at all.
export async function recordKnownSightings(
  messages: { id: number; text: string }[],
  userId: number,
): Promise<void> {
  for (const m of messages) {
    const matched = await termsInText(m.text, userId);
    if (matched.length === 0) continue;
    await db
      .insert(tables.termSightings)
      .values(matched.map((t) => ({ termId: t.id, messageId: m.id })))
      .onConflictDoNothing();
  }
}
