# AI Town Planner – web server (phone app)

One installable web app for iPhone and Android, served from Fly.io (Sydney). The server is a small Rust
program (`server/`) that compiles the desktop app's own core (`src-tauri/src/data.rs`, `rules.rs`,
`council.rs`, `dev.rs`), so answers are the same as on the desktop. It also serves the built frontend.

Site: **https://ai-town-planner.fly.dev**

## Go live (owner, one time)

1. Create a Fly.io account (https://fly.io, card required) and install `flyctl`
   (Windows PowerShell: `iwr https://fly.io/install.ps1 -useb | iex`), then `fly auth login`.
   Everything below can also be done in the Fly web dashboard.
2. Create the app (the name in `fly.toml`; `fly launch` is not needed):
   `fly apps create ai-town-planner`
   (If that name is taken, pick another and change `app = ...` in `fly.toml`; the URL becomes `https://<name>.fly.dev`.)
3. Create the data volume in Sydney:
   `fly volumes create pack --region syd --size 6 -a ai-town-planner`
   The data pack is ~2.4 GB unpacked, and a refresh keeps the old pack in service while the new one
   loads, so 6 GB is the safe size (3 GB is enough for first load only; `fly volumes extend` can grow it later).
4. Create a deploy token: `fly tokens create deploy -a ai-town-planner` and copy the whole output (starts with `FlyV1`).
5. In GitHub: repo **Settings → Secrets and variables → Actions → New repository secret**,
   name `FLY_API_TOKEN`, paste the token.
6. **Actions → "Web app" → Run workflow** (branch `main`). It builds, tests and deploys.
7. Open https://ai-town-planner.fly.dev. The first start downloads the newest data pack from the GitHub
   releases (~420 MB, 1–3 minutes); keep the page open until search works. On the phone: Share → Add to
   Home Screen (iPhone) or menu → Install app (Android).

Optional: `fly secrets set ADMIN_TOKEN=<long random text> -a ai-town-planner` enables
`POST /admin/refresh` to load a newer data pack without a redeploy:
`curl -X POST -H "Authorization: Bearer <token>" https://ai-town-planner.fly.dev/admin/refresh`
(add `?force=1` to reload the same release). Progress shows in `POST /api/status` → `pack`.

## Rough monthly cost (Fly.io, USD)

- Machine: shared CPU, 1 GB RAM, stops when idle and starts on the next visit (a few seconds).
  About $6/month if it ran all month; light use is typically $1–3.
- Volume 6 GB: about $0.90. Outbound traffic: a few cents per GB.
- Total for light use: roughly **$2–5 per month**. AI chat is paid by each user's own Claude/OpenAI key.

## API (for the frontend)

`POST /api/<command>` with the same JSON arguments `invoke` sends (camelCase such as `useId`, `placeId`;
snake_case also accepted). Success: HTTP 200 with the same JSON the Tauri command returns. Failure: 4xx/5xx
with `{"error": "message"}` (503 while the data pack is still loading).

| Command | Arguments | Notes |
|---|---|---|
| status | – | Desktop shape plus `web: true`, `flags.web`, `pack` {state, tag, update, done, total, error}; `models` empty |
| search | `q` | |
| assess | `pid` | |
| potential | `pid`, `useId` | |
| suburb_stats | `suburb` | |
| flood_map, infra_map, contours | `pid` | contours cached on the volume |
| devi_land_number | `host`, `term` | string or null |
| google_suggest / google_pick | `q` / `placeId` | need the user's own key in header `X-Google-Key`, else 400 |
| chat | `pid`, `report`, `history` | streaming, see below |
| assistant | `pid` (or null), `history` | streaming |
| cancel_report | – | no-op (abort the fetch to cancel) |

Desktop-only commands return 404 JSON: import/download/set/delete model, import/download datapack,
save_bytes, save_text, read_backup, read_text_file, open_external, generate_report, draft_form,
summarise_title, save_ai_settings, set_api_key, ollama_models.

**AI chat:** headers `X-AI-Provider: anthropic|openai`, `X-AI-Key: <user's key>`, optional `X-AI-Model`
(defaults `claude-sonnet-5-5` / `gpt-4.1-mini`). The key is used for that one call only; it is never
stored or logged. Response is Server-Sent Events: each token is `data: "<JSON string>"`; a failure is
`event: error` + `data: "<message>"`; the end is `event: done`. Key problems before streaming come back
as JSON errors (400 missing key, 401 rejected key, 429 provider quota).

Other: `GET /healthz`; same-origin only (a foreign `Origin` gets 403); 1 MB request limit; per-IP limits
120 requests/min and 20 AI/Google calls/min (`RATE_PER_MIN`, `AI_RATE_PER_MIN`); `/assets/*` cached
forever (hashed names), everything else `no-cache`; gzip/brotli.

## Develop

```
cd server && cargo test                  # API tests use a tiny pack built in the test
npx vite build                           # frontend -> dist/
DATA_DIR=/path/with/datapack.sqlite DIST_DIR=../dist PORT=8080 cargo run --release
```
The "Web app" workflow builds and tests on every push to `main` or `web-server`, checks the Docker
image, and deploys from `main` only when the `FLY_API_TOKEN` secret exists.
