CREATE TABLE "users" (
  "id" serial PRIMARY KEY NOT NULL,
  "google_sub" text NOT NULL UNIQUE,
  "email" text NOT NULL,
  "name" text,
  "calibration" text DEFAULT 'new' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pairings" (
  "code_hash" text PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL REFERENCES "users"("id"),
  "expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "user_id" integer REFERENCES "users"("id");
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "token_hash" text;
--> statement-breakpoint
ALTER TABLE "devices" DROP CONSTRAINT "devices_name_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX "devices_user_name" ON "devices" ("user_id", "name");
--> statement-breakpoint
CREATE TABLE "user_terms" (
  "user_id" integer NOT NULL REFERENCES "users"("id"),
  "term_id" integer NOT NULL REFERENCES "terms"("id"),
  "l3" text,
  "learned_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "user_terms_user_term" ON "user_terms" ("user_id", "term_id");
