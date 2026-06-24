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
  echo "PROXY_OWN_IP=192.168.1.10 ./reauth.sh"
  exit 1
fi

kill_port_listeners() {
  local port=$1

  docker rm -f alexa-broadcast-auth 2>/dev/null || true

  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${port}/tcp" 2>/dev/null || true
  fi

  local pids=""
  if command -v ss >/dev/null 2>&1; then
    pids="$(ss -tlnp 2>/dev/null | grep ":${port} " | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | sort -u)"
  elif command -v netstat >/dev/null 2>&1; then
    pids="$(netstat -tlnp 2>/dev/null | grep ":${port} " | awk '{print $7}' | cut -d/ -f1 | sort -u)"
  fi

  for pid in $pids; do
    if [[ -n "$pid" && "$pid" =~ ^[0-9]+$ ]]; then
      echo "Killing process ${pid} holding port ${port}..."
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
}

wait_for_port_free() {
  local port=$1
  local attempt

  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    kill_port_listeners "$port"

    if command -v ss >/dev/null 2>&1; then
      if ! ss -tln 2>/dev/null | grep -q ":${port} "; then
        echo "Port ${port} is free."
        return 0
      fi
    elif command -v netstat >/dev/null 2>&1; then
      if ! netstat -tln 2>/dev/null | grep -q ":${port} "; then
        echo "Port ${port} is free."
        return 0
      fi
    else
      sleep 2
      return 0
    fi

    echo "Port ${port} still in use (attempt ${attempt}/10)..."
    if command -v ss >/dev/null 2>&1; then
      ss -tlnp 2>/dev/null | grep ":${port} " || true
    fi
    sleep 1
  done

  echo ""
  echo "ERROR: Port ${port} is still in use."
  echo "Find the process:  ss -tlnp | grep :${port}"
  echo "Then kill it:        kill -9 <pid>"
  echo "Or use another port: PROXY_PORT=$((port + 1)) PROXY_OWN_IP=${PROXY_OWN_IP} ./reauth.sh"
  return 1
}

echo "Stopping listener and any old auth container..."
docker compose stop alexa-broadcast 2>/dev/null || true
docker stop alexa-broadcast-bridge 2>/dev/null || true
docker rm -f alexa-broadcast-auth 2>/dev/null || true

echo "Freeing port ${PROXY_PORT}..."
wait_for_port_free "${PROXY_PORT}" || exit 1

if ! docker image inspect alexa-broadcast-bridge:latest >/dev/null 2>&1; then
  echo ""
  echo "ERROR: Docker image alexa-broadcast-bridge:latest not found."
  echo "QNAP build often fails — build the image on another machine and load it, or fix Container Station."
  echo "If the listener was running before, the image should already exist."
  exit 1
fi

echo ""
echo "Starting Amazon login proxy on http://${PROXY_OWN_IP}:${PROXY_PORT}/"
echo "Log in with your Amazon account, wait for 'Authentication complete', then press Ctrl+C."
echo "(Do not press Ctrl+C until you see 'Authentication complete' — container startup can take a few seconds.)"
echo ""

PROXY_OWN_IP="$PROXY_OWN_IP" PROXY_PORT="$PROXY_PORT" \
  docker compose -p alexa-auth -f docker-compose.auth.yml up --no-build

echo ""
echo "Starting listener..."
docker compose up -d --no-build --force-recreate

echo ""
echo "Done. Check logs with: docker compose logs -f"
