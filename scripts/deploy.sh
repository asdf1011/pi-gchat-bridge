#!/usr/bin/env bash
#
# Build, then restart when idle — the two steps a deploy actually is.
#
# Why this exists: "committed and built" and "running" are two different facts, and
# nothing checked that they agreed. Twice in one session `dist/` was rebuilt while the
# bridge kept serving the code it had loaded at startup, so a change that was committed,
# tested and compiled was silently not live. The failure is invisible from the outside —
# the process is healthy, `/healthz` says 200, the page renders — which is exactly the
# kind of gap a person only notices by asking "did we restart?".
#
# So the build and the restart are one command. A deploy cannot be half-done because
# there is no half: `npm run deploy` either leaves the running process on new code, or
# exits non-zero having said why.
#
# Usage:
#   npm run deploy                     # build, then arm the idle restart
#   npm run deploy -- --now            # build, then restart without waiting for idle
#   npm run deploy -- --check          # build, then report what a restart would do
#   npm run deploy -- --container      # reload the supervisor too (see .restart-when-idle.sh)
#   npm run deploy -- --quiet 60 --wait 1800
#
# Exit codes:
#   0  built, and the restart is armed (or done, with --now)
#   1  the build failed — nothing was restarted, and the running bridge is untouched
#   1  the restart was armed but gave up (busy past the deadline, or unhealthy after)
#
# `--now` is the escape hatch and it is a real risk: `.restart-when-idle.sh` exists because
# a restart kills every child of the bridge process, and that is where tools run. Use it when
# you know nothing is in flight.
set -u

SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
PROJECT_DIR="$(cd "$(dirname "$SELF")/.." && pwd)"
cd "$PROJECT_DIR"

RESTART="$PROJECT_DIR/.restart-when-idle.sh"
QUIET=30
MAXWAIT=900
MODE=arm
CONTAINER=()

while [ $# -gt 0 ]; do
  case "$1" in
    --now) MODE=now ;;
    --check) MODE=check ;;
    --container) CONTAINER=(--container) ;;
    --quiet)
      shift
      if ! [ "${1:-}" -ge 0 ] 2>/dev/null; then
        echo "deploy: --quiet needs a number of seconds" >&2
        exit 2
      fi
      QUIET="$1"
      ;;
    --wait)
      shift
      if ! [ "${1:-}" -ge 0 ] 2>/dev/null; then
        echo "deploy: --wait needs a number of seconds" >&2
        exit 2
      fi
      MAXWAIT="$1"
      ;;
    -h | --help)
      # The header is the help: it is the one place allowed to drift from the code,
      # because it is what a person reads before trusting it.
      sed -n '2,31p' "$SELF" | sed 's/^# \{0,1\}//' | sed '/^set -u$/d'
      exit 0
      ;;
    *)
      echo "deploy: unknown option $1" >&2
      echo "deploy: try --help" >&2
      exit 2
      ;;
  esac
  shift
done

say() { echo "deploy: $*"; }

if ! [ -f "$RESTART" ]; then
  say "$RESTART is missing — cannot restart without it" >&2
  exit 1
fi

# 1. Build first, and stop on failure. A restart that lands on a half-written `dist/` is worse
# than not restarting: the supervisor re-executes node immediately, so a broken build becomes a
# crash loop rather than a build error somebody can read.
say "building"
if ! BUILD_LOG=$(npm run build 2>&1); then
  printf '%s\n' "$BUILD_LOG" | tail -40 >&2
  say "build FAILED — nothing restarted, the running bridge is untouched" >&2
  exit 1
fi

# What was built, so the log line says something a person can compare later against
# `ps -o lstart=` when they are wondering whether a restart happened.
BUILT_AT=$(stat -c '%y' dist/durable/main.js 2>/dev/null | cut -d. -f1)
say "built (dist/durable/main.js ${BUILT_AT:-unknown})"

case "$MODE" in
  check)
    # Say what a restart would see, and change nothing. Same gate the armed path uses.
    exec bash "$RESTART" "${CONTAINER[@]}" --check
    ;;
  now)
    # `--quiet 0` is the restart script's own way of saying "do not wait": the idle gate still
    # runs (so a lock with no live owner is still noticed) but a bridge that is calm right now
    # passes on the first check rather than after a quiet period.
    say "restarting now (--now): a running turn and every child tool will be killed"
    exec bash "$RESTART" "${CONTAINER[@]}" 0 "$MAXWAIT"
    ;;
  arm)
    # Detached, because the caller is often a tool call inside a turn: if this waited, the
    # turn that asked for the deploy would keep the bridge busy and the gate would never open.
    # The restart script keeps its own log and its own permissions; appending to a second one
    # here only produced two files where one is read. Say where its log is instead.
    RESTART_LOG="${BRIDGE_DATA_DIR:-$PROJECT_DIR/data}/bridge-restart.log"
    mkdir -p "$(dirname "$RESTART_LOG")"
    setsid nohup bash "$RESTART" "${CONTAINER[@]}" "$QUIET" "$MAXWAIT" >>"$RESTART_LOG" 2>&1 &
    WATCHER=$!
    say "restart armed (watcher ${WATCHER}), quiet ${QUIET}s, giving up after ${MAXWAIT}s"
    say "it will restart as soon as the bridge is idle — follow ${RESTART_LOG}"
    exit 0
    ;;
esac
