ALTER TABLE "messages" ADD COLUMN "claimed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "import_status" text;
--> statement-breakpoint
CREATE INDEX "messages_untranslated_ts" ON "messages" ("ts") WHERE "translated_at" IS NULL;
