CREATE TABLE "annotations" (
	"id" serial PRIMARY KEY NOT NULL,
	"message_id" integer NOT NULL,
	"span" text NOT NULL,
	"sentence_rewrite" text NOT NULL,
	"term_id" integer
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "devices_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" integer NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"text" text NOT NULL,
	"subtitle" text,
	"translated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"device_id" integer NOT NULL,
	"tool" text NOT NULL,
	"session_key" text NOT NULL,
	"cwd" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "term_sightings" (
	"id" serial PRIMARY KEY NOT NULL,
	"term_id" integer NOT NULL,
	"message_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "terms" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"term" text NOT NULL,
	"domain" text NOT NULL,
	"l1" text NOT NULL,
	"l2" text,
	"l3" text,
	"salience" real,
	"learned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "terms_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_term_id_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."terms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "term_sightings" ADD CONSTRAINT "term_sightings_term_id_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."terms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "term_sightings" ADD CONSTRAINT "term_sightings_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_device_key" ON "sessions" USING btree ("device_id","session_key");