import { db, tables } from "@/db";
import { publish } from "@/lib/bus";
import {
  scheduleTranslation,
  storeProvidedTranslation,
  type TranslationResult,
} from "@/lib/translate";

export const dynamic = "force-dynamic";

type IngestBody = {
  device: string;
  tool: string;
  session_id: string;
  cwd?: string;
  // translation is present when the collector ran local-translate mode
  // (the user's own AI CLI); the server then skips its own LLM call.
  messages: { ts: string; text: string; translation?: TranslationResult }[];
};

function bad(status: number, error: string) {
  return Response.json({ error }, { status });
}

export async function POST(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!process.env.INGEST_TOKEN || token !== process.env.INGEST_TOKEN) {
    return bad(401, "invalid device token");
  }

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

  const [device] = await db
    .insert(tables.devices)
    .values({ name: body.device })
    .onConflictDoUpdate({
      target: tables.devices.name,
      set: { lastSeenAt: new Date() },
    })
    .returning();

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
      type: "message",
      message: {
        id: row.id,
        sessionId: row.sessionId,
        device: device.name,
        tool: session.tool,
        cwd: session.cwd,
        ts: row.ts.toISOString(),
        text: row.text,
        subtitle: row.subtitle,
      },
    });
  }

  // Collector-provided translations (local-translate mode) store directly;
  // anything without one goes through the server-side pipeline (needs
  // ANTHROPIC_API_KEY or the fake translator).
  let needServerTranslation = false;
  for (let i = 0; i < stored.length; i++) {
    const provided = msgs[i].translation;
    if (provided && typeof provided === "object") {
      await storeProvidedTranslation(stored[i], provided);
    } else {
      needServerTranslation = true;
    }
  }
  if (needServerTranslation) {
    scheduleTranslation(session.id);
  }

  return Response.json({ stored: stored.length });
}
