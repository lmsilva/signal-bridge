#!/bin/bash
set -e
cd "$(dirname "$0")"
# shellcheck source=scripts/tesla-common.sh
source "$(dirname "$0")/scripts/tesla-common.sh"

tesla_check_prereqs

DOMAIN="$(grep -E '^TESLA_FLEET_DOMAIN=' .env 2>/dev/null | cut -d= -f2- | tr -d '\r' || true)"

echo "=== Tesla Fleet setup status ==="
echo ""

if [[ -f data/tesla-session.json ]]; then
  echo "tesla-session.json: present"
  if command -v node >/dev/null 2>&1; then
    node -e "
      const s = require('./data/tesla-session.json');
      console.log('  savedAt:', s.savedAt || '(unknown)');
      console.log('  expiresAt:', s.expiresAt || '(unknown)');
      console.log('  refreshToken:', s.refreshToken ? 'yes' : 'no');
    " 2>/dev/null || true
  fi
else
  echo "tesla-session.json: MISSING — run tesla-auth-pc.bat on your PC (or npm run tesla-auth)"
fi

echo ""

if [[ -f data/tesla-auth-status.json ]]; then
  echo "tesla-auth-status.json:"
  cat data/tesla-auth-status.json
  echo ""
else
  echo "tesla-auth-status.json: (none — session healthy or not checked yet)"
fi

echo ""
if [[ -n "$DOMAIN" ]]; then
  echo "Virtual key URL: https://www.tesla.com/_ak/${DOMAIN}"
  echo "PEM check:       https://${DOMAIN}/.well-known/appspecific/com.tesla.3p.public-key.pem"
fi

echo ""
echo "Commands:"
echo "  ./tesla-register.sh         Register domain with Tesla (once)"
echo "  ./tesla-verify-register.sh  Confirm registration"
echo "  ./tesla-auth.sh               OAuth login (saves data/tesla-session.json)"
echo "  ./recreate.sh                 Restart listener after .env changes"
