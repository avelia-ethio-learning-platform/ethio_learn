#!/usr/bin/env bash
# Stop the detached Next.js dev server started by start-web.sh.
pkill -f "web/node_modules/next" 2>/dev/null && echo "web stopped" || echo "web was not running"
