import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, tables } from "@/db";

const cookieName = "unjargon_session";
const secret = () => process.env.AUTH_SECRET ?? "";
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const token = () => randomBytes(32).toString("base64url");

export async function deviceForRequest(req: Request) {
  const raw = req.headers.get("authorization") ?? "";
  const value = raw.startsWith("Bearer ") ? raw.slice(7) : "";
  if (!value) return null;
  const [device] = await db.select().from(tables.devices).where(eq(tables.devices.tokenHash, hash(value)));
  return device?.userId ? device : null;
}

function sign(value: string) {
  return createHmac("sha256", secret()).update(value).digest("base64url");
}

function cookie(req: Request, name: string) {
  return (req.headers.get("cookie") ?? "").split("; ").find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);
}

export function sessionCookie(userId: number) {
  if (!secret()) throw new Error("AUTH_SECRET is not set");
  const value = Buffer.from(JSON.stringify({ userId, exp: Date.now() + 30 * 864e5 })).toString("base64url");
  return `${cookieName}=${value}.${sign(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`;
}

export async function currentUser(req: Request) {
  const raw = cookie(req, cookieName);
  if (!raw || !secret()) return null;
  const [value, mac] = raw.split(".");
  if (!value || !mac) return null;
  const expected = sign(value);
  if (mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(value, "base64url").toString()) as { userId?: number; exp?: number };
    const userId = data.userId;
    if (!Number.isInteger(userId) || !data.exp || data.exp < Date.now()) return null;
    const [user] = await db.select().from(tables.users).where(eq(tables.users.id, userId as number));
    return user ?? null;
  } catch { return null; }
}

export async function requireUser(req: Request) {
  const user = await currentUser(req);
  return user ?? Response.json({ error: "sign in required" }, { status: 401 });
}
