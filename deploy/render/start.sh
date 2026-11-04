#!/bin/sh
# API (migrates + seeds if empty) -> wait for health -> worker -> nginx in the foreground.
set -e
PORT=3000 npx tsx src/server.ts &
until wget -qO- http://127.0.0.1:3000/health >/dev/null 2>&1; do sleep 1; done
npx tsx src/worker.ts &
exec nginx -g 'daemon off;'
