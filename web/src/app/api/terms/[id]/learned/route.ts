import { eq } from "drizzle-orm";
import { db, tables } from "@/db";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Opening a term card marks the term learned — its chip dims on the board,
// keeping "bright = you haven't looked at this yet" true.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  const { id } = await params;
  const termId = Number(id);
  if (!Number.isInteger(termId) || termId <= 0) {
    return Response.json({ error: "invalid term id" }, { status: 400 });
  }
  const [term] = await db.select({ id: tables.terms.id }).from(tables.terms).where(eq(tables.terms.id, termId));
  if (!term) {
    return Response.json({ error: "term not found" }, { status: 404 });
  }
  const learnedAt = new Date();
  await db.insert(tables.userTerms).values({ userId: user.id, termId, learnedAt }).onConflictDoUpdate({ target: [tables.userTerms.userId, tables.userTerms.termId], set: { learnedAt } });
  return Response.json({ learnedAt });
}
