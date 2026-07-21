import { db, tables } from "@/db";
import { deviceForRequest } from "@/lib/auth";
import { eq } from "drizzle-orm";

// A collector can revoke only itself during local uninstall.
export async function POST(req: Request) {
  const device = await deviceForRequest(req);
  if (!device) return Response.json({ error: "invalid device token" }, { status: 401 });
  await db.update(tables.devices).set({ tokenHash: null, importStatus: null }).where(eq(tables.devices.id, device.id));
  return Response.json({ ok: true });
}
