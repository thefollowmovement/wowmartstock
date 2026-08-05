#!/usr/bin/env bash
# WowMart Stock — installation sur un VPS Ubuntu (22.04 / 24.04)
# Usage : bash deploy/install.sh   (en root)
# Installe Node.js 22, met l'app en service systemd (démarrage automatique),
# propose le HTTPS automatique via Caddy, et configure le pare-feu.
set -euo pipefail

APP_DIR="/opt/wowmartstock"
SERVICE_USER="wowmart"
BACKUP_DIR="/var/backups/wowmart"

[ "$(id -u)" -eq 0 ] || { echo "Lancez ce script en root : sudo bash deploy/install.sh"; exit 1; }

echo "══════════════════════════════════════════"
echo "  WowMart Stock — installation serveur"
echo "══════════════════════════════════════════"

# ---------------------------------------------------------------- Node.js 22+
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  echo "→ Installation de Node.js 22…"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
apt-get install -y git >/dev/null
echo "→ Node $(node -v) ✓"

# ------------------------------------------------------------------- le code
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [ "$SRC_DIR" != "$APP_DIR" ]; then
  echo "→ Copie de l'application dans $APP_DIR…"
  mkdir -p "$APP_DIR"
  cp -a "$SRC_DIR/." "$APP_DIR/"
fi
cd "$APP_DIR"
echo "→ Dépendances npm…"
npm install --omit=dev --no-audit --no-fund

# ------------------------------------------------- utilisateur système dédié
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
mkdir -p "$APP_DIR/data" "$APP_DIR/uploads" "$BACKUP_DIR"
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR" "$BACKUP_DIR"

# ------------------------------------------------------------- fuseau horaire
timedatectl set-timezone Europe/Paris 2>/dev/null && echo "→ Fuseau horaire : Europe/Paris ✓" || true

# ------------------------------------------------------------ HTTPS (Caddy) ?
DOMAIN_DEFAULT="$(hostname -f 2>/dev/null || hostname)"
read -rp "Nom de domaine pour l'accès HTTPS [${DOMAIN_DEFAULT}] : " DOMAIN
DOMAIN="${DOMAIN:-$DOMAIN_DEFAULT}"

USE_CADDY=1
if ss -ltn 2>/dev/null | grep -qE ':(80|443)\s'; then
  echo ""
  echo "⚠ Les ports 80/443 sont déjà occupés — sur un VPS Hostinger c'est en"
  echo "  général HestiaCP (nginx/apache). Si vous n'utilisez PAS HestiaCP pour"
  echo "  héberger d'autres sites, on peut le désactiver pour installer le"
  echo "  HTTPS automatique."
  read -rp "Désactiver nginx/apache/HestiaCP et installer le HTTPS (Caddy) ? (o/N) : " REP
  if [[ "${REP:-}" =~ ^[oO] ]]; then
    systemctl disable --now hestia nginx apache2 2>/dev/null || true
  else
    USE_CADDY=0
  fi
fi

HOST_BIND="127.0.0.1"
if [ "$USE_CADDY" -eq 1 ]; then
  if ! command -v caddy >/dev/null 2>&1; then
    echo "→ Installation de Caddy (HTTPS automatique)…"
    apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl >/dev/null
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update >/dev/null && apt-get install -y caddy
  fi
  cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
    reverse_proxy 127.0.0.1:3000
}
EOF
  systemctl enable --now caddy
  systemctl reload caddy || systemctl restart caddy
  echo "→ HTTPS configuré pour https://$DOMAIN ✓ (certificat automatique)"
else
  HOST_BIND="0.0.0.0"
  echo "⚠ Sans HTTPS : l'app sera servie en HTTP simple sur le port 3000."
  echo "  Utilisez un mot de passe FORT et prévoyez le HTTPS rapidement."
fi

# --------------------------------------------------------- service systemd
cat > /etc/systemd/system/wowmartstock.service <<EOF
[Unit]
Description=WowMart Stock — gestion de stock
After=network.target

[Service]
User=$SERVICE_USER
WorkingDirectory=$APP_DIR
Environment=PORT=3000
Environment=HOST=$HOST_BIND
# Recommandé : la clé API par variable d'environnement plutôt qu'en base
# Environment=ANTHROPIC_API_KEY=sk-ant-…
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now wowmartstock
sleep 2
systemctl --no-pager --lines=3 status wowmartstock || true

# ----------------------------------------------------------------- pare-feu
if command -v ufw >/dev/null 2>&1; then
  ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22/tcp >/dev/null 2>&1 || true
  ufw allow 80/tcp >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  [ "$USE_CADDY" -eq 0 ] && ufw allow 3000/tcp >/dev/null 2>&1 || true
  ufw --force enable >/dev/null 2>&1 || true
  echo "→ Pare-feu configuré ✓"
fi

echo ""
echo "══════════════════════════════════════════"
echo "  ✅ Installation terminée !"
echo "══════════════════════════════════════════"
if [ "$USE_CADDY" -eq 1 ]; then
  echo "  Ouvrez :  https://$DOMAIN"
else
  echo "  Ouvrez :  http://$(curl -4s ifconfig.me 2>/dev/null || echo VOTRE_IP):3000"
fi
echo ""
echo "  À FAIRE TOUT DE SUITE dans l'app :"
echo "  1. Onglet Importer → 🔒 : définissez un MOT DE PASSE (l'app est sur Internet !)"
echo "  2. Onglet Importer → 💾 : dossier de sauvegarde → $BACKUP_DIR"
echo "  3. Resaisissez vos clés API (Anthropic, Google) : elles sont propres à chaque machine."
echo ""
echo "  Mises à jour :   bash $APP_DIR/deploy/update.sh"
echo "  Journal :        journalctl -u wowmartstock -f"
