import { deviceForRequest } from "@/lib/auth";
import { completeExpansionWork } from "@/lib/expand";

export const dynamic = "force-dynamic";

// Deliver one completed, user-confirmed in-session explanation and drop its
// queue row. Shared generic AI explanations are not supported.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const device = await deviceForRequest(req);
  if (!device) return Response.json({ error: "invalid device token" }, { status: 401 });
  const { id } = await params;
  const workId = Number(id);
  if (!Number.isInteger(workId) || workId <= 0) {
    return Response.json({ error: "invalid work id" }, { status: 400 });
  }
  let body: { text?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (typeof body.text !== "string") {
    return Response.json({ error: "missing text" }, { status: 400 });
  }
  const ok = await completeExpansionWork(workId, device.userId!, body.text);
  if (!ok) return Response.json({ error: "unknown or empty work" }, { status: 404 });
  return Response.json({ ok: true });
}
