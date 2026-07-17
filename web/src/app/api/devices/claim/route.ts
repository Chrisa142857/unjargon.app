import { and, eq, gt } from "drizzle-orm";
import { db, tables } from "@/db";
import { hash, token } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const form = await req.formData();
  const code = form.get("code"), name = form.get("device");
  if (typeof code !== "string" || typeof name !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(name)) return new Response("invalid pairing code or device name", { status: 400 });
  const [pairing] = await db.select().from(tables.pairings).where(and(eq(tables.pairings.codeHash, hash(code)), gt(tables.pairings.expiresAt, new Date())));
  if (!pairing) return new Response("pairing code is invalid or expired", { status: 401 });
  const deviceToken = token();
  await db.insert(tables.devices).values({ userId: pairing.userId, name, tokenHash: hash(deviceToken) }).onConflictDoUpdate({ target: [tables.devices.userId, tables.devices.name], set: { tokenHash: hash(deviceToken), lastSeenAt: new Date() } });
  await db.delete(tables.pairings).where(eq(tables.pairings.codeHash, pairing.codeHash));
  return new Response(deviceToken, { headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
}
