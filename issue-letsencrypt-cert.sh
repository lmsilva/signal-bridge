#!/usr/bin/env bash
# Host-side wrapper (run on the QNAP / Docker host — NOT inside the container).
#
# Starts an interactive Certbot DNS-01 session INSIDE the running signal-bridge
# container (manual TXT for Whois.com), installs PEMs to data/web-certs/, then
# restarts the container so Node reloads TLS. The container keeps running after
# this script exits.
#
# Prerequisites:
#   - signal-bridge container is up (./recreate.sh or docker compose up -d)
#   - Image includes certbot (Dockerfile) OR Alpine apk can install it on first run
#   - After a Dockerfile change: ./recreate.sh --build  (once)
#
# Usage:
#   ./issue-letsencrypt-cert.sh
#   ./issue-letsencrypt-cert.sh --staging
#   ./issue-letsencrypt-cert.sh --no-restart
#   ./issue-letsencrypt-cert.sh --domain other.example.com --email other@example.com
#
# Defaults (edit in this script or override via flags / CERTBOT_* env):
#   domain = signal.wittydigital.com
#   email  = luismiguelferreirasilva@gmail.com
#
# Env: CERTBOT_DOMAIN  CERTBOT_EMAIL  CONTAINER_NAME (default signal-bridge)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

CONTAINER="${CONTAINER_NAME:-signal-bridge}"
INSIDE="/app/scripts/issue-letsencrypt-inside.sh"
RESTART=1
STAGING=0
# Defaults (override with --domain / --email or CERTBOT_* env)
DOMAIN="${CERTBOT_DOMAIN:-signal.wittydigital.com}"
EMAIL="${CERTBOT_EMAIL:-luismiguelferreirasilva@gmail.com}"

usage() {
  sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    -d|--domain)
      DOMAIN="${2:?}"
      shift 2
      ;;
    -e|--email)
      EMAIL="${2:?}"
      shift 2
      ;;
    --staging)
      STAGING=1
      shift
      ;;
    --no-restart)
      RESTART=0
      shift
      ;;
    -h|--help)
      usage 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage 1
      ;;
  esac
done

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker not found on this host" >&2
  exit 1
fi

if ! docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -qx true; then
  echo "ERROR: container '$CONTAINER' is not running." >&2
  echo "Start it first:  cd $ROOT && ./recreate.sh" >&2
  exit 1
fi

# Prefer bind-mounted / image script. If missing (old image, no scripts volume), copy once.
if ! docker exec "$CONTAINER" test -f "$INSIDE" 2>/dev/null; then
  if [ -f "$ROOT/scripts/issue-letsencrypt-inside.sh" ]; then
    echo "In-container script missing — copying from host for this run..."
    docker exec "$CONTAINER" mkdir -p /app/scripts
    docker cp "$ROOT/scripts/issue-letsencrypt-inside.sh" "$CONTAINER:$INSIDE"
  else
    echo "ERROR: $INSIDE not found in container and host copy missing." >&2
    echo "Rebuild: ./recreate.sh --build" >&2
    exit 1
  fi
fi

# Ensure certbot exists (image should have it; otherwise apk install on Alpine).
if ! docker exec "$CONTAINER" sh -c 'command -v certbot >/dev/null'; then
  echo "Installing certbot inside container (apk)..."
  docker exec "$CONTAINER" sh -c 'apk add --no-cache certbot'
fi

echo ""
echo "Opening interactive Certbot inside '$CONTAINER'."
echo "Domain: $DOMAIN"
echo "Email:  $EMAIL"
echo "Add the TXT record in Whois when prompted, wait for DNS, then press Enter."
echo ""

# -it required for Certbot's manual DNS prompts. Use sh so +x on the NAS share is optional.
# Avoid bash arrays — QNAP's older bash + set -u breaks empty "${arr[@]}".
if [ "$STAGING" -eq 1 ]; then
  docker exec -it "$CONTAINER" sh "$INSIDE" --domain "$DOMAIN" --email "$EMAIL" --staging
else
  docker exec -it "$CONTAINER" sh "$INSIDE" --domain "$DOMAIN" --email "$EMAIL"
fi

if [ "$RESTART" -eq 1 ]; then
  echo ""
  echo "Restarting $CONTAINER so HTTPS loads the new certs..."
  docker restart "$CONTAINER"
  echo "Done. Browse https://$DOMAIN:47810/"
  echo "Tip: set GUEST_PHOTOBOOTH_URL and STEAM_OPENID_REALM to that origin in .env"
else
  echo ""
  echo "Skipped restart (--no-restart). Run: docker restart $CONTAINER"
fi

echo ""
echo "Renew before ~90 days by re-running: ./issue-letsencrypt-cert.sh"
