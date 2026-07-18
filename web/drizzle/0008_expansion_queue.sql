CREATE TABLE "expansion_requests" (
  "id" serial PRIMARY KEY NOT NULL,
  "term_id" integer NOT NULL REFERENCES "terms"("id"),
  "user_id" integer NOT NULL REFERENCES "users"("id"),
  "grounding" boolean DEFAULT false NOT NULL,
  "message_id" integer,
  "claimed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "expansion_requests_unique" ON "expansion_requests" ("term_id", "user_id", "grounding");
