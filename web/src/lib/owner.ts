import { eq } from "drizzle-orm";
import { db, tables } from "@/db";

export async function sessionUserId(sessionId: number) {
  const [row] = await db.select({ userId: tables.devices.userId }).from(tables.sessions).innerJoin(tables.devices, eq(tables.sessions.deviceId, tables.devices.id)).where(eq(tables.sessions.id, sessionId));
  return row?.userId ?? null;
}
