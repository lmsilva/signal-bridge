#!/bin/bash
set -e
cd "$(dirname "$0")"

# NAS has no git; stop buildx provenance warning.
export BUILDX_GIT_INFO=false

# Prefer the Signal Bridge image name; keep working if only the legacy tag exists.
if ! docker image inspect signal-bridge:latest >/dev/null 2>&1; then
  if docker image inspect alexa-broadcast-bridge:latest >/dev/null 2>&1; then
    echo "Tagging existing alexa-broadcast-bridge:latest as signal-bridge:latest..."
    docker tag alexa-broadcast-bridge:latest signal-bridge:latest
  fi
fi

# ./src is bind-mounted into the container (docker-compose.yml). Code edits on the
# share apply on restart — you do NOT need a successful docker build for JS changes.
restart_container() {
  docker compose up -d --no-build --force-recreate
}

if [[ "$1" == "--build" ]]; then
  echo "Attempting image rebuild (optional — src/ is bind-mounted)..."
  if docker compose build; then
    echo "Build OK."
    docker compose up -d --force-recreate
  else
    echo ""
    echo "WARN: docker build failed (QNAP Container Station ZFS errors are common)."
    echo "      Your ./src folder is mounted into the container — restarting with"
    echo "      the existing image still picks up code changes."
    echo ""
    restart_container
  fi
else
  echo "Restarting listener (./src mounted — code changes apply without rebuild)..."
  restart_container
fi

echo ""
echo "Done. Logs: docker compose logs -f"
