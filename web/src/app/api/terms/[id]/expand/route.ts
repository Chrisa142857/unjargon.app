import { expandTerm } from "@/lib/expand";

export const dynamic = "force-dynamic";

// Lazy L2/L3 for a term card. Body may carry {messageId} so L3 is grounded
// in the exact message the user tapped from.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const termId = Number(id);
  if (!Number.isInteger(termId) || termId <= 0) {
    return Response.json({ error: "invalid term id" }, { status: 400 });
  }

  let messageId: number | undefined;
  try {
    const body = await req.json();
    if (Number.isInteger(body?.messageId)) messageId = body.messageId;
  } catch {
    // empty body is fine
  }

  try {
    const result = await expandTerm(termId, messageId);
    if (!result) {
      return Response.json({ error: "term not found" }, { status: 404 });
    }
    return Response.json(result);
  } catch (err) {
    console.error(`[expand] term ${termId} failed:`, err);
    return Response.json({ error: "expansion failed" }, { status: 502 });
  }
}
