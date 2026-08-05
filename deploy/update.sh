#!/usr/bin/env bash
# WowMart Stock — mise à jour sur le serveur : bash deploy/update.sh
set -euo pipefail
APP_DIR="/opt/wowmartstock"
cd "$APP_DIR"
echo "→ Récupération de la dernière version…"
git pull
npm install --omit=dev --no-audit --no-fund
chown -R wowmart:wowmart "$APP_DIR" 2>/dev/null || true
systemctl restart wowmartstock
sleep 2
systemctl --no-pager --lines=3 status wowmartstock
echo "✅ Mise à jour terminée."
