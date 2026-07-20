import { expandTerm } from "@/lib/expand";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

// GET is read-only status polling. POST always needs an explicit action;
// merely opening a detected term must never trigger an AI call.
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
  const result = await expandTerm(termId, user.id);
  return result
    ? Response.json(result)
    : Response.json({ error: "term not found" }, { status: 404 });
}

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
  let action: "concept" | "grounding" | undefined;
  try {
    const body = await req.json();
    if (Number.isInteger(body?.messageId)) messageId = body.messageId;
    if (body?.action === "concept" || body?.action === "grounding") action = body.action;
  } catch {
    return Response.json({ error: "missing explicit action" }, { status: 400 });
  }
  if (!action) return Response.json({ error: "missing explicit action" }, { status: 400 });

  try {
    const result = await expandTerm(termId, user.id, {
      sourceMessageId: messageId,
      action,
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
