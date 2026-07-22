#!/usr/bin/env bash
# Stops services started by start-backend.sh.
cd "$(dirname "$0")/.."
if [ -f .devlogs/pids ]; then
  while read -r pid name; do kill "$pid" 2>/dev/null && echo "stopped $name"; done < .devlogs/pids
  : > .devlogs/pids
fi
# Sweep orphans from earlier runs — the pids file only knows the most recent
# start, and a stale survivor keeps its port serving OLD code (EADDRINUSE for
# the replacement, silently wrong behavior for callers). This catches BOTH
# launch styles: dist (`node <abs>/dist/main.js`, cwd = repo root) and ts-node
# via `pnpm dev` (cwd = the service package dir). The web dev server is never
# touched (its command line contains "next").
sleep 1
ROOT="$(pwd -P)"
swept=0
for pid in $(ls /proc 2>/dev/null | grep -E '^[0-9]+$'); do
  cmd="$( { tr '\0' ' ' < "/proc/$pid/cmdline"; } 2>/dev/null || true)"
  case "$cmd" in *node*) ;; *) continue ;; esac
  case "$cmd" in *next*) continue ;; esac
  case "$cmd" in *stop-backend*) continue ;; esac
  cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
  case "$cwd" in
    "$ROOT/api/services/"* | "$ROOT/api/gateway"*)
      kill "$pid" 2>/dev/null && swept=$((swept + 1)) ;;
    "$ROOT")
      # dist launches + turbo/pnpm dev supervisors run from the repo root;
      # only kill ones that look like our services or their supervisor.
      case "$cmd" in
        *dist/main.js* | *ts-node* | *turbo* | *"pnpm"*dev*)
          kill "$pid" 2>/dev/null && swept=$((swept + 1)) ;;
      esac ;;
  esac
done
[ "$swept" -gt 0 ] && echo "swept $swept orphan service process(es)"
sleep 1
exit 0
