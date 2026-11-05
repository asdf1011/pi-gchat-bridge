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

# The bridge's pid.
#
# The database lock is the authority: whichever process owns `bridge.sqlite.lock`
# is the one serving, and it is the one to restart. Matching on the command line
# alone was wrong in a way that cost three restarts: a *scratch* instance run from
# this directory (`BRIDGE_DB=/tmp/… node dist/durable/main.js`) matches the same
# pattern, so the script killed the developer's throwaway process and declared the
# real bridge healthy — healthy because it had never been touched.
bridge_pid() {
  local lock="$PROJECT/bridge.sqlite.lock"
  if [ -f "$lock" ]; then
    local owner
    owner=$(cat "$lock" 2>/dev/null || true)
    if [ -n "$owner" ] && kill -0 "$owner" 2>/dev/null; then
      echo "$owner"
      return
    fi
  fi
  # Fallback: the process whose *cwd* is this project, so a test instance started
  # elsewhere is not mistaken for the bridge.
  for p in /proc/[0-9]*; do
    c=$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null)
    case "$c" in
      "node dist/durable/main.js "*|"node dist/index.js "*)
        if [ "$(readlink "$p/cwd" 2>/dev/null)" = "$PROJECT" ]; then
          basename "$p"
          return
        fi
        ;;
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
