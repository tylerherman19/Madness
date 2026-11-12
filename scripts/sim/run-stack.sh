#!/bin/zsh
# Fresh database, adapter and production Next server on 127.0.0.1. Usage: scripts/sim/run-stack.sh [latency_ms]
cd "$(dirname "$0")/../.."
source scripts/sim/env.sh
[ -n "$1" ] && export FIXTURE_DB_LATENCY_MS=$1
for f in .sim/adapter.pid .sim/next.pid; do [ -f $f ] && kill $(cat $f) 2>/dev/null; done
sleep 1
node scripts/sim/init-db.mjs sim || exit 1
rm -rf .next/cache/fetch-cache
nohup node tests/support/database.mjs > .sim/adapter.log 2>&1 & echo $! > .sim/adapter.pid
sleep 3
NODE_OPTIONS="$SIM_NODE_OPTIONS" nohup npx next start --hostname 127.0.0.1 --port $SIM_APP_PORT > .sim/next.log 2>&1 & echo $! > .sim/next.pid
for i in {1..40}; do curl -s -o /dev/null http://127.0.0.1:$SIM_APP_PORT/api/health && break; sleep 1; done
echo stack ready
