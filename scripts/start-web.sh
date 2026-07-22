#!/usr/bin/env bash
# Start the Next.js dev server fully detached (survives the parent shell),
# mirroring scripts/start-backend.sh. Stop with: scripts/stop-web.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${WEB_PORT:-3000}"
mkdir -p .devlogs

# Clean up any stale next processes for this app first.
pkill -f "web/node_modules/next" 2>/dev/null || true
sleep 1

setsid bash -c "cd web && exec ./node_modules/.bin/next dev -p $PORT" \
  > .devlogs/web.log 2>&1 < /dev/null &
disown || true

for i in $(seq 1 45); do
  if curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/login" | grep -q 200; then
    echo "web up on http://localhost:$PORT"
    exit 0
  fi
  sleep 2
done
echo "web did not come up — check .devlogs/web.log" >&2
exit 1
