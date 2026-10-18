#!/usr/bin/env bash
# Run on a fresh Vultr Ubuntu 24.04 server as root:  DOMAIN=yourdomain.com bash vultr-setup.sh
set -euo pipefail
: "${DOMAIN:?set DOMAIN=yourdomain.com}"
REPO=${REPO:-https://github.com/syedjafri06193/DubHacks-2026-Hack.git}
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs git debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy
mkdir -p /srv && cd /srv
[ -d DubHacks-2026-Hack ] || git clone "$REPO"
cd "DubHacks-2026-Hack/Submissions/Food Waste Marketplace/app"
git pull && npm ci --omit=dev
[ -f .env ] || { cp .env.example .env; echo ">>> Edit $(pwd)/.env with your keys, then: pm2 restart lastcall --update-env"; }
grep -q '^PUBLIC_URL=' .env && sed -i "s#^PUBLIC_URL=.*#PUBLIC_URL=https://$DOMAIN#" .env
npm i -g pm2
pm2 start src/server.js --name lastcall --node-args="--no-warnings" || pm2 restart lastcall --update-env
pm2 save && pm2 startup systemd -u root --hp /root | tail -1 | bash || true
printf '%s {\n  encode gzip\n  reverse_proxy localhost:3000\n}\n' "$DOMAIN" > /etc/caddy/Caddyfile
systemctl reload caddy
ufw allow 80,443/tcp 2>/dev/null || true
echo "Done → https://$DOMAIN  (health: https://$DOMAIN/api/v1/health)"
