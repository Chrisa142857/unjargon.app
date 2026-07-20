-- Fresh D1 baseline. The old web/drizzle/ migrations target Postgres and are
-- retained only as a rollback record; do not apply them to this database.

CREATE TABLE IF NOT EXISTS "users" (
  "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  "google_sub" text NOT NULL UNIQUE,
  "email" text NOT NULL,
  "name" text,
  "calibration" text DEFAULT 'new' NOT NULL,
  "created_at" integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);

CREATE TABLE IF NOT EXISTS "devices" (
  "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  "user_id" integer REFERENCES "users"("id"),
  "name" text NOT NULL,
  "token_hash" text,
  "import_status" text,
  "last_seen_at" integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "devices_user_name" ON "devices" ("user_id", "name");
CREATE INDEX IF NOT EXISTS "devices_token_hash" ON "devices" ("token_hash");

CREATE TABLE IF NOT EXISTS "pairings" (
  "code_hash" text PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL REFERENCES "users"("id"),
  "expires_at" integer NOT NULL
);

CREATE TABLE IF NOT EXISTS "sessions" (
  "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  "device_id" integer NOT NULL REFERENCES "devices"("id"),
  "tool" text NOT NULL,
  "session_key" text NOT NULL,
  "cwd" text,
  "started_at" integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "sessions_device_key" ON "sessions" ("device_id", "session_key");

CREATE TABLE IF NOT EXISTS "messages" (
  "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  "session_id" integer NOT NULL REFERENCES "sessions"("id"),
  "dedupe_key" text NOT NULL UNIQUE,
  "ts" integer NOT NULL,
  "text" text NOT NULL,
  "subtitle" text,
  "importance" real,
  "translated_at" integer,
  "detected_at" integer,
  "claimed_at" integer,
  "created_at" integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
CREATE INDEX IF NOT EXISTS "messages_session_id" ON "messages" ("session_id");
CREATE INDEX IF NOT EXISTS "messages_undetected_ts" ON "messages" ("ts") WHERE "detected_at" IS NULL;
-- Daily free-plan counters use these range indexes instead of scanning history.
CREATE INDEX IF NOT EXISTS "messages_created_at" ON "messages" ("created_at");
CREATE INDEX IF NOT EXISTS "messages_detected_at" ON "messages" ("detected_at") WHERE "detected_at" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "digests" (
  "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  "session_id" integer NOT NULL REFERENCES "sessions"("id"),
  "from_message_id" integer NOT NULL,
  "to_message_id" integer NOT NULL,
  "from_ts" integer NOT NULL,
  "to_ts" integer NOT NULL,
  "message_count" integer NOT NULL,
  "summary" text DEFAULT '' NOT NULL,
  "created_at" integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "digests_session_from" ON "digests" ("session_id", "from_message_id");

CREATE TABLE IF NOT EXISTS "terms" (
  "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  "user_id" integer REFERENCES "users"("id"),
  "key" text NOT NULL,
  "term" text NOT NULL,
  "domain" text NOT NULL,
  "kind" text DEFAULT 'term' NOT NULL,
  "l1" text NOT NULL,
  "l2" text,
  "l3" text,
  "salience" real,
  "learned_at" integer,
  "created_at" integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "terms_owner_key" ON "terms" (coalesce("user_id", 0), "key");

CREATE TABLE IF NOT EXISTS "user_terms" (
  "user_id" integer NOT NULL REFERENCES "users"("id"),
  "term_id" integer NOT NULL REFERENCES "terms"("id"),
  "l3" text,
  "learned_at" integer
);
CREATE UNIQUE INDEX IF NOT EXISTS "user_terms_user_term" ON "user_terms" ("user_id", "term_id");

CREATE TABLE IF NOT EXISTS "annotations" (
  "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  "message_id" integer NOT NULL REFERENCES "messages"("id"),
  "span" text NOT NULL,
  "sentence_rewrite" text NOT NULL,
  "term_id" integer REFERENCES "terms"("id")
);
CREATE INDEX IF NOT EXISTS "annotations_message_id" ON "annotations" ("message_id");

CREATE TABLE IF NOT EXISTS "term_sightings" (
  "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  "term_id" integer NOT NULL REFERENCES "terms"("id"),
  "message_id" integer NOT NULL REFERENCES "messages"("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "term_sightings_term_message" ON "term_sightings" ("term_id", "message_id");
CREATE INDEX IF NOT EXISTS "term_sightings_message_id" ON "term_sightings" ("message_id");

CREATE TABLE IF NOT EXISTS "expansion_requests" (
  "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  "term_id" integer NOT NULL REFERENCES "terms"("id"),
  "user_id" integer NOT NULL REFERENCES "users"("id"),
  "grounding" integer DEFAULT false NOT NULL,
  "message_id" integer,
  "claimed_at" integer,
  "created_at" integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "expansion_requests_unique" ON "expansion_requests" ("term_id", "user_id", "grounding");
CREATE INDEX IF NOT EXISTS "expansion_requests_user_claimed" ON "expansion_requests" ("user_id", "claimed_at");

CREATE TABLE IF NOT EXISTS "settings" (
  "key" text PRIMARY KEY NOT NULL,
  "value" text NOT NULL
);
