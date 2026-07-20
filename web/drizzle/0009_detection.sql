ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "detected_at" timestamp with time zone;
CREATE INDEX IF NOT EXISTS "messages_undetected_ts" ON "messages" ("ts") WHERE "detected_at" IS NULL;
