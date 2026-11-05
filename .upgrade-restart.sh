#!/bin/bash
# Delayed restart of pi-gchat-bridge after the pi 0.99.2 upgrade, with a
# rollback watchdog.
#
# Notes / why this is hand-rolled:
#  - There is NO pkill/pgrep in this image, so the bridge process is found via
#    /proc. (The notifier's documented `pkill -f "node dist/index.js"` restart
#    would silently do nothing here.)
#  - start-bridge.sh runs as PID 1 in a `while true` loop, so killing
#    `node dist/index.js` is enough: it restarts and picks up node_modules.
#  - Run under setsid so this watchdog survives the bridge's own shutdown
#    (the bridge TERMs its child processes, including the pi session that
#    spawned this script).
#
# Usage: ./.upgrade-restart.sh [delaySeconds]
set -u

PROJECT=/workspace/pi-gchat-bridge
LOG="$PROJECT/upgrade-0.99.2.log"
SPACE="spaces/sPA7FKAAAAE"
DELAY="${1:-120}"

log() { echo "$(date -u '+%F %T') $*" >> "$LOG"; }

bridge_pid() {
  for p in /proc/[0-9]*; do
    c=$(cat "$p/cmdline" 2>/dev/null | tr '\0' ' ')
    case "$c" in "node dist/index.js "*) basename "$p"; return;; esac
  done
}

healthy() { curl -sf --max-time 5 http://127.0.0.1:8080/healthz >/dev/null 2>&1; }

wait_healthy() { # $1 = number of 10s attempts
  i=0
  while [ "$i" -lt "$1" ]; do
    sleep 10; i=$((i + 1))
    healthy && return 0
  done
  return 1
}

log "armed: restarting in ${DELAY}s (rollback target $(cd "$PROJECT" && git rev-parse --short HEAD))"
sleep "$DELAY"

pid=$(bridge_pid)
if [ -n "$pid" ]; then
  log "killing bridge pid $pid"
  kill "$pid" 2>/dev/null
else
  log "WARNING: no bridge pid found to kill"
fi

if wait_healthy 18; then
  log "HEALTHY — pi 0.99.2 upgrade is live"
  exit 0
fi

log "UNHEALTHY after ~180s — ROLLING BACK to committed deps (0.84.2)"
cd "$PROJECT" || exit 1
git checkout -- package.json package-lock.json >>"$LOG" 2>&1
log "git checkout exit=$?"
npm install --min-release-age=0 >>"$LOG" 2>&1
log "rollback npm install exit=$?"

if wait_healthy 18; then
  log "RECOVERED on rolled-back deps (0.84.2)"
  curl -s -X POST http://127.0.0.1:8080/notify \
    -H 'Content-Type: application/json' \
    -d "{\"space\":\"$SPACE\",\"threadKey\":\"pi-upgrade-rollback-2026-10-01\",\"text\":\"⚠️ The pi 0.99.2 upgrade did not come up healthy, so I rolled the bridge back to 0.84.2 and it is running again. Log: $LOG\"}" \
    >>"$LOG" 2>&1
  log "rollback alert posted"
  exit 0
fi

log "STILL DOWN after rollback — manual intervention needed"
exit 1
