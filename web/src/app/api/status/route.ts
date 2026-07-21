import { eq } from "drizzle-orm";
import { db, tables } from "@/db";
import { deviceForRequest } from "@/lib/auth";
import { scheduleDetection } from "@/lib/detection";
import { collectorLimits } from "@/lib/collector-limits";

export const dynamic = "force-dynamic";

// Collector-reported optional explanation budget. Detection progress comes
// from D1 and never waits for this budget.
export async function POST(req: Request) {
  const device = await deviceForRequest(req);
  if (!device) return Response.json({ error: "invalid device token" }, { status: 401 });
  let body: { paused_until?: string; budget_used?: number; budget_limit?: number; input_tokens?: number; output_tokens?: number; tokens_reported?: boolean };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const pausedUntil =
    typeof body.paused_until === "string" && !isNaN(Date.parse(body.paused_until))
      ? new Date(body.paused_until).toISOString()
      : null;
  const next = {
    pausedUntil,
    budgetUsed: Number(body.budget_used) || 0,
    budgetLimit: Number(body.budget_limit) || 0,
    inputTokens: Number(body.input_tokens) || 0,
    outputTokens: Number(body.output_tokens) || 0,
    tokensReported: body.tokens_reported === true,
    updatedAt: new Date().toISOString(),
  };
  try {
    const previous = JSON.parse(device.importStatus ?? "") as typeof next;
    const unchanged = previous.pausedUntil === next.pausedUntil && previous.budgetUsed === next.budgetUsed && previous.budgetLimit === next.budgetLimit && previous.inputTokens === next.inputTokens && previous.outputTokens === next.outputTokens && previous.tokensReported === next.tokensReported;
    if (unchanged && Date.now() - Date.parse(previous.updatedAt) < collectorLimits.statusWriteIntervalMs) {
      return Response.json({ ok: true });
    }
  } catch { /* first heartbeat */ }
  await db
    .update(tables.devices)
    .set({ importStatus: JSON.stringify(next), lastSeenAt: new Date() })
    .where(eq(tables.devices.id, device.id));
  // The collector heartbeats even when its history upload is complete. This
  // wakes a parked free-tier backfill after midnight or a Render cold start.
  scheduleDetection(device.userId as number);
  return Response.json({ ok: true });
}
