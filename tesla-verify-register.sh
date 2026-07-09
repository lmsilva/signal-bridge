#!/bin/bash
set -e
cd "$(dirname "$0")"
# shellcheck source=scripts/tesla-common.sh
source "$(dirname "$0")/scripts/tesla-common.sh"

echo "Verifying Tesla Fleet partner registration..."
tesla_run_node src/tesla-register.js --verify-only "$@"

echo ""
echo "Registration OK. Run ./tesla-auth.sh if you have not completed OAuth yet."
