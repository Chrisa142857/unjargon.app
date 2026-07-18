import { eq } from "drizzle-orm";
import { db, tables } from "@/db";
import { deviceForRequest } from "@/lib/auth";
import { publish } from "@/lib/bus";
import { scheduleDigestCheck } from "@/lib/digest";
import { recordKnownSightings } from "@/lib/glossary";
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

  // Shared-glossary pass (no AI): terms other users already paid to extract
  // surface on this user's board immediately, even before any translation.
  await recordKnownSightings(stored);

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
  } else {
    scheduleDigestCheck(session.id); // everything translated; roll up if due
  }

  return Response.json({ stored: stored.length });
}
