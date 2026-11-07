#!/bin/bash
# Restart the bridge only when it is not in the middle of anything.
#
# Why this exists: a restart kills every child of the bridge process, and that is
# where the agent's tools run. A `bash` tool mid-build, a jj walk, an npm install, a
# long download, a script the owner started — they all die with it. `.restart-bridge.sh`
# waits a fixed number of seconds, which is right for flushing a reply and wrong for a
# five-minute build, so a deploy could take a running turn's work with it (and has:
# two tool calls were interrupted that way).
#
# This waits for an *idle* bridge instead, which is two questions and needs both:
#
#   - no turn running — asked of the bridge itself (`GET /idle`). Process silence is
#     not the same thing: an agent thinking between tool calls is silent for a minute
#     at a time, and a gate built on silence alone fired mid-turn the first time it
#     was used;
#   - no child process other than the long-lived adapters — which is what catches a
#     build, a download, or a script the owner started.
#
# Sustained for a quiet period. If it never gets quiet it does **not** restart — a
# deployment that silently kills a twenty-minute build is the failure this is here to
# prevent, so it logs and gives up instead.
#
# Usage:
#   setsid nohup ./.restart-when-idle.sh [quietSeconds] [maxWaitSeconds] &
#   ./.restart-when-idle.sh --check     # say what it sees, change nothing
#
# Notes / why hand-rolled: this image has no pkill/pgrep, so everything here reads
# /proc. `start-bridge.sh` is PID 1 in a `while true` loop, so killing the node
# process is enough for the wrapper to start it again — but every child it had is
# gone, which is the whole point.
set -u

PROJECT=/workspace/pi-gchat-bridge
LOG="$PROJECT/bridge-restart.log"
QUIET="${1:-60}"
MAXWAIT="${2:-1800}"
CHECK=0
[ "${1:-}" = "--check" ] && { CHECK=1; QUIET=0; MAXWAIT=0; }

log() { echo "$(date -u '+%F %T') $*" >> "$LOG"; }
say() { [ "$CHECK" = 1 ] && echo "$*"; log "$*"; }

IDLE_URL="${BRIDGE_IDLE_URL:-http://127.0.0.1:8081/idle}"

# Is a turn running? Asks the bridge, because it is the only thing that knows. A
# failure to answer counts as busy: cannot tell is not idle.
turn_running() {
  if curl -sf --max-time 5 "$IDLE_URL" >/dev/null 2>&1; then
    return 1   # healthy answer = idle
  fi
  return 0
}

# The bridge's pid. The database lock is the authority: whichever process owns
# `bridge.sqlite.lock` is the one serving — matching on a command line instead picks
# up scratch instances and tool subprocesses (see .restart-bridge.sh for that scar).
bridge_pid() {
  local lock="$PROJECT/bridge.sqlite.lock" owner
  if [ -f "$lock" ]; then
    owner=$(cat "$lock" 2>/dev/null || true)
    if [ -n "$owner" ] && kill -0 "$owner" 2>/dev/null; then
      echo "$owner"
      return
    fi
  fi
}

# Every descendant of $1, printed one per line. Walked breadth-first through
# /proc/<pid>/status, because the image has no procps.
descendants_of() {
  local root="$1" pid ppid p d
  local frontier="$root" next found=""
  while [ -n "$frontier" ]; do
    next=""
    for p in $frontier; do
      for d in /proc/[0-9]*; do
        pid="${d#/proc/}"
        ppid=$(awk '/^PPid:/{print $2; exit}' "$d/status" 2>/dev/null)
        [ "$ppid" = "$p" ] && next="$next $pid"
      done
    done
    found="$found$next"
    frontier="$next"
  done
  printf '%s\n' $found
}

# Pids that are this script's own doing: itself, whatever launched it (a shell tool
# runs *inside* the bridge's process tree, so an honest idle check has to ignore its
# own call chain or it would never see an idle bridge), and the helpers it spawns.
self_pids() {
  local pid="$$" ppid
  while [ -n "$pid" ] && [ "$pid" != 0 ] && [ "$pid" != 1 ]; do
    echo "$pid"
    ppid=$(awk '/^PPid:/{print $2; exit}' "/proc/$pid/status" 2>/dev/null)
    [ "$ppid" = "$pid" ] && break
    pid="$ppid"
  done
  descendants_of "$$"
}

# Children worth waiting for: not the adapters (they are replaced *by* the restart),
# and not this script's own call chain.
busy_children() {
  local bridge="$1" pid cmd self
  self=" $(self_pids | tr '\n' ' ') "
  for pid in $(descendants_of "$bridge"); do
    case "$self" in *" $pid "*) continue ;; esac
    # The process can vanish between listing and reading: a transitory tool finishing
    # is exactly the case this waits for, so a missing cmdline is not an error.
    cmd=$( { tr '\0' ' ' < "/proc/$pid/cmdline"; } 2>/dev/null )
    [ -z "$cmd" ] && continue
    case "$cmd" in
      *dist/web-host.js*) continue ;;             # long-lived web adapter
    esac
    echo "$pid $cmd"
  done
}

BRIDGE=$(bridge_pid)
if [ -z "$BRIDGE" ]; then
  say "no bridge process owns the database lock — nothing to restart"
  exit 0
fi

if [ "$CHECK" = 1 ]; then
  echo "bridge pid: $BRIDGE"
  if turn_running; then
    echo "turn running: yes (GET $IDLE_URL did not report idle)"
  else
    echo "turn running: no"
  fi
  # Printed with the command line, not just the pid: a misclassification here is the
  # one mistake that would let a restart land on somebody's running build, so it has
  # to be visible in the check's own output. (The grep pattern cannot match its own
  # argv, or the grep would list itself as an adapter.)
  self=" $(self_pids | tr '\n' ' ') "
  echo "long-lived children ignored:"
  for p in $(descendants_of "$BRIDGE"); do
    case "$self" in *" $p "*) continue ;; esac
    cmd=$( { tr '\0' ' ' < "/proc/$p/cmdline"; } 2>/dev/null )
    case "$cmd" in
      *dist/web-host[.]js*) echo "  $p ${cmd:0:60}" ;;
    esac
  done
  echo "work in flight:"
  busy_children "$BRIDGE" | sed 's/^/  /' || true
  busy_children "$BRIDGE" | grep -q . || echo "  (none — the bridge is idle)"
  exit 0
fi

say "waiting for an idle bridge (pid $BRIDGE) before restarting: quiet ${QUIET}s, giving up after ${MAXWAIT}s"
waited=0
while [ "$waited" -lt "$MAXWAIT" ]; do
  sleep 5
  waited=$((waited + 5))
  work=$(busy_children "$BRIDGE")
  if [ -n "$work" ] || turn_running; then
    quiet_for=0
    continue
  fi
  quiet_for=$(( ${quiet_for:-0} + 5 ))
  if [ "$quiet_for" -ge "$QUIET" ]; then
    # Re-read the owner *now*: a daemon armed earlier may be holding a pid that has since
    # been replaced by another restart, and killing a dead pid logs a restart that never
    # happened (observed: two armed daemons, the second one logged "restarting pid 14849"
    # forty seconds after 14849 was gone).
    current=$(bridge_pid)
    if [ -z "$current" ] || ! kill -0 "$current" 2>/dev/null; then
      log "no live bridge owns the database lock now — nothing to restart"
      exit 0
    fi
    if [ "$current" != "$BRIDGE" ]; then
      log "bridge pid changed while waiting ($BRIDGE → $current) — restarting the current one"
    fi
    log "idle for ${QUIET}s — restarting bridge pid $current"
    kill "$current" 2>/dev/null
    exit 0
  fi
done

# Loud on purpose: a skipped deploy is a decision somebody has to make, whereas a
# restart that killed a running build is a loss nobody asked for.
log "gave up after ${MAXWAIT}s: still busy ($${turn_running:+turn running}${:+-}$(busy_children "$BRIDGE" | head -1)…) — NOT restarting; arm again when it is calm"
exit 1
