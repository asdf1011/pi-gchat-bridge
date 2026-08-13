#!/usr/bin/env bash
#
# pi-gchat-bridge startup script.
#
# - Runs the bridge from anywhere (resolves its own project dir).
# - Restarts the bridge automatically if it exits (crash, OOM, etc.).
# - Logs to bridge.log in the project dir (override with BRIDGE_LOG_FILE).
# - Shuts down cleanly on SIGTERM/SIGINT (Docker stop, Synology shutdown).
#
# Point your container/startup task at this script's absolute path.

set -u

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

LOG_FILE="${BRIDGE_LOG_FILE:-$PROJECT_DIR/bridge.log}"
NODE_PID=""

log() {
  echo "$(date '+%F %T') [start] $*" >> "$LOG_FILE"
}

shutdown() {
  log "shutdown signal received, stopping bridge (pid ${NODE_PID:-none})"
  if [ -n "$NODE_PID" ]; then
    kill "$NODE_PID" 2>/dev/null
    wait "$NODE_PID" 2>/dev/null
  fi
  exit 0
}
trap shutdown TERM INT

# Build once if compiled output is missing.
if [ ! -f dist/index.js ]; then
  log "dist/index.js missing — building..."
  npm run build >> "$LOG_FILE" 2>&1
fi

# Restore pi's global config (~/.pi/agent: provider creds, extensions, skills)
# from the persistent snapshot if the container was recreated (ephemeral layer
# is wiped on recreate, only survives plain restarts).
SNAPSHOT_DIR="$PROJECT_DIR/pi-agent"
if [ -d "$SNAPSHOT_DIR" ] && [ ! -f "$HOME/.pi/agent/models.json" ]; then
  log "restoring pi config from $SNAPSHOT_DIR"
  mkdir -p "$HOME/.pi/agent"
  cp -rn "$SNAPSHOT_DIR/." "$HOME/.pi/agent/"
fi

# --- Startup services: cron (daily scheduled checks) ---
# Delegate to the self-contained cron service (installs cron, restores gmcli
# credentials + crontab from its persistent snapshots, starts the daemon).
if [ -x "$PROJECT_DIR/../cron/start-cron.sh" ]; then
  "$PROJECT_DIR/../cron/start-cron.sh"
else
  log "WARNING: /workspace/cron/start-cron.sh not found - cron not started"
fi

log "pi-gchat-bridge starting (log: $LOG_FILE)"
while true; do
  node dist/index.js >> "$LOG_FILE" 2>&1 &
  NODE_PID=$!
  wait "$NODE_PID"
  code=$?
  NODE_PID=""
  log "bridge exited (code $code) — restarting in 5s"
  sleep 5
done
