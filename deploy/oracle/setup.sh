#!/usr/bin/env bash
# One-time server setup (run by cloud-init as root). Safe to run again.
set -euo pipefail
cd /opt/atp/deploy/oracle

# Packages. First boot: unattended-upgrades often holds the dpkg lock, so wait for it instead of failing.
export DEBIAN_FRONTEND=noninteractive
echo "iptables-persistent iptables-persistent/autosave_v4 boolean true" | debconf-set-selections
echo "iptables-persistent iptables-persistent/autosave_v6 boolean true" | debconf-set-selections
apt-get -o DPkg::Lock::Timeout=900 update
apt-get -o DPkg::Lock::Timeout=900 install -y caddy netfilter-persistent iptables-persistent

# 1 GB machines: add swap so unpacking the data pack never runs out of memory.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# Oracle's Ubuntu images block everything except SSH in iptables: open HTTP/HTTPS.
for port in 80 443; do
  iptables -C INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT 2>/dev/null ||
    iptables -I INPUT 1 -p tcp --dport "$port" -m state --state NEW -j ACCEPT
done
netfilter-persistent save

install -m 644 atp.service atp-update.service atp-update.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now atp-update.timer
bash site.sh
# First install now; if the GitHub build isn't published yet, the timer retries every 15 minutes.
bash update.sh || echo "App download not available yet; atp-update.timer will retry."
cat /opt/atp-url.txt
