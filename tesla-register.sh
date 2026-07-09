#!/bin/bash
set -e
cd "$(dirname "$0")"
# shellcheck source=scripts/tesla-common.sh
source "$(dirname "$0")/scripts/tesla-common.sh"

echo "Registering Tesla Fleet partner domain (NA)..."
tesla_run_node src/tesla-register.js "$@"

echo ""
echo "Done. Next: ./tesla-auth.sh (or npm run tesla-auth on your PC)"
echo "Pair virtual key on phone after OAuth."
