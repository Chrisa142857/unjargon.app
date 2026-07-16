import {
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// A machine running an unjargond collector (laptop, HPC login node, ...).
export const devices = pgTable("devices", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
});

// One agent session = one transcript file on one device.
export const sessions = pgTable(
  "sessions",
  {
    id: serial("id").primaryKey(),
    deviceId: integer("device_id")
      .notNull()
      .references(() => devices.id),
    tool: text("tool").notNull(), // "claude-code" | "codex" | ...
    sessionKey: text("session_key").notNull(), // the tool's own session id
    cwd: text("cwd"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("sessions_device_key").on(t.deviceId, t.sessionKey)],
);

// One assistant message. `subtitle` is filled by the translation pipeline
// (step 3); null means untranslated / raw passthrough.
export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id")
    .notNull()
    .references(() => sessions.id),
  ts: timestamp("ts", { withTimezone: true }).notNull(),
  text: text("text").notNull(),
  subtitle: text("subtitle"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
