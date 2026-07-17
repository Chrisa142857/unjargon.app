import { eq } from "drizzle-orm";
import { db, tables } from "@/db";

export const dynamic = "force-dynamic";

// Opening a term card marks the term learned — its chip dims on the board,
// keeping "bright = you haven't looked at this yet" true.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const termId = Number(id);
  if (!Number.isInteger(termId) || termId <= 0) {
    return Response.json({ error: "invalid term id" }, { status: 400 });
  }
  const rows = await db
    .update(tables.terms)
    .set({ learnedAt: new Date() })
    .where(eq(tables.terms.id, termId))
    .returning({ learnedAt: tables.terms.learnedAt });
  if (!rows[0]) {
    return Response.json({ error: "term not found" }, { status: 404 });
  }
  return Response.json({ learnedAt: rows[0].learnedAt });
}
