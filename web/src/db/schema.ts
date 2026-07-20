import { sql } from "drizzle-orm";
import {
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const timestamp = (name: string) => integer(name, { mode: "timestamp_ms" });

// A machine running an unjargond collector (laptop, HPC login node, ...).
export const devices = sqliteTable("devices", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").references(() => users.id),
  name: text("name").notNull(),
  tokenHash: text("token_hash"),
  // Collector-reported JSON: {pausedUntil, budgetUsed, budgetLimit, updatedAt}
  // — what the server can't know about the device's local AI budget.
  importStatus: text("import_status"),
  lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
}, (t) => [uniqueIndex("devices_user_name").on(t.userId, t.name)]);

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  googleSub: text("google_sub").notNull().unique(),
  email: text("email").notNull(),
  name: text("name"),
  calibration: text("calibration").notNull().default("new"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const pairings = sqliteTable("pairings", {
  codeHash: text("code_hash").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  expiresAt: timestamp("expires_at").notNull(),
});

// One agent session = one transcript file on one device.
export const sessions = sqliteTable(
  "sessions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    deviceId: integer("device_id").notNull().references(() => devices.id),
    tool: text("tool").notNull(), // "claude-code" | "codex" | ...
    sessionKey: text("session_key").notNull(), // the tool's own session id
    cwd: text("cwd"),
    startedAt: timestamp("started_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("sessions_device_key").on(t.deviceId, t.sessionKey)],
);

// One assistant message. Raw text always remains the UI source.
export const messages = sqliteTable("messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: integer("session_id").notNull().references(() => sessions.id),
  // Stable server-side key makes retrying a collector chunk safe.
  dedupeKey: text("dedupe_key").notNull().unique(),
  ts: timestamp("ts").notNull(),
  text: text("text").notNull(),
  subtitle: text("subtitle"),
  // Legacy display fields retained for compatibility with existing databases.
  importance: real("importance"),
  // Legacy AI-processing data, retained so deployed databases remain readable.
  translatedAt: timestamp("translated_at"),
  // Zero-AI detector completion marker. Starts NULL for all existing history.
  detectedAt: timestamp("detected_at"),
  // Legacy translation queue claim retained for compatibility with databases.
  claimedAt: timestamp("claimed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Legacy digest table, retained only for existing databases. It is not used.
export const digests = sqliteTable(
  "digests",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: integer("session_id").notNull().references(() => sessions.id),
    fromMessageId: integer("from_message_id").notNull(),
    toMessageId: integer("to_message_id").notNull(),
    fromTs: timestamp("from_ts").notNull(),
    toTs: timestamp("to_ts").notNull(),
    messageCount: integer("message_count").notNull(),
    summary: text("summary").notNull().default(""),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  // Two workers racing for the same chunk: second insert fails, work not duplicated.
  (t) => [uniqueIndex("digests_session_from").on(t.sessionId, t.fromMessageId)],
);

// A jargon term with detector note L1. l2/l3 on this legacy table remain for
// backwards compatibility; new public references are fetched on demand and
// in-session AI explanations live only in userTerms.l3.
// Shared terms are generic natural-language vocabulary only. Legacy keyword
// rows are hidden: artifacts, flags, commands, packages, and identifiers are
// not jargon.
export const terms = sqliteTable("terms", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").references(() => users.id),
  key: text("key").notNull(), // lower-cased canonical name
  term: text("term").notNull(),
  domain: text("domain").notNull(),
  // "term" (domain term of art) | "initial" (acronym/initialism).
  // "keyword" remains only for legacy rows and is never surfaced.
  kind: text("kind").notNull().default("term"),
  l1: text("l1").notNull(),
  l2: text("l2"),
  l3: text("l3"),
  salience: real("salience"),
  learnedAt: timestamp("learned_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [uniqueIndex("terms_owner_key").on(sql`coalesce(${t.userId}, 0)`, t.key)]);

// User-specific state. An L3 explanation is grounded in a user's transcript
// and must never be shared.
export const userTerms = sqliteTable("user_terms", {
  userId: integer("user_id").notNull().references(() => users.id),
  termId: integer("term_id").notNull().references(() => terms.id),
  l3: text("l3"),
  learnedAt: timestamp("learned_at"),
}, (t) => [uniqueIndex("user_terms_user_term").on(t.userId, t.termId)]);

// An inline highlight in one message: the exact span of jargon plus the
// plain-language rewrite of the sentence it appears in.
export const annotations = sqliteTable("annotations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  messageId: integer("message_id").notNull().references(() => messages.id),
  span: text("span").notNull(),
  sentenceRewrite: text("sentence_rewrite").notNull(),
  termId: integer("term_id").references(() => terms.id),
});

// Where a term was seen ("seen in 4 sessions on 2 machines"). The zero-AI
// detector writes this alongside its annotations.
export const termSightings = sqliteTable("term_sightings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  termId: integer("term_id").notNull().references(() => terms.id),
  messageId: integer("message_id").notNull().references(() => messages.id),
}, (t) => [uniqueIndex("term_sightings_term_message").on(t.termId, t.messageId)]);

// Queued expansion work for no-key servers. The D1 trigger permits only
// grounding=true: an explicitly confirmed, in-session explanation served to
// the requesting user's own collector and deleted on completion.
export const expansionRequests = sqliteTable("expansion_requests", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  termId: integer("term_id").notNull().references(() => terms.id),
  userId: integer("user_id").notNull().references(() => users.id),
  grounding: integer("grounding", { mode: "boolean" }).notNull().default(false),
  messageId: integer("message_id"), // optional tapped-from source for L3
  confirmedAt: timestamp("confirmed_at"),
  claimedAt: timestamp("claimed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [uniqueIndex("expansion_requests_unique").on(t.termId, t.userId, t.grounding)]);

// Legacy key/value settings retained for existing databases. Calibration is
// per-user on users.
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
