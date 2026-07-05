#!/bin/bash
set -e

# The NAS has no git; stop buildx from trying to capture commit info
# ("current commit information was not captured by the build" warning).
export BUILDX_GIT_INFO=false

# Restart using the existing image (works on QNAP when Docker build is broken).
# Use ./recreate.sh --build only when you changed Dockerfile/deps and build works.
if [[ "$1" == "--build" ]]; then
  docker compose up -d --build --force-recreate
else
  docker compose up -d --no-build --force-recreate
fi
