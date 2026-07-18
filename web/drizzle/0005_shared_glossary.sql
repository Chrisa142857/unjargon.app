DELETE FROM term_sightings a USING term_sightings b
  WHERE a.id > b.id AND a.term_id = b.term_id AND a.message_id = b.message_id;
--> statement-breakpoint
CREATE UNIQUE INDEX "term_sightings_term_message" ON "term_sightings" ("term_id", "message_id");
