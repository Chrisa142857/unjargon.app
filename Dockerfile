# Backend image: the Next.js API, SSE, and UI. Persistent data lives in D1
# behind the authenticated Worker gateway configured at runtime.

FROM node:22-slim AS builder
WORKDIR /app
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-slim
# Run as the node image's built-in non-root user (uid 1000).
USER node
ENV HOME=/home/node
WORKDIR /app

COPY --chown=node:node --from=builder /app/.next/standalone ./
COPY --chown=node:node --from=builder /app/.next/static ./.next/static
COPY --chown=node:node --from=builder /app/public ./public
COPY --chown=node:node --from=builder /app/data ./data
COPY --chown=node:node deploy/space-entrypoint.sh ./space-entrypoint.sh

ENV NEXT_TELEMETRY_DISABLED=1 \
    PORT=7860 \
    HOSTNAME=0.0.0.0
EXPOSE 7860
CMD ["sh", "./space-entrypoint.sh"]
