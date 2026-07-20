-- Existing D1 upgrade: old queued explanations have no confirmation and must
-- never be claimed by a collector after this change. This touches only pending
-- explanation jobs, never transcripts, terms, accounts, or history.
ALTER TABLE "expansion_requests" ADD COLUMN "confirmed_at" integer;
DELETE FROM "expansion_requests";
CREATE TRIGGER "expansion_requests_require_confirmation"
BEFORE INSERT ON "expansion_requests"
WHEN NEW."confirmed_at" IS NULL
BEGIN
  SELECT RAISE(ABORT, 'AI confirmation required');
END;
