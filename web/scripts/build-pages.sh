#!/bin/sh
# Build the static GitHub Pages export of the UI.
#
# Static export can't contain dynamic route handlers, so src/app/api is moved
# aside for the build (an _-prefixed folder is excluded from routing) and
# restored afterwards. The client talks to the real API via NEXT_PUBLIC_API_BASE.
#
# Usage:
#   NEXT_PUBLIC_API_BASE=https://<user>-unjargon.hf.space \
#   NEXT_PUBLIC_BASE_PATH=/unjargon.app \
#   sh scripts/build-pages.sh
set -eu
cd "$(dirname "$0")/.."

: "${NEXT_PUBLIC_API_BASE:?set NEXT_PUBLIC_API_BASE to the backend URL (the HF Space)}"

restore() { [ -d src/app/_api_disabled ] && mv src/app/_api_disabled src/app/api || true; }
trap restore EXIT

mv src/app/api src/app/_api_disabled
rm -rf .next out
BUILD_TARGET=pages npx next build
# GitHub Pages serves 404.html for unknown paths; Next emits one already.
touch out/.nojekyll

echo "static export in web/out (API base: $NEXT_PUBLIC_API_BASE, base path: ${NEXT_PUBLIC_BASE_PATH:-/})"
