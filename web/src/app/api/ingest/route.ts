import { eq } from "drizzle-orm";
import { db, tables } from "@/db";
import { deviceForRequest } from "@/lib/auth";
import { publish } from "@/lib/bus";
import { scheduleDetection } from "@/lib/detection";

export const dynamic = "force-dynamic";

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

  const stored = await db
    .insert(tables.messages)
    .values(
      msgs.map((m) => ({
        sessionId: session.id,
        ts: isNaN(Date.parse(m.ts)) ? new Date() : new Date(m.ts),
        text: m.text,
      })),
    )
    .returning();

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
