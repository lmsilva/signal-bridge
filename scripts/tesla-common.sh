# Shared helpers for ./tesla-*.sh (source from repo root scripts only).

tesla_check_prereqs() {
  if ! docker image inspect signal-bridge:latest >/dev/null 2>&1; then
    if docker image inspect alexa-broadcast-bridge:latest >/dev/null 2>&1; then
      echo "Tagging existing alexa-broadcast-bridge:latest as signal-bridge:latest..."
      docker tag alexa-broadcast-bridge:latest signal-bridge:latest
    else
      echo ""
      echo "ERROR: Docker image signal-bridge:latest not found."
      echo "QNAP build often fails — build on another machine and docker load, or fix Container Station."
      exit 1
    fi
  fi

  if [[ ! -f .env ]]; then
    echo ""
    echo "ERROR: .env not found in $(pwd)"
    echo "Copy .env.example to .env and set TESLA_CLIENT_ID, TESLA_CLIENT_SECRET, TESLA_FLEET_DOMAIN"
    exit 1
  fi
}

tesla_listener_running() {
  docker compose ps --status running signal-bridge 2>/dev/null | grep -q signal-bridge \
    || docker compose ps --status running alexa-broadcast 2>/dev/null | grep -q alexa-broadcast
}

# Run a node command in the listener container, or a one-off container if stopped.
tesla_run_node() {
  tesla_check_prereqs

  if tesla_listener_running; then
    docker compose exec -T signal-bridge node "$@"
  else
    echo "Listener not running — using one-off container (./data mounted)..."
    docker compose run --rm --no-deps signal-bridge node "$@"
  fi
}

tesla_kill_port() {
  local port=$1

  docker rm -f alexa-broadcast-tesla-auth 2>/dev/null || true

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

tesla_wait_for_port_free() {
  local port=$1
  local attempt

  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    tesla_kill_port "$port"

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
    sleep 1
  done

  echo ""
  echo "ERROR: Port ${port} is still in use."
  echo "Find the process:  ss -tlnp | grep :${port}"
  return 1
}
