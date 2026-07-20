#!/bin/sh
# Entrypoint for the Hugging Face Space container: bring up Postgres (unless
# an external DATABASE_URL is provided as a Space secret), apply the schema,
# start the Next.js standalone server on $PORT.
set -eu
# Surface boot failures in the host's log stream (Render/HF show stdout).
trap 'code=$?; if [ "$code" -ne 0 ]; then echo "[entrypoint] FAILED with exit code $code — see lines above"; fi' EXIT

PGBIN=$(ls -d /usr/lib/postgresql/*/bin | head -1)
PGDATA="$HOME/pgdata"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[entrypoint] no external DATABASE_URL — using bundled Postgres (ephemeral!)"
  if [ ! -s "$PGDATA/PG_VERSION" ]; then
    "$PGBIN/initdb" -D "$PGDATA" --auth=trust -U postgres >/dev/null
  fi
  "$PGBIN/pg_ctl" -D "$PGDATA" -l "$HOME/pg.log" -o "-p 5432 -k /tmp -c listen_addresses=localhost" start
  "$PGBIN/createdb" -h /tmp -U postgres unjargon 2>/dev/null || true
  export DATABASE_URL="postgres://postgres@localhost:5432/unjargon"
fi

echo "[entrypoint] applying schema migrations"
for f in ./drizzle/*.sql; do
  # Idempotent enough for a fresh/ephemeral DB; errors on existing tables are
  # expected after a warm restart with persistent storage.
  psql "$DATABASE_URL" -v ON_ERROR_STOP=0 -q -f "$f" 2>&1 | grep -v "already exists" || true
done

if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ "${UNJARGON_FAKE_TRANSLATOR:-}" != "1" ]; then
  echo "[entrypoint] no ANTHROPIC_API_KEY — zero-AI jargon detection still works."
  echo "[entrypoint] Explanation buttons queue to a paired local CLI instead."
fi
echo "[entrypoint] starting unjargon on :${PORT:-7860}"
exec node server.js
