#!/usr/bin/env bash
# Low-memory launcher: runs each service from compiled dist (node, not ts-node).
# Use this instead of `pnpm dev` on machines with limited RAM.
# Logs to ./.devlogs/<service>.log ; PIDs in ./.devlogs/pids
cd "$(dirname "$0")/.."
ROOT="$PWD"
mkdir -p .devlogs
: > .devlogs/pids

start() { # name  path  port
  # setsid detaches the process into its own session so it survives this
  # launcher shell exiting (no SIGHUP).
  setsid env PORT="$3" node "$ROOT/$2/dist/main.js" > ".devlogs/$1.log" 2>&1 < /dev/null &
  echo "$! $1" >> .devlogs/pids
  echo "  started $1 (port $3, pid $!)"
}

echo "starting backend services from dist…"
start auth         apps/services/auth         4101
start course       apps/services/course       4102
start enrollment   apps/services/enrollment   4103
start outcomes     apps/services/outcomes     4104
start financial    apps/services/financial    4105
start quality      apps/services/quality      4106
start notification apps/services/notification 4107
sleep 3
start gateway      apps/gateway               4000
echo "done — logs in .devlogs/, stop with: scripts/stop-backend.sh"
