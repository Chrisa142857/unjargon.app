import {
  integer,
  pgTable,
  real,
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

// One assistant message. The translation pipeline fills `subtitle`;
// translatedAt set with subtitle null = passthrough (trivial message,
// skipped per the trust rules, or translation failed — raw text shows).
export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id")
    .notNull()
    .references(() => sessions.id),
  ts: timestamp("ts", { withTimezone: true }).notNull(),
  text: text("text").notNull(),
  subtitle: text("subtitle"),
  translatedAt: timestamp("translated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// A jargon term with layered explanations: L1 one-liner (eager, from
// extraction), L2 basic concept and L3 "why it's used in your session"
// (lazy, generated on first click, cached).
export const terms = pgTable("terms", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(), // lower-cased canonical name
  term: text("term").notNull(),
  domain: text("domain").notNull(),
  l1: text("l1").notNull(),
  l2: text("l2"),
  l3: text("l3"),
  salience: real("salience"),
  learnedAt: timestamp("learned_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// An inline highlight in one message: the exact span of jargon plus the
// plain-language rewrite of the sentence it appears in.
export const annotations = pgTable("annotations", {
  id: serial("id").primaryKey(),
  messageId: integer("message_id")
    .notNull()
    .references(() => messages.id),
  span: text("span").notNull(),
  sentenceRewrite: text("sentence_rewrite").notNull(),
  termId: integer("term_id").references(() => terms.id),
});

// Where a term was seen ("seen in 4 sessions on 2 machines").
export const termSightings = pgTable("term_sightings", {
  id: serial("id").primaryKey(),
  termId: integer("term_id")
    .notNull()
    .references(() => terms.id),
  messageId: integer("message_id")
    .notNull()
    .references(() => messages.id),
});

// Single-user key/value settings (calibration level etc.); becomes per-user
// when auth lands.
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
