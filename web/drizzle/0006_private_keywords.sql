ALTER TABLE "terms" ADD COLUMN "user_id" integer REFERENCES "users"("id");
--> statement-breakpoint
ALTER TABLE "terms" DROP CONSTRAINT "terms_key_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX "terms_owner_key" ON "terms" (COALESCE("user_id", 0), "key");
--> statement-breakpoint
UPDATE terms t SET user_id = (
  SELECT d.user_id FROM term_sightings ts
  JOIN messages m ON m.id = ts.message_id
  JOIN sessions s ON s.id = m.session_id
  JOIN devices d ON d.id = s.device_id
  WHERE ts.term_id = t.id AND d.user_id IS NOT NULL
  ORDER BY ts.id LIMIT 1
) WHERE t.kind = 'keyword' AND t.user_id IS NULL;
