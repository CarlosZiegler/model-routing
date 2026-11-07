#!/usr/bin/env bash
# watchdog-integration.sh [<repo>] — hand dispatch runs to the project's watchdog, if it has one.
#
# Contract (assumed, nothing implements it yet): if <repo>/.coord/watchdog.sh is executable it is
# exec'd with the runs dir (<repo>/.coord/model-routing/runs) as its only argument.
# No project checked on 2026-11-07 had .coord/watchdog.sh, so the fallback below
# only lists each run's state from the files dispatch.sh writes. It never kills anything.
set -euo pipefail

REPO=$(cd "${1:-$PWD}" && pwd)
RUNS="$REPO/.coord/model-routing/runs"

if [ -x "$REPO/.coord/watchdog.sh" ]; then
  exec "$REPO/.coord/watchdog.sh" "$RUNS"
fi

echo "no executable $REPO/.coord/watchdog.sh; listing dispatch runs (read-only)"
[ -d "$RUNS" ] || { echo "no runs dir: $RUNS"; exit 0; }

for d in "$RUNS"/*/; do
  [ -d "$d" ] || continue
  id=$(basename "$d")
  pid=$(cat "$d/pid" 2>/dev/null || echo "")
  if [ -f "$d/exit" ]; then
    echo "$id exited rc=$(cat "$d/exit")"
  elif [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    echo "$id running pid=$pid"
  else
    echo "$id DIED without an exit file (pid=${pid:-?}); the ledger has no done row — append one with pool-ledger.ts done"
  fi
done
