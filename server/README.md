# AI Town Planner – web server (phone app)

One installable web app for iPhone and Android, served free from a Hugging Face Docker Space. The server is a small Rust
program that reuses the desktop app's core, so both give the same answers. Users bring their own Claude/OpenAI key
(kept on their phone, sent per request, never stored or logged by the server).

Site: **https://<hf-username>-town-planner.hf.space** (the deploy log prints the exact address).

## Go live (owner, once)

1. Sign up at https://huggingface.co/join (email only, free, no card).
2. https://huggingface.co/settings/tokens → **Create new token** → type **Write**, name `github` → copy it.
3. https://github.com/falahjoon-prog/ai-town-planner/settings/secrets/actions → **New repository secret** →
   name `HF_TOKEN`, paste the token.
4. Re-run the "Web app" workflow on `main` (Actions tab → Web app → Run workflow). It creates the Space
   `<user>/town-planner`, uploads the app and Hugging Face builds it (first build ~10 min).
5. The first start downloads the newest data pack from the GitHub releases (~1–2 min); after that the app is ready.

Free tier: 2 CPU, 16 GB RAM, temporary disk. The Space sleeps after 48 h without visitors; the next visit wakes it
(about a minute, the data pack is downloaded again). Optional: add a Space secret `ADMIN_TOKEN` (Space → Settings)
to enable `POST /admin/refresh` (Authorization: Bearer <token>) for loading a newer data pack without a restart.

## Install on a phone

- **iPhone / iPad (Safari):** open the site in **Safari**, tap **Share** (square with arrow), then **Add to Home Screen**.
- **Android (Chrome):** open the site, tap **⋮**, then **Install app** (or **Add to Home screen**).
- In **Settings**, choose Claude or OpenAI and paste your own API key to use chat (it stays on your phone).

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
image, and deploys from `main` to the Hugging Face Space only when the `HF_TOKEN` secret exists.
