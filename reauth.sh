#!/bin/bash
set -e
cd "$(dirname "$0")"

PROXY_PORT="${PROXY_PORT:-3456}"
PROXY_OWN_IP="${PROXY_OWN_IP:-}"

if [[ -z "$PROXY_OWN_IP" ]]; then
  PROXY_OWN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
fi

if [[ -z "$PROXY_OWN_IP" ]]; then
  echo "Set your NAS LAN IP first, for example:"
  echo "  PROXY_OWN_IP=192.168.1.10 ./reauth.sh"
  exit 1
fi

echo "Stopping listener and any old auth container..."
docker compose stop alexa-broadcast-bridge 2>/dev/null || true
docker rm -f alexa-broadcast-auth 2>/dev/null || true

echo "Checking port ${PROXY_PORT}..."
if command -v ss >/dev/null 2>&1; then
  ss -tlnp | grep ":${PROXY_PORT} " || true
elif command -v netstat >/dev/null 2>&1; then
  netstat -tlnp 2>/dev/null | grep ":${PROXY_PORT} " || true
fi

if command -v fuser >/dev/null 2>&1; then
  fuser -k "${PROXY_PORT}/tcp" 2>/dev/null || true
  sleep 1
fi

echo ""
echo "Starting Amazon login proxy on http://${PROXY_OWN_IP}:${PROXY_PORT}/"
echo "Log in with your Amazon account, wait for 'Authentication complete', then press Ctrl+C."
echo ""

PROXY_OWN_IP="$PROXY_OWN_IP" PROXY_PORT="$PROXY_PORT" \
  docker compose -p alexa-auth -f docker-compose.auth.yml up

echo ""
echo "Starting listener..."
docker compose up -d --force-recreate

echo ""
echo "Done. Check logs with: docker compose logs -f"
