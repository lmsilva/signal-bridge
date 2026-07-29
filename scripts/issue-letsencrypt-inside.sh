#!/bin/sh
# Runs INSIDE the signal-bridge container.
# Certbot DNS-01 (manual TXT) → /app/data/web-certs/{cert,key}.pem
# Certbot state persists on the data volume under /app/data/letsencrypt/
#
# Prefer the host wrapper: ./issue-letsencrypt-cert.sh (docker exec -it + restart).
# Direct use:
#   docker exec -it signal-bridge /app/scripts/issue-letsencrypt-inside.sh
#   docker exec -it signal-bridge sh /app/scripts/issue-letsencrypt-inside.sh --staging
#
# Defaults: domain=signal.wittydigital.com
#           email=luismiguelferreirasilva@gmail.com

set -eu

DOMAIN="${CERTBOT_DOMAIN:-signal.wittydigital.com}"
EMAIL="${CERTBOT_EMAIL:-luismiguelferreirasilva@gmail.com}"
STAGING=0
CERT_DIR="${WEB_CERT_DIR:-/app/data/web-certs}"
LE_DIR="${LETSENCRYPT_DIR:-/app/data/letsencrypt}"

usage() {
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
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
    -h|--help)
      usage 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage 1
      ;;
  esac
done

# Defaults already set above; only prompt if somehow empty after overrides.
if [ -z "$EMAIL" ]; then
  echo "Email is required (Let's Encrypt account contact)."
  printf "Enter email: "
  read -r EMAIL
fi
case "$EMAIL" in
  *@*) ;;
  *)
    echo "ERROR: valid --email / CERTBOT_EMAIL required" >&2
    exit 1
    ;;
esac
ensure_certbot() {
  if command -v certbot >/dev/null 2>&1; then
    return 0
  fi
  echo "certbot not found — installing via apk (Alpine)..."
  if ! command -v apk >/dev/null 2>&1; then
    echo "ERROR: certbot missing and apk not available. Rebuild the image with certbot." >&2
    exit 1
  fi
  apk add --no-cache certbot
}

ensure_certbot

mkdir -p "$LE_DIR/work" "$LE_DIR/logs" "$CERT_DIR"

echo ""
echo "=== Let's Encrypt DNS-01 (manual TXT) [inside container] ==="
echo "Domain:  $DOMAIN"
echo "Email:   $EMAIL"
echo "LE dir:  $LE_DIR"
echo "Dest:    $CERT_DIR/{cert.pem,key.pem}"
if [ "$STAGING" -eq 1 ]; then
  echo "Mode:    STAGING (not trusted by browsers — for dry runs)"
fi
echo ""
echo "Certbot will ask you to create a DNS TXT record:"
echo "  Host (relative):  _acme-challenge.<subdomain>   e.g. _acme-challenge.signal"
echo "  Full name:        _acme-challenge.$DOMAIN"
echo "Add it in Whois.com → DNS Management → TXT, wait ~1–5 minutes, then press Enter in Certbot."
echo ""

set -- certbot certonly \
  --manual \
  --preferred-challenges dns \
  --agree-tos \
  --no-eff-email \
  --config-dir "$LE_DIR" \
  --work-dir "$LE_DIR/work" \
  --logs-dir "$LE_DIR/logs" \
  -m "$EMAIL" \
  -d "$DOMAIN"

if [ "$STAGING" -eq 1 ]; then
  set -- "$@" --staging
fi

"$@"

LIVE="$LE_DIR/live/$DOMAIN"
FULLCHAIN="$LIVE/fullchain.pem"
PRIVKEY="$LIVE/privkey.pem"

if [ ! -f "$FULLCHAIN" ] || [ ! -f "$PRIVKEY" ]; then
  echo "ERROR: expected certs at $LIVE after certbot" >&2
  exit 1
fi

TMP_CERT="$CERT_DIR/cert.pem.new"
TMP_KEY="$CERT_DIR/key.pem.new"
cp "$FULLCHAIN" "$TMP_CERT"
cp "$PRIVKEY" "$TMP_KEY"
chmod 644 "$TMP_CERT"
chmod 600 "$TMP_KEY"
mv -f "$TMP_CERT" "$CERT_DIR/cert.pem"
mv -f "$TMP_KEY" "$CERT_DIR/key.pem"

echo ""
echo "Installed inside container (bind-mounted to host data/web-certs/):"
ls -la "$CERT_DIR/cert.pem" "$CERT_DIR/key.pem"
echo ""
echo "Exit this shell session; the host wrapper will restart the bridge to load TLS."
