import { and, count, eq, gte, inArray, sql } from "drizzle-orm";
import { db, tables } from "@/db";

// Running totals for the D1 free-plan guards, kept in the `settings` key/value
// table. The guards used to recompute themselves with `count(*)` over the whole
// `messages` table, which SQLite can only answer by scanning every row — on D1
// that scan is billed as rows read, on every ingest chunk and every /live poll.
// A counter read is a primary-key lookup instead, so the guards cost a constant
// handful of rows no matter how much history the database holds.
//
// Keys:
//   msgs_stored                     service-wide message total
//   msgs_stored_seeded_at           epoch ms of the last recount (see below)
//   msgs_day_<yyyy-mm-dd>           service-wide uploads that UTC day
//   dev_stored_<deviceId>           per-device message total
//   dev_day_<deviceId>_<yyyy-mm-dd> per-device uploads that UTC day
//   user_day_<userId>_<yyyy-mm-dd>  per-user uploads that UTC day
//
// Day-scoped keys carry the day in the key, so a rollover needs no rewrite: the
// new day simply misses and reseeds from an indexed range query. They are left
// behind afterwards — one tiny row per day is far cheaper than scanning for it.

const RESEED_INTERVAL_MS = 24 * 60 * 60_000;

export function utcDayKey(at: Date) {
  return at.toISOString().slice(0, 10);
}

export const counterKeys = {
  serviceStored: "msgs_stored",
  serviceStoredSeededAt: "msgs_stored_seeded_at",
  serviceDay: (day: string) => `msgs_day_${day}`,
  deviceStored: (deviceId: number) => `dev_stored_${deviceId}`,
  deviceDay: (deviceId: number, day: string) => `dev_day_${deviceId}_${day}`,
  userDay: (userId: number, day: string) => `user_day_${userId}_${day}`,
};

async function readCounters(keys: string[]): Promise<Map<string, number>> {
  const rows = await db
    .select({ key: tables.settings.key, value: tables.settings.value })
    .from(tables.settings)
    .where(inArray(tables.settings.key, keys));
  return new Map(rows.map((row) => [row.key, Number(row.value) || 0]));
}

// One statement, so a chunked collector upload still costs a single round trip
// through the D1 gateway however many counters it touches.
async function writeCounters(values: Map<string, number>, mode: "add" | "set") {
  const rows = [...values]
    .filter(([, value]) => Number.isFinite(value) && (mode === "set" || value !== 0))
    .map(([key, value]) => ({ key, value: String(value) }));
  if (rows.length === 0) return;
  await db
    .insert(tables.settings)
    .values(rows)
    .onConflictDoUpdate({
      target: tables.settings.key,
      set: {
        value: mode === "add"
          ? sql`cast(${tables.settings.value} as integer) + cast(excluded."value" as integer)`
          : sql`excluded."value"`,
      },
    });
}

// The only queries in this module that read more than a handful of rows. Each
// runs when a counter is absent — on a database that predates this code, on the
// first upload of a new UTC day, or for a newly paired device — and the stored
// pair additionally once a day, so a crash between an insert and its counter
// bump cannot drift the guards permanently.
const recount = {
  serviceStored: async () => {
    const [row] = await db.select({ value: count(tables.messages.id) }).from(tables.messages);
    return Number(row.value);
  },
  serviceDay: async (dayStart: Date) => {
    const [row] = await db
      .select({ value: count(tables.messages.id) })
      .from(tables.messages)
      .where(gte(tables.messages.createdAt, dayStart));
    return Number(row.value);
  },
  deviceStored: async (deviceId: number) => {
    const [row] = await db
      .select({ value: count(tables.messages.id) })
      .from(tables.messages)
      .innerJoin(tables.sessions, eq(tables.messages.sessionId, tables.sessions.id))
      .where(eq(tables.sessions.deviceId, deviceId));
    return Number(row.value);
  },
  deviceDay: async (deviceId: number, dayStart: Date) => {
    const [row] = await db
      .select({ value: count(tables.messages.id) })
      .from(tables.messages)
      .innerJoin(tables.sessions, eq(tables.messages.sessionId, tables.sessions.id))
      .where(and(eq(tables.sessions.deviceId, deviceId), gte(tables.messages.createdAt, dayStart)));
    return Number(row.value);
  },
  userDay: async (userId: number, dayStart: Date) => {
    const [row] = await db
      .select({ value: count(tables.messages.id) })
      .from(tables.messages)
      .innerJoin(tables.sessions, eq(tables.messages.sessionId, tables.sessions.id))
      .innerJoin(tables.devices, eq(tables.sessions.deviceId, tables.devices.id))
      .where(and(eq(tables.devices.userId, userId), gte(tables.messages.createdAt, dayStart)));
    return Number(row.value);
  },
};

export type MessageUsage = {
  deviceDaily: number;
  deviceStored: number;
  userDaily: number;
  globalDaily: number;
  globalStored: number;
};

type UsageScope = { userId: number; deviceId: number; dayStart: Date };

// The five numbers both the upload guard and the /live meters report. Steady
// state is one indexed `settings` read; the wider recounts above only run for
// counters this database has not recorded yet.
export async function loadMessageUsage({ userId, deviceId, dayStart }: UsageScope, now = Date.now()): Promise<MessageUsage> {
  const day = utcDayKey(dayStart);
  const keys = {
    deviceDaily: counterKeys.deviceDay(deviceId, day),
    deviceStored: counterKeys.deviceStored(deviceId),
    userDaily: counterKeys.userDay(userId, day),
    globalDaily: counterKeys.serviceDay(day),
    globalStored: counterKeys.serviceStored,
  };
  const found = await readCounters([...Object.values(keys), counterKeys.serviceStoredSeededAt]);

  const seeds: [string, () => Promise<number>][] = [
    [keys.deviceDaily, () => recount.deviceDay(deviceId, dayStart)],
    [keys.deviceStored, () => recount.deviceStored(deviceId)],
    [keys.userDaily, () => recount.userDay(userId, dayStart)],
    [keys.globalDaily, () => recount.serviceDay(dayStart)],
    [keys.globalStored, () => recount.serviceStored()],
  ];
  // Day counters are never recounted mid-day: they are seeded once per UTC day
  // and then only added to. The stored pair is what a daily recount protects.
  const stale = now - (found.get(counterKeys.serviceStoredSeededAt) ?? 0) >= RESEED_INTERVAL_MS;
  const storedKeys = new Set([keys.deviceStored, keys.globalStored]);
  const due = seeds.filter(([key]) => !found.has(key) || (stale && storedKeys.has(key)));
  if (due.length > 0) {
    const fresh = new Map<string, number>();
    for (const [key, compute] of due) fresh.set(key, await compute());
    if (stale) fresh.set(counterKeys.serviceStoredSeededAt, now);
    await writeCounters(fresh, "set");
    for (const [key, value] of fresh) found.set(key, value);
  }

  return {
    deviceDaily: found.get(keys.deviceDaily) ?? 0,
    deviceStored: found.get(keys.deviceStored) ?? 0,
    userDaily: found.get(keys.userDaily) ?? 0,
    globalDaily: found.get(keys.globalDaily) ?? 0,
    globalStored: found.get(keys.globalStored) ?? 0,
  };
}

// Called once per accepted ingest chunk, after the rows land.
export async function recordStoredMessages({ userId, deviceId, dayStart }: UsageScope, stored: number) {
  if (stored <= 0) return;
  const day = utcDayKey(dayStart);
  await writeCounters(new Map([
    [counterKeys.deviceDay(deviceId, day), stored],
    [counterKeys.deviceStored(deviceId), stored],
    [counterKeys.userDay(userId, day), stored],
    [counterKeys.serviceDay(day), stored],
    [counterKeys.serviceStored, stored],
  ]), "add");
}
