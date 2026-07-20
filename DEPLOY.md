# Deploying unjargon for free

Two free services, split at the API boundary:

- **Backend** (API + SSE + Postgres + the full UI too): a Docker container
  built from this repo's `Dockerfile` — **Render** free tier by default
  (Hugging Face's Docker SDK is now paid for new Spaces; a paid/grandfathered
  Space works identically).
- **Frontend** (static UI): **GitHub Pages**, built by
  `.github/workflows/pages.yml`, talking to the backend cross-origin (CORS is
  already configured).

The backend alone is a complete deployment — the Pages frontend is a bonus
mirror on your own github.io domain. Collectors point at the backend either way.

## 1. Backend — Render (free Docker hosting)

> Hugging Face now marks the Docker SDK as **paid** for new Spaces, so the
> free path is Render; the HF instructions below still work for paid or
> grandfathered Spaces.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Chrisa142857/unjargon.app)

1. Click the button (sign in to https://render.com with GitHub — the free
   tier needs no card) and approve the blueprint; `render.yaml` provisions
   the `unjargon` web service from this repo's `Dockerfile` on the free plan
   with Google login and per-device pairing. There is no shared `INGEST_TOKEN`:
   each collector exchanges a short-lived browser pairing code for its own
   device credential.
2. When the first deploy finishes, copy the service URL
   (`https://unjargon-<hash>.onrender.com`).
3. Point the frontend at it: paste the URL into the connect field on the
   Pages site (instant, per-browser), and/or add it as the repo Actions
   variable `UNJARGON_API_BASE` so the next Pages build bakes it in.

Render auto-redeploys the service on every push to `main`. Free-tier
caveats: the service sleeps after ~15 min idle (first request wakes it,
~1 min cold start) and the bundled Postgres is ephemeral — for durable
data set a `DATABASE_URL` env var (e.g. https://neon.tech free tier);
the entrypoint switches automatically.

## 1b. Backend — Hugging Face Space (Docker SDK now paid; no local git needed)

The `Sync backend to Hugging Face Space` workflow pushes `main` to your
Space. One-time setup, all in browser UIs:

1. Create the Space: https://huggingface.co/new-space → SDK **Docker**
   (blank template), name it e.g. `unjargon`, CPU basic (free).
2. Create a Hugging Face **write** token: https://huggingface.co/settings/tokens
3. In the GitHub repo → Settings → Secrets and variables → Actions, add:
   - secret `HF_TOKEN` — the token from step 2
   - variable `HF_SPACE` — `<hf-username>/<space-name>` (e.g. `wei/unjargon`)
4. Run the sync workflow once (Actions → "Sync backend to Hugging Face
   Space" → Run workflow) — every later push to `main` re-syncs.
5. Optional Space secret (Space → Settings): `ANTHROPIC_API_KEY` — used only
   after a user presses an explanation button. Detection and history import
   are zero-AI. Or set `UNJARGON_FAKE_TRANSLATOR=1` for the canned on-demand
   explanation demo.

The app serves at `https://<hf-username>-<space-name>.hf.space`.

Point a collector at it:

```sh
./unjargond replay fixtures/session.jsonl \
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
docker run -p 7860:7860 -e UNJARGON_FAKE_TRANSLATOR=1 unjargon-space
# → http://localhost:7860/live

# the exact static bundle Pages serves:
cd web && NEXT_PUBLIC_API_BASE=http://localhost:7860 \
  NEXT_PUBLIC_BASE_PATH=/unjargon.app sh scripts/build-pages.sh
```
