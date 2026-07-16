# Deploying unjargon for free

Two free services, split at the API boundary:

- **Backend** (API + SSE + Postgres + the full UI too): a **Hugging Face Space**
  (Docker, free CPU tier) built from this repo's `Dockerfile`.
- **Frontend** (static UI): **GitHub Pages**, built by
  `.github/workflows/pages.yml`, talking to the Space cross-origin (CORS is
  already configured).

The Space alone is a complete deployment — the Pages frontend is a bonus
mirror on your own github.io domain. Collectors point at the Space either way.

## 1. Backend — Hugging Face Space

1. Create the Space: https://huggingface.co/new-space → SDK **Docker**
   (blank template), name it e.g. `unjargon`, CPU basic (free).
2. Push this repo to the Space (its README frontmatter + Dockerfile are
   already set up):

   ```sh
   git remote add hf https://huggingface.co/spaces/<hf-user>/unjargon
   git push hf main
   ```

3. In the Space → Settings → Variables and secrets, add **secrets**:
   - `ANTHROPIC_API_KEY` — for real translations
     (or a variable `UNJARGON_FAKE_TRANSLATOR=1` for the canned offline demo)
   - `INGEST_TOKEN` — any string; collectors must present it
4. Wait for the build; the app is at `https://<hf-user>-unjargon.hf.space`
   (exact URL shown under the Space's ⋮ → "Embed this Space").

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
2. **Settings → Secrets and variables → Actions → Variables** → add
   `UNJARGON_API_BASE` = `https://<hf-user>-unjargon.hf.space`.
3. Merge/push to `main` (or run the "Deploy frontend to GitHub Pages"
   workflow manually).

The UI appears at `https://<gh-user>.github.io/<repo>/live/`.

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
