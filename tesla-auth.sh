#!/bin/bash
set -e
cd "$(dirname "$0")"
# shellcheck source=scripts/tesla-common.sh
source "$(dirname "$0")/scripts/tesla-common.sh"

TESLA_AUTH_PORT="${TESLA_AUTH_PORT:-4381}"

run_code_exchange() {
  local code="$1"
  tesla_check_prereqs
  echo "Exchanging authorization code for tokens..."
  local redirect="http://localhost:${TESLA_AUTH_PORT}/callback"
  if tesla_listener_running; then
    docker compose exec -T \
      -e TESLA_OAUTH_REDIRECT_URI="$redirect" \
      -e TESLA_REDIRECT_URI="$redirect" \
      signal-bridge node src/tesla-auth.js --code "$code"
  else
    docker compose run --rm --no-deps \
      -e TESLA_OAUTH_REDIRECT_URI="$redirect" \
      -e TESLA_REDIRECT_URI="$redirect" \
      signal-bridge node src/tesla-auth.js --code "$code"
  fi
}

if [[ "${1:-}" == "--code" && -n "${2:-}" ]]; then
  run_code_exchange "$2"
  echo ""
  echo "Done. Run ./tesla-status.sh then ./recreate.sh"
  exit 0
fi

if [[ "${TESLA_USE_LOCALHOST_REDIRECT:-0}" != "1" ]]; then
  echo ""
  echo "Tesla developer portal only allows http:// for localhost — not LAN IPs like 192.168.x.x."
  echo ""
  echo "Recommended (easiest) — run on your Windows PC:"
  echo "  cd \\\\nas\\container\\signal-bridge"
  echo "  npm run tesla-auth"
  echo "  (or double-click tesla-auth-pc.bat)"
  echo ""
  echo "Session is saved to data/tesla-session.json on this NAS share."
  echo ""
  echo "Advanced — SSH tunnel from PC, then re-run on NAS:"
  echo "  On PC:  ssh -L 4381:127.0.0.1:4381 user@YOUR_NAS_IP"
  echo "  On NAS: TESLA_USE_LOCALHOST_REDIRECT=1 ./tesla-auth.sh"
  echo ""
  exit 1
fi

export TESLA_OAUTH_REDIRECT_URI="http://localhost:${TESLA_AUTH_PORT}/callback"

tesla_check_prereqs

echo ""
echo "Using redirect URI: ${TESLA_OAUTH_REDIRECT_URI}"
echo "Ensure your PC has an SSH tunnel:  ssh -L 4381:127.0.0.1:4381 user@NAS_IP"
echo ""

echo "Freeing port ${TESLA_AUTH_PORT}..."
tesla_wait_for_port_free "${TESLA_AUTH_PORT}" || exit 1

echo ""
echo "1. Open the authorize URL below in your PC browser (with SSH tunnel active)."
echo "2. Log in with Tesla and approve the app."
echo "3. Wait for 'Tesla authentication complete'."
echo ""

TESLA_OAUTH_REDIRECT_URI="$TESLA_OAUTH_REDIRECT_URI" \
  docker compose -p alexa-tesla-auth -f docker-compose.tesla-auth.yml up --no-build

echo ""
echo "Session saved to data/tesla-session.json"
echo "Restart listener: ./recreate.sh"
