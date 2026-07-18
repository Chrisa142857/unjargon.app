import { expandTerm } from "@/lib/expand";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Lazy expansion for a term card. Default: the shared generic layer (L2)
// only — no per-user AI spend. Body {level: "grounding"} explicitly requests
// the in-context L3 (an AI call over the user's own stream); {messageId}
// grounds it in the exact message the user tapped from.
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

  let messageId: number | undefined;
  let grounding = false;
  try {
    const body = await req.json();
    if (Number.isInteger(body?.messageId)) messageId = body.messageId;
    grounding = body?.level === "grounding";
  } catch {
    // empty body is fine
  }

  try {
    const result = await expandTerm(termId, user.id, {
      sourceMessageId: messageId,
      grounding,
    });
    if (!result) {
      return Response.json({ error: "term not found" }, { status: 404 });
    }
    return Response.json(result);
  } catch (err) {
    console.error(`[expand] term ${termId} failed:`, err);
    return Response.json({ error: "expansion failed" }, { status: 502 });
  }
}
