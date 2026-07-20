#!/bin/sh
# Entrypoint for the Render backend. The D1 schema is applied separately with
# Wrangler; this service only holds the gateway URL and its shared secret.
set -eu
# Surface boot failures in the host's log stream (Render/HF show stdout).
trap 'code=$?; if [ "$code" -ne 0 ]; then echo "[entrypoint] FAILED with exit code $code — see lines above"; fi' EXIT

if [ -z "${D1_GATEWAY_URL:-}" ] || [ -z "${D1_GATEWAY_TOKEN:-}" ]; then
  echo "[entrypoint] D1_GATEWAY_URL and D1_GATEWAY_TOKEN are required"
  exit 1
fi

if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ "${UNJARGON_FAKE_TRANSLATOR:-}" != "1" ]; then
  echo "[entrypoint] no ANTHROPIC_API_KEY — zero-AI jargon detection still works."
  echo "[entrypoint] Explanation buttons queue to a paired local CLI instead."
fi
echo "[entrypoint] starting unjargon on :${PORT:-7860}"
exec node server.js
