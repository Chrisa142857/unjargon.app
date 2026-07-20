# Deploying unjargon with free Cloudflare D1

The API stays on Render, where its long-lived Node process supplies Google
OAuth and SSE. Durable data is free Cloudflare D1:

```text
collector/browser → Render (Next.js + SSE) → private Worker gateway → D1
```

The gateway uses a D1 binding. It is not Cloudflare's administrative D1 REST
API, and Render never receives a Cloudflare account token.

## 0. Authorize Cloudflare once

Either run `npx wrangler login`, or use a short-lived, account-scoped custom
API token. The token needs only **Account → D1 → Edit** and **Account →
Workers Scripts → Edit** for the target account. Do not use a Global API Key
or give it Billing, DNS, R2, Pages, or KV permissions. With the account ID,
Wrangler does not need broad account-discovery permissions:

```sh
export CLOUDFLARE_ACCOUNT_ID=<Cloudflare account ID>
export CLOUDFLARE_API_TOKEN=<short-lived custom token>
```

Revoke the provisioning token after deployment if it will not be used again.

## 1. Create D1 and the gateway

Keep the Cloudflare account on **Workers Free**. Before creating anything,
check that no older test resources would be reused accidentally:

```sh
cd d1-worker
npx wrangler d1 list
npx wrangler deployments list
npx wrangler d1 create unjargon --update-config=false
```

Copy the returned database UUID into `d1-worker/wrangler.toml` as
`database_id`. Apply the fresh SQLite baseline before exposing the app:

```sh
npx wrangler d1 execute unjargon --remote --file=../web/d1/0000_init.sql
openssl rand -base64 32
npx wrangler secret put D1_GATEWAY_TOKEN
npx wrangler deploy
```

Enter the random value produced by `openssl` when Wrangler prompts. Save the
Worker URL with `/query` appended, for example:

```text
https://unjargon-d1.<your-subdomain>.workers.dev/query
```

`web/d1/0000_init.sql` is a fresh D1 baseline. Do **not** run the old
`web/drizzle/` Postgres migrations on D1.

## 2. Configure Render

In the `unjargon` Render service, add these environment variables:

```text
D1_GATEWAY_URL=<the Worker /query URL>
D1_GATEWAY_TOKEN=<the exact random value entered above>
GOOGLE_CLIENT_ID=<existing value>
GOOGLE_CLIENT_SECRET=<existing value>
AUTH_SECRET=<existing value>
APP_URL=https://unjargon.onrender.com
```

Server AI requires both `UNJARGON_ALLOW_SERVER_AI=1` and
`ANTHROPIC_API_KEY`. Leave the opt-in flag unset for a zero-cost deployment;
there is no `DATABASE_URL` and no shared `INGEST_TOKEN`.

Deploy the Worker, set the Render variables, then deploy Render. The
container fails fast if either D1 gateway setting is missing, avoiding an
accidental ephemeral datastore.

Google's redirect URI stays:

```text
https://unjargon.onrender.com/api/auth/google/callback
```

## 3. Preserve existing history deliberately

A fresh D1 has no prior messages. After the Render deployment is healthy,
sign in, create a new pairing code, and reinstall each collector with the
explicit replay flag:

```sh
curl -fsSL https://raw.githubusercontent.com/Chrisa142857/unjargon.app/main/install.sh \
  | sh -s -- --server https://unjargon.onrender.com --reimport
```

`--reimport` clears only that collector's saved transcript offsets and its
one-time backfill marker. Normal reinstalls leave those offsets alone, so they
do not duplicate history. Retrying chunks is safe because the server records a
stable per-message dedupe key.

## D1 free-plan safeguards

- Incoming collector requests are split into 20 messages, under D1's 100
  bound-parameter limit; a `429 Retry-After` pauses a large local backfill and
  retains only the unacknowledged tail for the next daily window.
- The server accepts up to 4,000 new messages/day by default and detects
  jargon in up to 750 shared messages/day. Both limits are configurable with
  `D1_DAILY_INGEST_MESSAGES` and `D1_DAILY_DETECTION_MESSAGES`.
- Work resumes after 00:00 UTC rather than dropping old history. `/live`
  shows the detection pause and calendar windows when the daily detector
  allowance is spent.

These conservative defaults protect D1 Free's daily write allowance while a
large existing transcript archive is imported. R2 is intentionally not on the
live database path; add it later only for optional exports or archives.

The Worker is free at its `workers.dev` URL. Keep Render on its Free plan and
do not add a payment method if a strict $0 ceiling matters: its free egress
allowance can otherwise create an overage. Keep the GitHub variable
`UNJARGON_API_BASE=https://unjargon.onrender.com` and leave `HF_SPACE` unset
so no second backend is deployed. D1 Free stops accepting queries at its
quota/storage ceiling rather than auto-upgrading; it does not provide
unlimited transcript retention.

## Frontend

GitHub Pages remains a static mirror. Set the repository Actions variable
`UNJARGON_API_BASE=https://unjargon.onrender.com` and run the Pages workflow.
The Page redirects account-bound routes to the Render API origin, preserving
the secure auth cookie.

## Local checks

```sh
cd web
npm run check:d1
npm run check:detector
npm run lint
npx tsc --noEmit
npm run build

cd ../collector
go test ./...
```

`check:d1` applies the real D1 SQLite baseline to an in-memory SQLite engine
and exercises timestamps, unique upserts, `RETURNING`, foreign keys, and the
proxy result shape. Before cutover, also run the same baseline against the
remote D1 database with Wrangler and complete a Google sign-in → pair →
collector import flow in the deployed app.
