#!/usr/bin/env bash
# One-time server setup (run by cloud-init as root). Safe to run again.
set -euo pipefail
cd /opt/atp/deploy/oracle

# 1 GB machines: add swap so unpacking the data pack never runs out of memory.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

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

DEBIAN_FRONTEND=noninteractive apt-get install -y caddy
cat > /etc/caddy/Caddyfile <<CADDY
$SITE {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8080
}
CADDY

install -m 644 atp.service atp-update.service atp-update.timer /etc/systemd/system/
systemctl daemon-reload
bash update.sh
systemctl enable --now atp-update.timer
systemctl restart caddy
echo "AI Town Planner: https://$SITE" | tee /opt/atp-url.txt
