#!/bin/sh
set -e
cd "$(dirname "$0")/.."
OUT="data/diagnostics/auth-dump-$(date +%Y%m%d-%H%M%S).txt"
mkdir -p data/diagnostics

{
  echo "=== auth-status.json ==="
  cat data/auth-status.json 2>/dev/null || echo "(missing)"
  echo ""
  echo "=== session meta ==="
  if docker compose ps --status running alexa-broadcast >/dev/null 2>&1; then
    docker compose exec -T alexa-broadcast node -e "
      const c = require('./src/config').loadConfig();
      const s = require('./src/session').loadSession(c.sessionPath);
      const m = require('./src/session-meta').getSessionMeta(c, s);
      console.log(JSON.stringify(m, null, 2));
    " 2>/dev/null || echo "(docker exec node failed)"
  else
    node -e "
      const c = require('./src/config').loadConfig();
      const s = require('./src/session').loadSession(c.sessionPath);
      const m = require('./src/session-meta').getSessionMeta(c, s);
      console.log(JSON.stringify(m, null, 2));
    " 2>/dev/null || echo "(node failed — run from repo root or start container)"
  fi
  echo ""
  echo "=== auth journal (last 100 lines) ==="
  tail -100 data/session-auth-journal.jsonl 2>/dev/null || echo "(missing)"
  echo ""
  echo "=== voice events (last 30 lines) ==="
  tail -30 data/voice-events.jsonl 2>/dev/null || echo "(missing)"
  echo ""
  echo "=== docker logs (auth-related, last 72h) ==="
  docker compose logs --since 72h alexa-broadcast 2>&1 \
    | grep -iE 'session|auth|refresh|reauth|degraded|cookie|token|401|403|register|weather|voice event' \
    | tail -300 || echo "(docker logs failed)"
} | tee "$OUT"

echo "Wrote $OUT"
