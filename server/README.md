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

## Sign-in and licence (Trade AI accounts)

Every `/api/*` call needs a signed-in Trade AI account with a running trial or a paid seat for the product
`townplanner` (licensing/README.md). The browser signs in to Supabase itself and sends
`Authorization: Bearer <access token>` plus `X-Device-Id` (a random id kept by the phone; each phone is a
device / seat). The server calls Supabase `rpc/product_access` with that token: Supabase checks the token
(signature, expiry), the function checks the trial / licence and takes or refreshes the seat. Answers are
cached 60 s per token and device (refusals 20 s; if Supabase is unreachable, a token that passed in the last
15 minutes keeps working). Tokens are never logged.

| Answer | When |
|---|---|
| 401 `{"error"}` | no token, bad or expired token – the app shows the sign-in page |
| 402 `{"error", "licence"}` | trial over / licence ended ("Licence needed — buy at trade-ai.com.au"), all seats in use, account disabled |
| 503 `{"error"}` | sign-in not set up on this server, or Supabase unreachable |

Settings (environment; `deploy/oracle/atp.service` reads `/etc/atp/atp.env`):

| Variable | Default | |
|---|---|---|
| `SUPABASE_URL` | built in from the repository variable `TRADEAI_SUPABASE_URL` | Trade AI Supabase project URL |
| `SUPABASE_ANON_KEY` | built in from `TRADEAI_SUPABASE_ANON_KEY` | public anon key (never the service_role key) |
| `SUPABASE_JWT_SECRET` | – | optional legacy HS256 secret: tokens are also checked locally |
| `LICENCE_PRODUCT` | `townplanner` | |

Without a URL and anon key every API call answers 503 "Sign-in is not set up on this server yet".

## API (for the frontend)

`POST /api/<command>` with the same JSON arguments `invoke` sends (camelCase such as `useId`, `placeId`;
snake_case also accepted). Success: HTTP 200 with the same JSON the Tauri command returns. Failure: 4xx/5xx
with `{"error": "message"}` (503 while the data pack is still loading).

| Command | Arguments | Notes |
|---|---|---|
| auth_config | – | no token needed: `{configured, url, anon_key, product}` for the sign-in page |
| licence_state | – | token needed, licence not: the `product_access` answer + `message`, `days_left` (200 even when refused) |
| auth_sign_out | – | gives this phone's seat back |
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
The "Web server" workflow builds and tests on every push to `main` or `web-server` and, on `main`, publishes
the pre-built bundle to the `web-latest` release.
