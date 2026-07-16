import { desc, eq } from "drizzle-orm";
import { db, tables } from "@/db";
import LiveStream, { type LiveMessage } from "./stream";

export const dynamic = "force-dynamic";

export default async function LivePage() {
  const rows = await db
    .select({
      id: tables.messages.id,
      sessionId: tables.messages.sessionId,
      ts: tables.messages.ts,
      text: tables.messages.text,
      subtitle: tables.messages.subtitle,
      device: tables.devices.name,
      tool: tables.sessions.tool,
      cwd: tables.sessions.cwd,
    })
    .from(tables.messages)
    .innerJoin(tables.sessions, eq(tables.messages.sessionId, tables.sessions.id))
    .innerJoin(tables.devices, eq(tables.sessions.deviceId, tables.devices.id))
    .orderBy(desc(tables.messages.id))
    .limit(100);

  const initial: LiveMessage[] = rows.reverse().map((r) => ({
    ...r,
    ts: r.ts.toISOString(),
  }));

  return <LiveStream initial={initial} />;
}
