import { db, tables } from "@/db";
import { hash, requireUser, token } from "@/lib/auth";

export const dynamic = "force-dynamic";

// One short-lived code is enough: the installer exchanges it for a device-only secret.
export async function POST(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  const code = token().slice(0, 12);
  const expiresAt = new Date(Date.now() + 10 * 60_000);
  await db.insert(tables.pairings).values({ codeHash: hash(code), userId: user.id, expiresAt }).onConflictDoNothing();
  return Response.json({ code, expiresAt: expiresAt.toISOString() });
}
