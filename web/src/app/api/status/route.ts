import { eq } from "drizzle-orm";
import { db, tables } from "@/db";
import { deviceForRequest } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Collector-reported import status. Totals, completed counts, and rate come
// from Postgres itself (the message table is the queue); this endpoint
// carries only what the server cannot know — whether the device's local AI
// budget is spent, and until when.
export async function POST(req: Request) {
  const device = await deviceForRequest(req);
  if (!device) return Response.json({ error: "invalid device token" }, { status: 401 });
  let body: { paused_until?: string; budget_used?: number; budget_limit?: number };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const pausedUntil =
    typeof body.paused_until === "string" && !isNaN(Date.parse(body.paused_until))
      ? new Date(body.paused_until).toISOString()
      : null;
  const status = JSON.stringify({
    pausedUntil,
    budgetUsed: Number(body.budget_used) || 0,
    budgetLimit: Number(body.budget_limit) || 0,
    updatedAt: new Date().toISOString(),
  });
  await db
    .update(tables.devices)
    .set({ importStatus: status, lastSeenAt: new Date() })
    .where(eq(tables.devices.id, device.id));
  return Response.json({ ok: true });
}
