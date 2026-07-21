import { and, count, eq, gte, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db, tables } from "@/db";
import { deviceForRequest } from "@/lib/auth";
import { scheduleDetection } from "@/lib/detection";
import { collectorLimits, wouldExceed } from "@/lib/collector-limits";

export const dynamic = "force-dynamic";

const INSERT_CHUNK = 20; // four bound values each: safely below D1's 100-param limit.
type IngestBody = {
  device: string;
  tool: string;
  session_id: string;
  cwd?: string;
  messages: { ts: string; text: string }[];
};

function bad(status: number, error: string) {
  return Response.json({ error }, { status });
}

function dayStart() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function dedupeKey(sessionId: number, ts: Date, text: string) {
  return createHash("sha256")
    .update(String(sessionId)).update("\0").update(String(ts.getTime())).update("\0").update(text)
    .digest("hex");
}

export async function POST(req: Request) {
  const device = await deviceForRequest(req);
  if (!device) return bad(401, "invalid device token");
  const userId = device.userId as number;

  let body: IngestBody;
  try {
    body = await req.json();
  } catch {
    return bad(400, "invalid JSON");
  }
  if (
    typeof body.device !== "string" || !body.device ||
    typeof body.tool !== "string" || !body.tool ||
    typeof body.session_id !== "string" || !body.session_id ||
    !Array.isArray(body.messages)
  ) {
    return bad(400, "missing device/tool/session_id/messages");
  }
  const msgs = body.messages.filter(
    (m) => m && typeof m.text === "string" && m.text.trim() !== "",
  );
  if (msgs.length === 0) return Response.json({ stored: 0 });

  const today = dayStart();
  const [{ deviceToday, deviceStored }] = await db
    .select({
      deviceToday: count(sql`case when ${tables.messages.createdAt} >= ${today} then 1 end`),
      deviceStored: count(tables.messages.id),
    })
    .from(tables.messages)
    .innerJoin(tables.sessions, eq(tables.messages.sessionId, tables.sessions.id))
    .where(eq(tables.sessions.deviceId, device.id));
  const [{ userToday }] = await db
    .select({ userToday: count(tables.messages.id) })
    .from(tables.messages)
    .innerJoin(tables.sessions, eq(tables.messages.sessionId, tables.sessions.id))
    .innerJoin(tables.devices, eq(tables.sessions.deviceId, tables.devices.id))
    .where(and(eq(tables.devices.userId, userId), gte(tables.messages.createdAt, today)));
  const [{ globalToday, globalStored }] = await db
    .select({
      globalToday: count(sql`case when ${tables.messages.createdAt} >= ${today} then 1 end`),
      globalStored: count(tables.messages.id),
    })
    .from(tables.messages);
  if (
    wouldExceed(Number(deviceToday), msgs.length, collectorLimits.deviceDaily) ||
    wouldExceed(Number(userToday), msgs.length, collectorLimits.userDaily) ||
    wouldExceed(Number(globalToday), msgs.length, collectorLimits.globalDaily) ||
    wouldExceed(Number(deviceStored), msgs.length, collectorLimits.deviceStored) ||
    wouldExceed(Number(globalStored), msgs.length, collectorLimits.globalStored)
  ) {
    const tomorrow = new Date(dayStart().getTime() + 86_400_000);
    return Response.json(
      {
        error: "collector upload paused to protect the shared D1 budget",
        retryAt: tomorrow.toISOString(),
      },
      {
        status: 429,
        headers: { "Retry-After": String(Math.max(60, Math.ceil((tomorrow.getTime() - Date.now()) / 1000))) },
      },
    );
  }

  if (body.device !== device.name) return bad(403, "device name does not match token");
  let [session] = await db
    .insert(tables.sessions)
    .values({
      deviceId: device.id,
      tool: body.tool,
      sessionKey: body.session_id,
      cwd: body.cwd ?? null,
    })
    .onConflictDoNothing()
    .returning();
  if (!session) {
    [session] = await db
      .select()
      .from(tables.sessions)
      .where(and(
        eq(tables.sessions.deviceId, device.id),
        eq(tables.sessions.sessionKey, body.session_id),
      ));
  }
  if (!session) return bad(500, "could not create session");

  const normalized = msgs.map((m) => {
    const ts = isNaN(Date.parse(m.ts)) ? new Date() : new Date(m.ts);
    return {
      sessionId: session.id,
      dedupeKey: dedupeKey(session.id, ts, m.text),
      ts,
      text: m.text,
    };
  });
  const stored: typeof tables.messages.$inferSelect[] = [];
  for (let start = 0; start < normalized.length; start += INSERT_CHUNK) {
    const rows = await db
      .insert(tables.messages)
      .values(normalized.slice(start, start + INSERT_CHUNK))
      .onConflictDoNothing()
      .returning();
    stored.push(...rows);
  }

  // Deliberately ignore any `translation` field sent by an older collector.
  // Detection happens server-side with no AI call and also backfills history.
  if (stored.length > 0) scheduleDetection(userId, true);

  return Response.json({ stored: stored.length });
}
