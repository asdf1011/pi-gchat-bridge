#!/usr/bin/env bash
#
# pi-gchat-bridge on the Pi Durable engine.
#
# A sibling of start-bridge.sh, not a replacement:
#
#   start-bridge.sh           SDK host  (dist/index.js)      <-- currently running
#   start-bridge-durable.sh   durable   (dist/durable/main.js)
#
# Run ONE of them. Two bridges on the same Pub/Sub subscription do not duplicate
# work — each message is delivered to whichever instance pulls it first — so the
# durable bridge needs its own subscription on the same topic (see
# docs/migration-to-durable.md, "Cutover").
#
# This script deliberately does NOT start llama.cpp or cron:
#   - the llama router is a single-slot server that start-bridge.sh already
#     keeps up, and a second one would contend for the same port;
#   - cron is a daemon with its own crontab, and starting it twice would run
#     every scheduled job twice.
#
# Configuration: `.env.durable` in this directory (falling back to `.env`), so the
# durable bridge can point at its own subscription, database and allowed spaces
# without editing the live configuration.

set -u

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

LOG_FILE="${BRIDGE_LOG_FILE:-$PROJECT_DIR/bridge-durable.log}"
NODE_PID=""

log() {
  echo "$(date '+%F %T') [start-durable] $*" >> "$LOG_FILE"
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

# Engine-specific configuration wins over the shared one.
if [ -f "$PROJECT_DIR/.env.durable" ]; then
  log "loading .env.durable"
  set -a
  # shellcheck disable=SC1091
  . "$PROJECT_DIR/.env.durable"
  set +a
fi

# Refuse to start on the same subscription as a running SDK-host bridge: that
# steals messages from it rather than sharing them, which looks like the bot
# ignoring people at random.
if [ -z "${PUBSUB_SUBSCRIPTION:-}" ]; then
  log "ERROR: PUBSUB_SUBSCRIPTION is not set"
  exit 1
fi

# One process owns the durable store: pi-durable has no cross-process locking,
# so a second instance would corrupt it rather than share it.
DB="${BRIDGE_DB:-$PROJECT_DIR/bridge.sqlite}"
log "engine=durable db=$DB subscription=$PUBSUB_SUBSCRIPTION spaces=${ALLOWED_SPACES:-(all)}"

# Build if the durable entrypoint is missing (tsc compiles src -> dist).
if [ ! -f dist/durable/main.js ] || [ dist/durable/main.js -ot src/durable/main.ts ]; then
  log "building dist/durable/main.js..."
  npm run build >> "$LOG_FILE" 2>&1 || {
    log "ERROR: build failed — see $LOG_FILE"
    exit 1
  }
fi

log "starting (log: $LOG_FILE)"
while true; do
  node dist/durable/main.js >> "$LOG_FILE" 2>&1 &
  NODE_PID=$!
  wait "$NODE_PID"
  code=$?
  NODE_PID=""
  log "bridge exited (code $code) — restarting in 5s"
  sleep 5
done
