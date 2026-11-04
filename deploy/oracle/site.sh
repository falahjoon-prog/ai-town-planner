#!/usr/bin/env bash
# Write the Caddy config from site.txt (plus the <public-ip>.sslip.io fallback); reload Caddy when it changed.
set -euo pipefail
cd /opt/atp/deploy/oracle
FALLBACK="$(curl -fsS https://api.ipify.org | tr . -).sslip.io"
NAMES=$( { grep -vE '^\s*(#|$)' site.txt || true; echo "$FALLBACK"; } | sed 's/[[:space:]]//g' | paste -sd, - | sed 's/,/, /g')
NEW=$(printf '%s {\n\tencode zstd gzip\n\treverse_proxy 127.0.0.1:8080\n}\n' "$NAMES")
if [ "$NEW" != "$(cat /etc/caddy/Caddyfile 2>/dev/null)" ]; then
  printf '%s' "$NEW" > /etc/caddy/Caddyfile
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
fi
echo "AI Town Planner: https://${NAMES%%,*}" > /opt/atp-url.txt
