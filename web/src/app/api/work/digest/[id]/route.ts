import { completeDigestWork } from "@/lib/digest";
import { deviceForRequest } from "@/lib/auth";

export const dynamic = "force-dynamic";

// A collector delivers the summary for a digest chunk it claimed.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const device = await deviceForRequest(req);
  if (!device) {
    return Response.json({ error: "invalid device token" }, { status: 401 });
  }
  const { id } = await params;
  const digestId = Number(id);
  if (!Number.isInteger(digestId) || digestId <= 0) {
    return Response.json({ error: "invalid digest id" }, { status: 400 });
  }
  let body: { summary?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (typeof body.summary !== "string" || body.summary.trim() === "") {
    return Response.json({ error: "summary required" }, { status: 400 });
  }
  const row = await completeDigestWork(digestId, body.summary, device.userId!);
  if (!row) {
    return Response.json(
      { error: "unknown, already completed, or reclaimed digest" },
      { status: 409 },
    );
  }
  return Response.json({ ok: true });
}
