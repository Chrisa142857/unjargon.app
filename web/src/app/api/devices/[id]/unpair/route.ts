import { and, eq } from "drizzle-orm";
import { db, tables } from "@/db";
import { requireUser } from "@/lib/auth";
import { retireUndetectedBacklog } from "@/lib/detection";

export const dynamic = "force-dynamic";

// Revoking the device secret stops collection but deliberately keeps its term
// history in /wiki. Re-pairing the same machine creates a fresh secret.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "invalid device" }, { status: 400 });
  const updated = await db
    .update(tables.devices)
    .set({ tokenHash: null, importStatus: null })
    .where(and(eq(tables.devices.id, id), eq(tables.devices.userId, user.id)))
    .returning({ id: tables.devices.id });
  if (!updated.length) return Response.json({ error: "device not found" }, { status: 404 });
  await retireUndetectedBacklog(id);
  return Response.json({ ok: true });
}
