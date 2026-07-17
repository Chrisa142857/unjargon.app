import Anthropic from "@anthropic-ai/sdk";
import { and, asc, desc, eq, gt, isNotNull, lt, max, sql } from "drizzle-orm";
import { db, tables } from "@/db";
import { publish } from "@/lib/bus";
import { sessionUserId } from "@/lib/owner";
import {
  TRANSLATION_MODEL,
  digestSystemPrompt,
  digestTool,
  digestUserPrompt,
  localDigestPrompt,
} from "@/lib/prompts";

// Digests collapse hours/days of stream into rollup cards. A digest covers a
// contiguous run of already-translated messages, built from their SUBTITLES
// (already compressed) — so a whole afternoon rolls up in one small call.
//
// Who generates them mirrors translation: the server does when it can call an
// LLM itself (ANTHROPIC_API_KEY or the fake translator); otherwise collectors
// in local-translate mode fetch pending digest work from GET /api/work/digest
// and run it with the user's own AI CLI.

const TAIL = 12; // newest messages per session always stay as full subtitles
const MIN_CHUNK = 12; // don't roll up until this many older messages exist
const MAX_CHUNK = 40; // one digest covers at most this many messages
const CLAIM_TTL_MS = 5 * 60_000;
const LINE_MAX = 300;

export type DigestRow = typeof tables.digests.$inferSelect;

export function serverCanLLM(): boolean {
  return (
    process.env.UNJARGON_FAKE_TRANSLATOR === "1" ||
    !!process.env.ANTHROPIC_API_KEY
  );
}

// --- chunk discovery --------------------------------------------------------

type ChunkMessage = {
  id: number;
  ts: Date;
  text: string;
  subtitle: string | null;
};

// Oldest run of translated messages in this session that is (a) not yet
// covered by a digest and (b) entirely outside the live tail. Null until
// MIN_CHUNK of them have accumulated.
async function findNextChunk(sessionId: number): Promise<ChunkMessage[] | null> {
  const [cover] = await db
    .select({ maxTo: max(tables.digests.toMessageId) })
    .from(tables.digests)
    .where(eq(tables.digests.sessionId, sessionId));
  const coveredTo = cover?.maxTo ?? 0;

  // The live tail: newest TAIL message ids in the session stay uncollapsed.
  const tailRows = await db
    .select({ id: tables.messages.id })
    .from(tables.messages)
    .where(eq(tables.messages.sessionId, sessionId))
    .orderBy(desc(tables.messages.id))
    .limit(TAIL);
  if (tailRows.length < TAIL) return null;
  const tailStart = tailRows[tailRows.length - 1].id;

  const eligible = await db
    .select({
      id: tables.messages.id,
      ts: tables.messages.ts,
      text: tables.messages.text,
      subtitle: tables.messages.subtitle,
    })
    .from(tables.messages)
    .where(
      and(
        eq(tables.messages.sessionId, sessionId),
        isNotNull(tables.messages.translatedAt),
        gt(tables.messages.id, coveredTo),
        lt(tables.messages.id, tailStart),
      ),
    )
    .orderBy(asc(tables.messages.id))
    .limit(MAX_CHUNK);

  return eligible.length >= MIN_CHUNK ? eligible : null;
}

function chunkLines(chunk: ChunkMessage[]): string[] {
  return chunk.map((m) => {
    const t = m.ts.toISOString().slice(11, 16);
    const body = (m.subtitle ?? m.text).replace(/\s+/g, " ").slice(0, LINE_MAX);
    return `[${t}] ${body}`;
  });
}

async function projectNameOf(sessionId: number): Promise<string | null> {
  const [session] = await db
    .select({ cwd: tables.sessions.cwd })
    .from(tables.sessions)
    .where(eq(tables.sessions.id, sessionId));
  return session?.cwd?.split("/").filter(Boolean).pop() ?? null;
}

async function insertDigest(
  sessionId: number,
  chunk: ChunkMessage[],
  summary: string,
): Promise<DigestRow | null> {
  const rows = await db
    .insert(tables.digests)
    .values({
      sessionId,
      fromMessageId: chunk[0].id,
      toMessageId: chunk[chunk.length - 1].id,
      fromTs: chunk[0].ts,
      toTs: chunk[chunk.length - 1].ts,
      messageCount: chunk.length,
      summary,
    })
    .onConflictDoNothing() // another worker beat us to this chunk
    .returning();
  return rows[0] ?? null;
}

async function publishDigest(row: DigestRow) {
  const userId = await sessionUserId(row.sessionId);
  if (!userId) return;
  publish({
    userId,
    type: "digest",
    digest: {
      id: row.id,
      sessionId: row.sessionId,
      fromMessageId: row.fromMessageId,
      toMessageId: row.toMessageId,
      fromTs: row.fromTs.toISOString(),
      toTs: row.toTs.toISOString(),
      messageCount: row.messageCount,
      summary: row.summary,
    },
  });
}

// --- server-side generation (key or fake translator present) ---------------

const globalForDigest = globalThis as unknown as {
  __unjargonDigesting?: Set<number>;
};
const digesting = (globalForDigest.__unjargonDigesting ??= new Set());

// Fire-and-forget: called after translations land for a session.
export function scheduleDigestCheck(sessionId: number) {
  if (!serverCanLLM()) return; // collectors will pick the work up instead
  if (digesting.has(sessionId)) return;
  digesting.add(sessionId);
  (async () => {
    try {
      for (;;) {
        const chunk = await findNextChunk(sessionId);
        if (!chunk) return;
        const summary = await generateDigest(sessionId, chunk);
        const row = await insertDigest(sessionId, chunk, summary);
        if (row) await publishDigest(row);
      }
    } catch (err) {
      console.error(`[digest] session ${sessionId} failed:`, err);
    } finally {
      digesting.delete(sessionId);
    }
  })();
}

async function generateDigest(
  sessionId: number,
  chunk: ChunkMessage[],
): Promise<string> {
  const lines = chunkLines(chunk);
  if (process.env.UNJARGON_FAKE_TRANSLATOR === "1") {
    console.warn("[digest] UNJARGON_FAKE_TRANSLATOR=1 — offline fake digest, NOT the real model");
    return (
      `${chunk.length} agent updates rolled up. Started: ` +
      `${(chunk[0].subtitle ?? chunk[0].text).slice(0, 120)} Ended: ` +
      `${(chunk[chunk.length - 1].subtitle ?? chunk[chunk.length - 1].text).slice(0, 120)} (offline fake digest)`
    );
  }
  const client = new Anthropic();
  const resp = await client.messages.create({
    model: TRANSLATION_MODEL,
    max_tokens: 500,
    system: digestSystemPrompt(),
    messages: [
      {
        role: "user",
        content: digestUserPrompt({
          projectName: await projectNameOf(sessionId),
          lines,
        }),
      },
    ],
    tools: [digestTool],
    tool_choice: { type: "tool", name: "emit_digest" },
  });
  const block = resp.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new Error("no tool_use block in digest response");
  }
  const summary = (block.input as { summary?: string }).summary?.trim();
  if (!summary) throw new Error("empty digest summary");
  return summary;
}

// --- collector work queue (default no-key deployments) ---------------------

// Claim the next pending digest chunk for a collector worker. Creates a
// placeholder row (summary '') so no one else claims the same chunk; stale
// claims are reaped after CLAIM_TTL_MS.
export async function claimDigestWork(userId: number): Promise<
  { id: number; prompt: string } | null
> {
  await db
    .delete(tables.digests)
    .where(
      and(
        eq(tables.digests.summary, ""),
        lt(tables.digests.createdAt, new Date(Date.now() - CLAIM_TTL_MS)),
      ),
    );

  // Sessions with the most recent activity first.
  const sessions = await db
    .select({ sessionId: tables.messages.sessionId })
    .from(tables.messages)
    .innerJoin(tables.sessions, eq(tables.messages.sessionId, tables.sessions.id))
    .innerJoin(tables.devices, eq(tables.sessions.deviceId, tables.devices.id))
    .where(eq(tables.devices.userId, userId))
    .groupBy(tables.messages.sessionId)
    .orderBy(desc(sql`max(${tables.messages.id})`))
    .limit(20);

  for (const { sessionId } of sessions) {
    const chunk = await findNextChunk(sessionId);
    if (!chunk) continue;
    const row = await insertDigest(sessionId, chunk, "");
    if (!row) continue; // raced with another worker
    return {
      id: row.id,
      prompt: localDigestPrompt({
        projectName: await projectNameOf(sessionId),
        lines: chunkLines(chunk),
      }),
    };
  }
  return null;
}

export async function completeDigestWork(
  id: number,
  summary: string,
  userId: number,
): Promise<DigestRow | null> {
  const trimmed = summary.trim().slice(0, 2000);
  if (!trimmed) return null;
  const rows = await db
    .update(tables.digests)
    .set({ summary: trimmed })
    .where(and(eq(tables.digests.id, id), eq(tables.digests.summary, ""), sql`${tables.digests.sessionId} in (select ${tables.sessions.id} from ${tables.sessions} join ${tables.devices} on ${tables.sessions.deviceId} = ${tables.devices.id} where ${tables.devices.userId} = ${userId})`))
    .returning();
  if (!rows[0]) return null;
  publishDigest(rows[0]);
  return rows[0];
}
