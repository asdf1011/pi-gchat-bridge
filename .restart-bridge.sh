#!/bin/bash
# Delayed, detached restart of pi-gchat-bridge.
#
# Why hand-rolled: the bridge's pi sessions run IN the bridge node process, so a
# restart triggered by the agent must not run as its child (the bridge TERMs its
# children on shutdown) and must not be immediate (the reply has to flush first).
# Run under setsid, sleep, then kill the bridge: PID 1 (start-bridge.sh) is a
# `while true` loop, so it restarts node and picks up the rebuilt dist/.
#
# Usage: setsid nohup ./.restart-bridge.sh [delaySeconds] &
#
# It tracks BOTH entrypoints (`dist/durable/main.js` on the durable engine,
# `dist/index.js` on the SDK host) and reads the health port from the env the
# supervisor uses, because a restart script that looks for the wrong process
# silently reports success and changes nothing.
set -u

PROJECT=/workspace/pi-gchat-bridge
LOG="$PROJECT/bridge-restart.log"
DELAY="${1:-30}"

log() { echo "$(date -u '+%F %T') $*" >> "$LOG"; }

# The engine the supervisor will start, and the port it will listen on. Both come
# from the same files start-bridge.sh reads, so a restart cannot check a port the
# new process will not bind.
engine_port() {
  local port
  port=$(grep -h '^PORT=' "$PROJECT/.env" "$PROJECT/.env.durable" 2>/dev/null | tail -1 | cut -d= -f2)
  echo "${port:-8081}"
}

bridge_pid() {
  for p in /proc/[0-9]*; do
    c=$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null)
    case "$c" in
      "node dist/durable/main.js "*|"node dist/index.js "*) basename "$p"; return ;;
    esac
  done
}

PORT=$(engine_port)
healthy() { curl -sf --max-time 5 "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; }

log "armed: restarting in ${DELAY}s (bridge pid $(bridge_pid))"
sleep "$DELAY"

pid=$(bridge_pid)
if [ -n "$pid" ]; then
  log "killing bridge pid $pid"
  kill "$pid" 2>/dev/null
else
  log "WARNING: no bridge pid found to kill"
fi

i=0
while [ "$i" -lt 18 ]; do
  sleep 5
  i=$((i + 1))
  if healthy; then
    log "HEALTHY after restart (port $PORT, pid $(bridge_pid))"
    exit 0
  fi
done

log "UNHEALTHY after ~90s on port $PORT — check $PROJECT/bridge-durable.log"
exit 1
