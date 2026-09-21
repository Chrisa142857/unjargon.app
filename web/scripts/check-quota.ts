// Guards the D1 free-plan budget at the query-plan level.
//
// D1 bills rows read, and SQLite answers an unfiltered `count(*)` by walking
// every row. A route that does that is cheap on a laptop and ruinous here: the
// /live poll ran one per request, so a single open tab spent the whole daily
// rows-read allowance within minutes. These assertions fail if a hot-path query
// goes back to scanning `messages`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { and, count, eq, gte, inArray, max, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as tables from "../src/db/schema.ts";

const sqlite = new DatabaseSync(":memory:");
sqlite.exec("PRAGMA foreign_keys = ON");
sqlite.exec(readFileSync(new URL("../d1/0000_init.sql", import.meta.url), "utf8"));

const executed: string[] = [];
const db = drizzle(async (sql, params, method) => {
  executed.push(sql);
  const statement = sqlite.prepare(sql);
  if (method === "run") {
    statement.run(...params);
    return { rows: [] };
  }
  const rows = statement.all(...params).map(Object.values);
  return { rows: method === "get" ? (rows[0] ?? null) : rows } as { rows: never[] };
}, { schema: tables });

// `EXPLAIN QUERY PLAN` names a full walk `SCAN <table>` and an index lookup
// `SEARCH <table>`, so the distinction we care about is readable directly.
function assertNoMessageScan(label: string, sqlText: string, params: unknown[]) {
  const plan = sqlite
    .prepare(`EXPLAIN QUERY PLAN ${sqlText}`)
    .all(...(params as never[]))
    .map((row) => (row as { detail: string }).detail)
    .join("\n");
  assert(
    !/SCAN (messages|"messages")\b/i.test(plan),
    `${label} must not scan every message row, but its plan does:\n${plan}`,
  );
  return plan;
}

async function capture(run: () => Promise<unknown>) {
  executed.length = 0;
  await run();
  assert.equal(executed.length, 1, `expected one statement, got ${executed.length}`);
  return executed[0];
}

const day = new Date("2026-09-21T00:00:00.000Z");

const [user] = await db.insert(tables.users).values({ googleSub: "sub", email: "u@example.test" }).returning();
const [device] = await db.insert(tables.devices).values({ userId: user.id, name: "laptop", tokenHash: "hash" }).returning();
const [session] = await db.insert(tables.sessions).values({ deviceId: device.id, tool: "codex", sessionKey: "s" }).returning();
await db.insert(tables.messages).values(
  Array.from({ length: 400 }, (_, i) => ({
    sessionId: session.id,
    dedupeKey: `dedupe-${i}`,
    ts: new Date(day.getTime() + i * 1000),
    text: `message ${i}`,
    detectedAt: i < 40 ? new Date(day.getTime() + i * 1000) : null,
  })),
);

// --- the counter reads and writes that replaced the scans --------------------

const keys = ["msgs_stored", "msgs_day_2026-09-21", `dev_stored_${device.id}`];
const readSql = await capture(() =>
  db.select({ key: tables.settings.key, value: tables.settings.value })
    .from(tables.settings)
    .where(inArray(tables.settings.key, keys)),
);
assert(/settings/.test(readSql), "counter read must come from settings");

const upsert = (mode: "add" | "set", rows: { key: string; value: string }[]) =>
  db.insert(tables.settings).values(rows).onConflictDoUpdate({
    target: tables.settings.key,
    set: {
      value: mode === "add"
        ? sql`cast(${tables.settings.value} as integer) + cast(excluded."value" as integer)`
        : sql`excluded."value"`,
    },
  });

await upsert("set", [{ key: "msgs_stored", value: "400" }, { key: `dev_stored_${device.id}`, value: "400" }]);
await upsert("add", [{ key: "msgs_stored", value: "20" }, { key: "msgs_day_2026-09-21", value: "20" }]);
await upsert("add", [{ key: "msgs_stored", value: "20" }, { key: "msgs_day_2026-09-21", value: "20" }]);

// node:sqlite hands back null-prototype rows; compare them as plain objects.
const stored = (sqlite.prepare("SELECT key, value FROM settings ORDER BY key").all() as { key: string; value: string }[])
  .map((row) => ({ key: row.key, value: row.value }));
assert.deepEqual(stored, [
  { key: `dev_stored_${device.id}`, value: "400" },
  { key: "msgs_day_2026-09-21", value: "40" },
  { key: "msgs_stored", value: "440" },
], "a bump must add to the existing value and a set must replace it");

// A `set` over an existing key must not accumulate.
await upsert("set", [{ key: "msgs_stored", value: "500" }]);
assert.equal(
  (sqlite.prepare("SELECT value FROM settings WHERE key = 'msgs_stored'").all() as { value: string }[])[0].value,
  "500",
);

// --- hot-path query plans ----------------------------------------------------

assertNoMessageScan("the counter read", readSql, [...keys]);

const watermarkSql = await capture(() =>
  db.select({ newestMessageId: max(tables.messages.id) }).from(tables.messages),
);
assertNoMessageScan("the /live watermark", watermarkSql, []);

const detectedTodaySql = await capture(() =>
  db.select({ detectedToday: count(tables.messages.id) })
    .from(tables.messages)
    .where(gte(tables.messages.detectedAt, day)),
);
assertNoMessageScan("the daily detection counter", detectedTodaySql, [day.getTime()]);

// The recounts in lib/counters.ts run at most once per key, but the day-scoped
// ones still have to stay off a full walk: they reseed every UTC midnight.
const serviceDaySql = await capture(() =>
  db.select({ value: count(tables.messages.id) })
    .from(tables.messages)
    .where(gte(tables.messages.createdAt, day)),
);
assertNoMessageScan("the service daily reseed", serviceDaySql, [day.getTime()]);

const deviceDaySql = await capture(() =>
  db.select({ value: count(tables.messages.id) })
    .from(tables.messages)
    .innerJoin(tables.sessions, eq(tables.messages.sessionId, tables.sessions.id))
    .where(and(eq(tables.sessions.deviceId, device.id), gte(tables.messages.createdAt, day))),
);
assertNoMessageScan("the device daily reseed", deviceDaySql, [device.id, day.getTime()]);

// --- the shape this check exists to keep out ---------------------------------

// The guards used to be written this way, once per ingest chunk and once per
// /live poll. Asserting that it really does scan keeps the checks above honest:
// without it they would still pass if EXPLAIN stopped saying "SCAN".
const scanned = sqlite
  .prepare(`EXPLAIN QUERY PLAN SELECT count(CASE WHEN created_at >= ? THEN 1 END), count(id) FROM messages`)
  .all(day.getTime())
  .map((row) => (row as { detail: string }).detail)
  .join("\n");
assert(/SCAN (messages|"messages")\b/i.test(scanned), `the pre-fix query should scan, but planned as:\n${scanned}`);

sqlite.close();
console.log("D1 quota check passed");
