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
  userId: integer("user_id").references(() => users.id),
  name: text("name").notNull(),
  tokenHash: text("token_hash"),
  // Collector-reported JSON: {pausedUntil, budgetUsed, budgetLimit, updatedAt}
  // — what the server can't know about the device's local AI budget.
  importStatus: text("import_status"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [uniqueIndex("devices_user_name").on(t.userId, t.name)]);

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  googleSub: text("google_sub").notNull().unique(),
  email: text("email").notNull(),
  name: text("name"),
  calibration: text("calibration").notNull().default("new"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const pairings = pgTable("pairings", {
  codeHash: text("code_hash").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
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
  // 0-1, from the translation call: how much a catching-up user needs this
  // message. Drives the highlights filter.
  importance: real("importance"),
  translatedAt: timestamp("translated_at", { withTimezone: true }),
  // translate-work queue claim (set when a collector takes the message,
  // reaped after a TTL) — untranslated messages ARE the import queue.
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// A rollup card standing in for a contiguous, already-translated stretch of
// one session's stream ([fromMessageId, toMessageId]). summary '' = claimed
// by a collector worker but not yet delivered (local-translate digest work).
export const digests = pgTable(
  "digests",
  {
    id: serial("id").primaryKey(),
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.id),
    fromMessageId: integer("from_message_id").notNull(),
    toMessageId: integer("to_message_id").notNull(),
    fromTs: timestamp("from_ts", { withTimezone: true }).notNull(),
    toTs: timestamp("to_ts", { withTimezone: true }).notNull(),
    messageCount: integer("message_count").notNull(),
    summary: text("summary").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  // Two workers racing for the same chunk: second insert fails, work not duplicated.
  (t) => [uniqueIndex("digests_session_from").on(t.sessionId, t.fromMessageId)],
);

// A jargon term with layered explanations: L1 one-liner (eager, from
// extraction), L2 basic concept and L3 "why it's used in your session"
// (lazy, generated on first click, cached).
export const terms = pgTable("terms", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(), // lower-cased canonical name
  term: text("term").notNull(),
  domain: text("domain").notNull(),
  // "keyword" (files/libraries/commands) | "term" (domain term of art) |
  // "initial" (acronym/initialism) — drives the board's kind filter.
  kind: text("kind").notNull().default("term"),
  l1: text("l1").notNull(),
  l2: text("l2"),
  l3: text("l3"),
  salience: real("salience"),
  learnedAt: timestamp("learned_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// User-specific state. L1/L2 remain shared generic glossary entries; L3 is
// grounded in a user's transcript and must never be shared.
export const userTerms = pgTable("user_terms", {
  userId: integer("user_id").notNull().references(() => users.id),
  termId: integer("term_id").notNull().references(() => terms.id),
  l3: text("l3"),
  learnedAt: timestamp("learned_at", { withTimezone: true }),
}, (t) => [uniqueIndex("user_terms_user_term").on(t.userId, t.termId)]);

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

// Where a term was seen ("seen in 4 sessions on 2 machines"). Written both
// by translation results and by the no-AI shared-glossary matcher at ingest —
// the unique index keeps the two paths from double-counting.
export const termSightings = pgTable("term_sightings", {
  id: serial("id").primaryKey(),
  termId: integer("term_id")
    .notNull()
    .references(() => terms.id),
  messageId: integer("message_id")
    .notNull()
    .references(() => messages.id),
}, (t) => [uniqueIndex("term_sightings_term_message").on(t.termId, t.messageId)]);

// Single-user key/value settings (calibration level etc.); becomes per-user
// when auth lands.
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
