#!/usr/bin/env bash
# Pull the newest main from GitHub; rebuild and restart only when it changed (run by atp-update.timer).
set -euo pipefail
cd /opt/atp
git fetch -q --depth 1 origin main
if [ "$(git rev-parse HEAD)" != "$(git rev-parse FETCH_HEAD)" ]; then
  git reset -q --hard FETCH_HEAD
  cd deploy/oracle && docker compose up -d --build --remove-orphans && docker image prune -f >/dev/null
fi
