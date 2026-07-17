# Deploying unjargon for free

Two free services, split at the API boundary:

- **Backend** (API + SSE + Postgres + the full UI too): a **Hugging Face Space**
  (Docker, free CPU tier) built from this repo's `Dockerfile`.
- **Frontend** (static UI): **GitHub Pages**, built by
  `.github/workflows/pages.yml`, talking to the Space cross-origin (CORS is
  already configured).

The Space alone is a complete deployment — the Pages frontend is a bonus
mirror on your own github.io domain. Collectors point at the Space either way.

## 1. Backend — Hugging Face Space (no local git needed)

The `Sync backend to Hugging Face Space` workflow pushes `main` to your
Space and sets its `INGEST_TOKEN` secret automatically. One-time setup,
all in browser UIs:

1. Create the Space: https://huggingface.co/new-space → SDK **Docker**
   (blank template), name it e.g. `unjargon`, CPU basic (free).
2. Create a Hugging Face **write** token: https://huggingface.co/settings/tokens
3. In the GitHub repo → Settings → Secrets and variables → Actions, add:
   - secret `HF_TOKEN` — the token from step 2
   - secret `UNJARGON_INGEST_TOKEN` — any string you invent; collectors
     must present it to POST /api/ingest
   - variable `HF_SPACE` — `<hf-username>/<space-name>` (e.g. `wei/unjargon`)
4. Run the sync workflow once (Actions → "Sync backend to Hugging Face
   Space" → Run workflow) — every later push to `main` re-syncs.
5. Optional Space secret (Space → Settings): `ANTHROPIC_API_KEY` — only a
   fallback; by default collectors run local-translate mode with the user's
   own `claude` CLI, so the server needs no key. Or set the variable
   `UNJARGON_FAKE_TRANSLATOR=1` for the canned offline demo.

The app serves at `https://<hf-username>-<space-name>.hf.space`.

Point a collector at it:

```sh
UNJARGON_TOKEN=<INGEST_TOKEN> ./unjargond replay fixtures/session.jsonl \
  -server https://<hf-user>-unjargon.hf.space
```

**Free-tier caveats (bundled Postgres):** the container filesystem is
ephemeral — messages and glossary reset when the Space rebuilds or restarts,
and free Spaces sleep after ~48h of inactivity (first request wakes them,
cold start takes a minute). For durable data, create a free
[Neon](https://neon.tech) Postgres and set its connection string as a
`DATABASE_URL` Space secret — the entrypoint then skips the bundled Postgres
automatically.

## 2. Frontend — GitHub Pages

One-time repo setup on GitHub:

1. **Settings → Pages** → Source: **GitHub Actions**.
2. Push to `main` (or run the "Deploy frontend to GitHub Pages" workflow).

The UI appears at `https://<gh-user>.github.io/<repo>/live/`. The backend
URL is baked in automatically from the `HF_SPACE` variable (override with a
`UNJARGON_API_BASE` variable); with neither set, the site asks for a
backend URL at runtime and remembers it per browser.

## Local sanity checks (no accounts needed)

```sh
# the exact container the Space runs:
docker build -t unjargon-space .
docker run -p 7860:7860 -e INGEST_TOKEN=uj_dev_token -e UNJARGON_FAKE_TRANSLATOR=1 unjargon-space
# → http://localhost:7860/live

# the exact static bundle Pages serves:
cd web && NEXT_PUBLIC_API_BASE=http://localhost:7860 \
  NEXT_PUBLIC_BASE_PATH=/unjargon.app sh scripts/build-pages.sh
```
