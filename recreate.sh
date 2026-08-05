#!/bin/bash
set -e
cd "$(dirname "$0")"

# NAS has no git; stop buildx provenance warning.
export BUILDX_GIT_INFO=false

# Prefer signal-bridge:latest; retag once if only the old image name exists on this NAS.
if ! docker image inspect signal-bridge:latest >/dev/null 2>&1; then
  if docker image inspect alexa-broadcast-bridge:latest >/dev/null 2>&1; then
    echo "Tagging alexa-broadcast-bridge:latest as signal-bridge:latest..."
    docker tag alexa-broadcast-bridge:latest signal-bridge:latest
  fi
fi

# Listener is signal-bridge only. Drop any stopped one-shot auth helpers and
# pre-rename leftovers so Container Station stays clean (safe no-op if absent).
docker rm -f \
  signal-alexa-auth \
  signal-tesla-auth \
  alexa-broadcast-bridge \
  alexa-broadcast-auth \
  alexa-broadcast-tesla-auth \
  >/dev/null 2>&1 || true

# ./src is bind-mounted (docker-compose.yml). JS edits apply on restart — no image
# rebuild required for normal code changes.
# Use --build when package.json / Dockerfile dependencies change (e.g. certbot,
# sharp for Slideshow thumbnails).
restart_listener() {
  docker compose up -d --no-build --force-recreate --remove-orphans
}

if [[ "$1" == "--build" ]]; then
  echo "Attempting image rebuild (optional — src/ is bind-mounted)..."
  if docker compose build; then
    echo "Build OK."
    docker compose up -d --force-recreate --remove-orphans
  else
    echo ""
    echo "WARN: docker build failed (QNAP Container Station ZFS errors are common)."
    echo "      ./src is mounted — restarting with the existing image still picks up code changes."
    echo ""
    restart_listener
  fi
else
  echo "Restarting signal-bridge (./src mounted — code changes apply without rebuild)..."
  restart_listener
fi

echo ""
echo "Done. Logs: docker compose logs -f signal-bridge"
