import { eq } from "drizzle-orm";
import { db, tables } from "@/db";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

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
  const [term] = await db.select({ id: tables.terms.id, userId: tables.terms.userId }).from(tables.terms).where(eq(tables.terms.id, termId));
  // Another user's private keyword is invisible — same 404 as expand.
  if (!term || (term.userId !== null && term.userId !== user.id)) {
    return Response.json({ error: "term not found" }, { status: 404 });
  }
  const body = await req.json().catch(() => ({})) as { learned?: unknown };
  const learned = body.learned !== false;
  const learnedAt = learned ? new Date() : null;
  await db.insert(tables.userTerms).values({ userId: user.id, termId, learnedAt }).onConflictDoUpdate({ target: [tables.userTerms.userId, tables.userTerms.termId], set: { learnedAt } });
  return Response.json({ learnedAt });
}
