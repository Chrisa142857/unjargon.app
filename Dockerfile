# Backend image: the Next.js API, SSE, and UI. DATABASE_URL is required for
# durable data; bundled Postgres remains as an explicitly warned local fallback.

FROM node:22-slim AS builder
WORKDIR /app
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
ENV NEXT_TELEMETRY_DISABLED=1
# Build-time placeholder only; the runtime value comes from the entrypoint.
ENV DATABASE_URL=postgres://postgres@localhost:5432/unjargon
RUN npm run build

FROM node:22-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql postgresql-client \
    && rm -rf /var/lib/apt/lists/*

# Run as the node image's built-in non-root user (uid 1000 — required by HF
# Spaces, and Postgres refuses to run as root anyway). node:*-slim already
# defines it, so creating another uid-1000 user would fail the build.
USER node
ENV HOME=/home/node
WORKDIR /app

COPY --chown=node:node --from=builder /app/.next/standalone ./
COPY --chown=node:node --from=builder /app/.next/static ./.next/static
COPY --chown=node:node --from=builder /app/public ./public
COPY --chown=node:node --from=builder /app/data ./data
COPY --chown=node:node web/drizzle ./drizzle
COPY --chown=node:node deploy/space-entrypoint.sh ./space-entrypoint.sh

ENV NEXT_TELEMETRY_DISABLED=1 \
    PORT=7860 \
    HOSTNAME=0.0.0.0
EXPOSE 7860
CMD ["sh", "./space-entrypoint.sh"]
