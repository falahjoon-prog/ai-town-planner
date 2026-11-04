# AI Town Planner – web server (phone app)

One installable web app for iPhone and Android, served free from an Oracle Cloud "Always Free" server. The server
is a small Rust program that reuses the desktop app's core, so both give the same answers. Users bring their own
Claude/OpenAI key (kept on their phone, sent per request, never stored or logged by the server).

Site: **https://<server-ip-with-dashes>.sslip.io** (written to `/opt/atp-url.txt` on the server), or your own domain.

## Go live (owner, once) – files in `deploy/oracle/`

1. Oracle Cloud account (Always Free), home region Australia East (Sydney).
2. Network: "Create VCN with internet connectivity" wizard; in its Default Security List add an ingress rule
   `0.0.0.0/0`, TCP, destination ports `80,443`.
3. Compute → Create instance: **Ubuntu 24.04**, shape **VM.Standard.E2.1.Micro** (Always Free; A1.Flex also works
   when Sydney has capacity), the VCN's public subnet with a public IPv4 address, and paste
   `deploy/oracle/cloud-init.yaml` as the initialization script.
4. After ~10 minutes open `https://<public-ip-with-dashes>.sslip.io`. The first start downloads the data pack
   (a few minutes on the small server).

The "Web server" workflow publishes a pre-built `town-planner-web-linux-amd64.tar.gz` to the `web-latest`
release on every push to `main`; the server checks it every 15 minutes (`atp-update.timer`) and restarts the app
when it changed. No Docker and no build on the server (it has 1 GB RAM; setup adds 2 GB swap). Caddy (apt)
serves HTTPS. Own domain later: point an A record at the server IP, write the name into `/opt/atp-site` and run
`sudo bash /opt/atp/deploy/oracle/setup.sh`.

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
image; the Oracle server pulls `main` itself (no deploy secrets).
