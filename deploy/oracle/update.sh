#!/usr/bin/env bash
# Install the newest pre-built web app from GitHub (release "web-latest") when it changed,
# then restart the app (run by setup.sh and every 15 minutes by atp-update.timer). Also refreshes
# the setup scripts from GitHub and the web addresses in site.txt.
set -euo pipefail
# Keep the setup scripts and web addresses current (site.txt), then the app itself.
git -C /opt/atp pull -q --ff-only || true
bash /opt/atp/deploy/oracle/site.sh || true
URL=https://github.com/falahjoon-prog/ai-town-planner/releases/download/web-latest/town-planner-web-linux-amd64.tar.gz
APP=/opt/atp-app
mkdir -p "$APP"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
curl -fsSL -o "$TMP/app.tgz" "$URL"
NEW=$(sha256sum "$TMP/app.tgz" | cut -c1-16)
if [ "$(readlink "$APP/current" 2>/dev/null)" != "$APP/$NEW" ]; then
  mkdir -p "$APP/$NEW" && tar -xzf "$TMP/app.tgz" -C "$APP/$NEW"
  ln -sfn "$APP/$NEW" "$APP/current"
  systemctl enable atp.service >/dev/null 2>&1
  systemctl restart atp.service
  find "$APP" -mindepth 1 -maxdepth 1 -type d ! -name "$NEW" -exec rm -rf {} +
fi
