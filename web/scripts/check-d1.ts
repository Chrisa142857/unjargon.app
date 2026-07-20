import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { and, count, eq, max, min } from "drizzle-orm";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as tables from "../src/db/schema.ts";

const sqlite = new DatabaseSync(":memory:");
sqlite.exec("PRAGMA foreign_keys = ON");
sqlite.exec(readFileSync(new URL("../d1/0000_init.sql", import.meta.url), "utf8"));

const db = drizzle(async (sql, params, method) => {
  const statement = sqlite.prepare(sql);
  if (method === "run") {
    statement.run(...params);
    return { rows: [] };
  }
  const rows = statement.all(...params).map(Object.values);
  return { rows: method === "get" ? (rows[0] ?? null) : rows } as { rows: never[] };
}, { schema: tables });

const now = new Date("2026-07-20T12:00:00.000Z");
const [user] = await db
  .insert(tables.users)
  .values({ googleSub: "google-sub", email: "user@example.test" })
  .onConflictDoUpdate({ target: tables.users.googleSub, set: { email: "user@example.test" } })
  .returning();
assert.equal(user.id, 1);

const [device] = await db
  .insert(tables.devices)
  .values({ userId: user.id, name: "laptop", tokenHash: "hash" })
  .returning();
const [session] = await db
  .insert(tables.sessions)
  .values({ deviceId: device.id, tool: "codex", sessionKey: "session", cwd: "/tmp/project" })
  .onConflictDoUpdate({ target: [tables.sessions.deviceId, tables.sessions.sessionKey], set: { sessionKey: "session" } })
  .returning();

const messages = Array.from({ length: 20 }, (_, id) => ({
  sessionId: session.id,
  dedupeKey: `message-${id}`,
  ts: new Date(now.getTime() + id),
  text: `message ${id}`,
}));
const stored = await db.insert(tables.messages).values(messages).returning();
assert.equal(stored.length, 20);
assert(stored[0].ts instanceof Date);
assert.equal(stored[0].ts.toISOString(), now.toISOString());
assert.equal((await db.insert(tables.messages).values(messages).onConflictDoNothing().returning()).length, 0);

const termValues = { key: "bdf", term: "BDF", domain: "Technical vocabulary", l1: "Detected." };
assert.equal((await db.insert(tables.terms).values(termValues).returning()).length, 1);
assert.equal((await db.insert(tables.terms).values(termValues).onConflictDoNothing().returning()).length, 0);
const [term] = await db.select().from(tables.terms).where(eq(tables.terms.key, "bdf"));
await db.insert(tables.termSightings).values({ termId: term.id, messageId: stored[0].id });
await db.insert(tables.annotations).values({ messageId: stored[0].id, termId: term.id, span: "BDF", sentenceRewrite: "Detected." });
await db.insert(tables.expansionRequests).values({ termId: term.id, userId: user.id, grounding: true });
assert.equal((await db.insert(tables.expansionRequests).values({ termId: term.id, userId: user.id, grounding: true }).onConflictDoNothing().returning()).length, 0);

const [aggregate] = await db
  .select({
    messages: count(tables.messages.id),
    first: min(tables.messages.ts).mapWith(tables.messages.ts),
    last: max(tables.messages.ts).mapWith(tables.messages.ts),
  })
  .from(tables.messages)
  .where(and(eq(tables.messages.sessionId, session.id)));
assert.equal(Number(aggregate.messages), 20);
assert(aggregate.first instanceof Date && aggregate.last instanceof Date);
assert.equal(aggregate.first.toISOString(), now.toISOString());

assert.throws(
  () => sqlite.prepare("INSERT INTO pairings (code_hash, user_id, expires_at) VALUES ('bad', 999, 0)").run(),
  /FOREIGN KEY/,
);
sqlite.close();
console.log("D1 schema/proxy check passed");
