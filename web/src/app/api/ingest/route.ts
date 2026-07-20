import { count, eq, gte } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db, tables } from "@/db";
import { deviceForRequest } from "@/lib/auth";
import { publish } from "@/lib/bus";
import { scheduleDetection } from "@/lib/detection";

export const dynamic = "force-dynamic";

const INSERT_CHUNK = 20; // four bound values each: safely below D1's 100-param limit.
const dailyIngestLimit = (() => {
  // Conservative Free-plan default. Increase only after checking D1 Row Metrics.
  const value = Number(process.env.D1_DAILY_INGEST_MESSAGES ?? 4_000);
  return Number.isInteger(value) && value > 0 ? value : 4_000;
})();

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

  const [{ today }] = await db
    .select({ today: count(tables.messages.id) })
    .from(tables.messages)
    .where(gte(tables.messages.createdAt, dayStart()));
  if (Number(today) + msgs.length > dailyIngestLimit) {
    const tomorrow = new Date(dayStart().getTime() + 86_400_000);
    return Response.json(
      {
        error: "history import pauses before Cloudflare D1's free daily write limit",
        retryAt: tomorrow.toISOString(),
      },
      {
        status: 429,
        headers: { "Retry-After": String(Math.max(60, Math.ceil((tomorrow.getTime() - Date.now()) / 1000))) },
      },
    );
  }

  if (body.device !== device.name) return bad(403, "device name does not match token");
  await db.update(tables.devices).set({ lastSeenAt: new Date() }).where(eq(tables.devices.id, device.id));

  const [session] = await db
    .insert(tables.sessions)
    .values({
      deviceId: device.id,
      tool: body.tool,
      sessionKey: body.session_id,
      cwd: body.cwd ?? null,
    })
    .onConflictDoUpdate({
      // no-op update so .returning() yields the existing row
      target: [tables.sessions.deviceId, tables.sessions.sessionKey],
      set: { sessionKey: body.session_id },
    })
    .returning();

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

  for (const row of stored) {
    publish({
      userId,
      type: "message",
      message: {
        id: row.id,
        sessionId: row.sessionId,
        device: device.name,
        tool: session.tool,
        cwd: session.cwd,
        ts: row.ts.toISOString(),
        text: row.text,
      },
    });
  }

  // Deliberately ignore any `translation` field sent by an older collector.
  // Detection happens server-side with no AI call and also backfills history.
  scheduleDetection(userId);

  return Response.json({ stored: stored.length });
}
