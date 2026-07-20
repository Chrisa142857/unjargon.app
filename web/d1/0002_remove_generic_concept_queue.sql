-- Public Wikipedia/Google references replace the old generic AI explanation.
-- Preserve terms and transcripts; remove only pending generic AI jobs.
DELETE FROM "expansion_requests" WHERE "grounding" = 0;

CREATE TRIGGER IF NOT EXISTS "expansion_requests_require_grounding"
BEFORE INSERT ON "expansion_requests"
WHEN NEW."grounding" != 1
BEGIN
  SELECT RAISE(ABORT, 'only in-session AI explanations are supported');
END;

CREATE TRIGGER IF NOT EXISTS "expansion_requests_require_grounding_on_update"
BEFORE UPDATE OF "grounding" ON "expansion_requests"
WHEN NEW."grounding" != 1
BEGIN
  SELECT RAISE(ABORT, 'only in-session AI explanations are supported');
END;
