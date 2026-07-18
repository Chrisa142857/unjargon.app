-- Remove any pre-0006 links that tie a user to another user's private term:
-- sightings recorded before keywords became per-user, learned/L3 state on a
-- foreign keyword, and annotation refs across owners.
DELETE FROM term_sightings ts USING terms t, messages m, sessions s, devices d
  WHERE ts.term_id = t.id AND t.user_id IS NOT NULL
    AND ts.message_id = m.id AND m.session_id = s.id AND s.device_id = d.id
    AND d.user_id IS DISTINCT FROM t.user_id;
--> statement-breakpoint
DELETE FROM user_terms ut USING terms t
  WHERE ut.term_id = t.id AND t.user_id IS NOT NULL AND t.user_id <> ut.user_id;
--> statement-breakpoint
UPDATE annotations a SET term_id = NULL FROM terms t, messages m, sessions s, devices d
  WHERE a.term_id = t.id AND t.user_id IS NOT NULL
    AND a.message_id = m.id AND m.session_id = s.id AND s.device_id = d.id
    AND d.user_id IS DISTINCT FROM t.user_id;
