#!/bin/bash
# One-shot: move the bridge's store into data/, and switch the deployment to it.
#
# Why a script rather than a sequence of commands: the bridge is busy whenever a turn
# is running (which is whenever an agent is typing), and stopping it is not a state
# anyone can hold — the supervisor restarts it, and the container may be recreated.
# So the work has to happen at an *idle* moment, unattended, and it has to be safe
# whichever way the process comes back:
#
#   1. copy first, originals untouched — a restart during this phase uses the old path
#      and the old file, which is still there;
#   2. then switch `.env.durable` atomically — from here a restart uses the copy, which
#      is complete;
#   3. then restart, and only *report*. The originals stay until someone has looked at
#      the log and confirmed the conversations are all there.
#
# There is deliberately no instant where the configured path does not exist: that is
# the failure this ordering exists to prevent, and it is the one that would look like
# "every conversation is gone".
set -u

PROJECT="/workspace/pi-gchat-bridge"
DATA="$PROJECT/data"
ENV_FILE="$PROJECT/.env.durable"
LOG="$DATA/move.log"
IDLE_URL="http://127.0.0.1:8081/idle"
QUIET=45
WAIT_MAX=1800

mkdir -p "$DATA"
log() { echo "$(date -u '+%F %T') $*" >> "$LOG"; }

db_path() {
  local configured=""
  if [ -f "$ENV_FILE" ]; then
    configured=$(sed -n 's/^BRIDGE_DB=//p' "$ENV_FILE" | tail -1)
  fi
  [ -n "$configured" ] && echo "$configured" || echo "$PROJECT/bridge.sqlite"
}

lock_path() { echo "$(db_path).lock"; }

# The pid serving *this* store. Takes the path, because it is asked twice: once for the
# store being moved away from, once (defensively) for the one being moved to. Asking the
# environment instead is the bug the first run had — after the switch, `.env.durable`
# names the new path, whose lock does not exist yet, so the script concluded no bridge
# was running and left the copy stale while the live store kept growing.
bridge_pid_on() {
  local lock="$1.lock" owner
  if [ -f "$lock" ]; then
    owner=$(cat "$lock" 2>/dev/null || true)
    if [ -n "$owner" ] && kill -0 "$owner" 2>/dev/null; then
      echo "$owner"
      return
    fi
  fi
}

turn_running() {
  curl -sf --max-time 5 "$IDLE_URL" >/dev/null 2>&1 && return 1
  return 0
}

log "waiting for an idle bridge (quiet ${QUIET}s, giving up after ${WAIT_MAX}s)"
quiet=0
waited=0
while [ "$waited" -lt "$WAIT_MAX" ]; do
  if ! turn_running; then
    quiet=$((quiet + 5))
    if [ "$quiet" -ge "$QUIET" ]; then break; fi
  else
    quiet=0
  fi
  sleep 5
  waited=$((waited + 5))
done
if [ "$quiet" -lt "$QUIET" ]; then
  log "never went quiet; NOT moving anything"
  exit 0
fi

SOURCE=$(db_path)
# Captured before the copy: this is the store that is live right now, and the pid that
# holds it is the one to restart. Both become unknowable once `.env.durable` changes.
LIVE_PID=$(bridge_pid_on "$SOURCE")
if [ "$SOURCE" = "$DATA/bridge.sqlite" ]; then
  log "already on $SOURCE; nothing to do"
  exit 0
fi
if [ ! -f "$SOURCE" ]; then
  log "source $SOURCE does not exist; refusing to invent a store"
  exit 1
fi

# 1. Copy. The WAL is copied too: at idle the writer has finished, but SQLite may not
# have checkpointed, and a store copied without its WAL is a store missing recent
# commits.
log "copying $SOURCE -> $DATA/bridge.sqlite"
cp -p "$SOURCE" "$DATA/bridge.sqlite" || { log "copy failed"; exit 1; }
for suffix in -wal -shm; do
  [ -f "$SOURCE$suffix" ] && cp -p "$SOURCE$suffix" "$DATA/bridge.sqlite$suffix"
done
for side in bridge-ledger.json state.json; do
  [ -f "$PROJECT/$side" ] && cp -p "$PROJECT/$side" "$DATA/$side"
done

# A copy that is not the same size is a copy not worth switching to.
src_size=$(stat -c %s "$SOURCE")
dst_size=$(stat -c %s "$DATA/bridge.sqlite")
if [ "$src_size" != "$dst_size" ]; then
  log "size mismatch ($src_size vs $dst_size); NOT switching"
  exit 1
fi
log "copied $dst_size bytes"

# 2. Switch, atomically, and keep a backup of the env file next to it.
log "switching BRIDGE_DB in $ENV_FILE"
cp -p "$ENV_FILE" "$DATA/env.durable.before-move"
TEMP="$ENV_FILE.tmp.$$"
awk -v db="$DATA/bridge.sqlite" '
  BEGIN { done = 0 }
  /^BRIDGE_DB=/ { print "BRIDGE_DB=" db; done = 1; next }
  { print }
  END { if (!done) print "BRIDGE_DB=" db }
' "$ENV_FILE" > "$TEMP" || { log "rewrite failed"; rm -f "$TEMP"; exit 1; }
grep -q '^BRIDGE_STATE_FILE=' "$TEMP" || echo "BRIDGE_STATE_FILE=$DATA/state.json" >> "$TEMP"
mv "$TEMP" "$ENV_FILE"
grep -E '^BRIDGE_(DB|STATE_FILE)=' "$ENV_FILE" | sed 's/^/  /' >> "$LOG"

# 3. Restart and report. The supervisor re-reads .env.durable on each loop iteration, so
# killing the node process is enough; a container restart would work too.
if [ -z "$LIVE_PID" ]; then
  log "no bridge owned $SOURCE; the next start will use $DATA/bridge.sqlite"
  exit 0
fi
log "restarting bridge pid $LIVE_PID (was serving $SOURCE)"
kill "$LIVE_PID"

for i in $(seq 1 45); do
  sleep 2
  if curl -sf --max-time 5 "$IDLE_URL" >/dev/null 2>&1; then
    log "HEALTHY after restart; store is now $DATA/bridge.sqlite"
    log "originals left at $PROJECT for comparison — delete them once the conversations look right"
    exit 0
  fi
done
log "UNHEALTHY after 90s — check bridge-durable.log; the originals are untouched and $DATA/env.durable.before-move restores the old path"
