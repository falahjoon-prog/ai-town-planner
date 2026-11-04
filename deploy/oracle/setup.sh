#!/usr/bin/env bash
# One-time server setup (run by cloud-init as root). Safe to run again.
set -euo pipefail
cd /opt/atp/deploy/oracle

# Oracle's Ubuntu images block everything except SSH in iptables: open HTTP/HTTPS.
for port in 80 443; do
  iptables -C INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT 2>/dev/null ||
    iptables -I INPUT 6 -p tcp --dport "$port" -m state --state NEW -j ACCEPT
done
netfilter-persistent save

# Site name: the owner's own domain if set in /opt/atp-site, else <public-ip>.sslip.io
# (free wildcard DNS, so Caddy can get a Let's Encrypt certificate without buying a domain).
if [ -s /opt/atp-site ]; then SITE=$(tr -d '[:space:]' < /opt/atp-site)
else SITE="$(curl -fsS https://api.ipify.org | tr . -).sslip.io"; fi
echo "SITE=$SITE" > .env

docker compose up -d --build
install -m 644 atp-update.service atp-update.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now atp-update.timer
echo "AI Town Planner: https://$SITE" | tee /opt/atp-url.txt
