#!/usr/bin/env bash
#
# pi-gchat-bridge startup script. THIS IS THE CONTAINER ENTRYPOINT.
#
# Runs the bridge on the Pi Durable engine (dist/durable/main.js).
#
# History worth knowing: this file used to launch the SDK host (dist/index.js).
# The migration to Pi Durable is complete, so the durable engine is now the one
# on the entrypoint. The SDK host is kept runnable — via BRIDGE_ENGINE=sdk — so
# rollback is an env change and a restart rather than a git checkout. Anything
# that reverts this file to the old script will silently take the bridge back to
# the legacy engine on the next container restart.
#
# Keep the container startup path: start-bridge.sh.
# Do not "fix" the engine choice by editing what the container runs.
#
# - Runs the bridge from anywhere (resolves its own project dir).
# - Restarts the bridge automatically if it exits (crash, OOM, etc.).
# - Logs to bridge.log in the project dir (override with BRIDGE_LOG_FILE).
# - Shuts down cleanly on SIGTERM/SIGINT (Docker stop, Synology shutdown).
#
# Engine selection:
#   BRIDGE_ENGINE=durable (default)  dist/durable/main.js  — pi-durable harness
#   BRIDGE_ENGINE=sdk               dist/index.js         — legacy SDK host
#
# The durable engine reads `.env.durable` (falling back to `.env`) for its own
# subscription / database / allow-list, so it does not have to share the legacy
# settings files. The two engines must never pull the same Pub/Sub subscription:
# each message goes to whichever instance pulls it first, so sharing one looks
# like the bot ignoring people at random.
#
# Startup services: the llama.cpp router and cron are started here in both
# engine modes. They are not bridge-engine-specific, and dropping them is what
# makes local models fail with "Connection error" after a container recreate.

set -u

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

ENGINE="${BRIDGE_ENGINE:-durable}"
case "$ENGINE" in
  durable) ENTRYPOINT="dist/durable/main.js" ;;
  sdk)     ENTRYPOINT="dist/index.js" ;;
  *)
    echo "$(date '+%F %T') [start] ERROR: BRIDGE_ENGINE must be durable or sdk, got '$ENGINE'" >&2
    exit 1
    ;;
esac

# Guard against the failure that actually happened: `node` invoked with a shell
# script as its argument (`ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension
# ".sh"`), which crash-loops the container without saying why. Failing once, with
# the reason, is better than looping.
case "$ENTRYPOINT" in
  *.js) ;;
  *)
    echo "$(date '+%F %T') [start] ERROR: ENTRYPOINT is not a .js file: '$ENTRYPOINT'" >&2
    exit 1
    ;;
esac

# The durable engine logs beside its own database so the two engines' logs never
# interleave; the SDK host keeps its historical default.
if [ "$ENGINE" = "durable" ]; then
  LOG_FILE="${BRIDGE_LOG_FILE:-$PROJECT_DIR/bridge-durable.log}"
else
  LOG_FILE="${BRIDGE_LOG_FILE:-$PROJECT_DIR/bridge.log}"
fi
NODE_PID=""
TUNNEL_PID=""

log() {
  echo "$(date '+%F %T') [start] $*" >> "$LOG_FILE"
}

shutdown() {
  log "shutdown signal received, stopping bridge (pid ${NODE_PID:-none})"
  if [ -n "$NODE_PID" ]; then
    kill "$NODE_PID" 2>/dev/null
    wait "$NODE_PID" 2>/dev/null
  fi
  # The tunnel is useless without the bridge, and leaving it up would keep a
  # public hostname pointed at a dead port.
  if [ -n "$TUNNEL_PID" ]; then
    kill "$TUNNEL_PID" 2>/dev/null
    wait "$TUNNEL_PID" 2>/dev/null
  fi
  exit 0
}
trap shutdown TERM INT

# --- One supervisor per project directory ---
#
# Nothing used to stop a second copy of this script existing, and one did: pid 1
# was this script, and a second copy ran as its child, each spawning a bridge.
# The bridge's own database lock refused the duplicate, so it retried forever --
# 1,138 restart lines, one attempt every 5s at 100% CPU, burying a real model
# failure in the log. The bridge lock cannot fix this because the pointless
# process is the *supervisor*, not the bridge.
#
# This is a pid file on the script itself. A stale one (container killed) is
# taken over; a live one exits immediately.
SUPERVISOR_LOCK="$PROJECT_DIR/.start-bridge.pid"
if [ -f "$SUPERVISOR_LOCK" ]; then
  OTHER="$(cat "$SUPERVISOR_LOCK" 2>/dev/null || true)"
  if [ -n "$OTHER" ] && [ "$OTHER" != "$$" ] && kill -0 "$OTHER" 2>/dev/null; then
    echo "$(date '+%F %T') [start] another supervisor is already running (pid $OTHER) — exiting" >&2
    # Also to the log file: this line is the difference between "the container is
    # in a restart loop" and "a second supervisor is holding the lock", and the
    # container's own stdout is not where anyone looks.
    LOG_FILE="${BRIDGE_LOG_FILE:-$PROJECT_DIR/bridge-durable.log}"
    echo "$(date '+%F %T') [start] refused to start: supervisor lock held by pid $OTHER (lock: $SUPERVISOR_LOCK)" >> "$LOG_FILE"
    exit 0
  fi
fi
echo "$$" > "$SUPERVISOR_LOCK"
SUPERVISOR_CLEANUP=0
cleanup_supervisor() {
  if [ "$SUPERVISOR_CLEANUP" = "0" ]; then
    SUPERVISOR_CLEANUP=1
    if [ "$(cat "$SUPERVISOR_LOCK" 2>/dev/null)" = "$$" ]; then
      rm -f "$SUPERVISOR_LOCK"
    fi
  fi
}
trap cleanup_supervisor EXIT

# Restore pi's global config (~/.pi/agent: provider creds, extensions, skills)
# from the persistent snapshot if the container was recreated (ephemeral layer
# is wiped on recreate, only survives plain restarts).
SNAPSHOT_DIR="${PROJECT_DIR}/../pi-agent"
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
  log "WARNING: $PROJECT_DIR/../cron/start-cron.sh not found - cron not started"
fi

# --- Startup services: llama.cpp router (local models on :8090) ---
# The router is a plain nohup'd llama-server process, so a container restart
# kills it and nothing else would bring it back — pi models listed under
# llama-local would then fail every request with "Connection error".
# `ensure` is idempotent (health check first), so this is a no-op on a plain
# bridge restart and never leaves two routers running.
LFM_SERVER="$PROJECT_DIR/../cron/lfm-server.sh"
if [ -x "$LFM_SERVER" ]; then
  if "$LFM_SERVER" ensure; then
    log "llama.cpp router up on :8090"
  else
    log "WARNING: llama.cpp router failed to start (see /workspace/logs/lfm-router.log)"
  fi
else
  log "WARNING: $LFM_SERVER not found - local models unavailable"
fi

# Build once if compiled output is missing or stale.
NEEDS_BUILD=0
if [ ! -f "$ENTRYPOINT" ]; then
  NEEDS_BUILD=1
else
  # Any newer source file means stale output. Cheap, and the failure it prevents
  # is a bridge that silently runs the previous build.
  if [ -n "$(find src -name '*.ts' -newer "$ENTRYPOINT" -print -quit 2>/dev/null)" ]; then
    NEEDS_BUILD=1
  fi
fi
if [ "$NEEDS_BUILD" = "1" ]; then
  log "$ENTRYPOINT missing or stale — building..."
  npm run build >> "$LOG_FILE" 2>&1 || log "ERROR: build failed (see $LOG_FILE)"
fi

# Load the durable engine's own environment. Called at startup AND before every
# restart of the bridge.
#
# Sourcing this once, before the loop, meant an edit to `.env.durable` needed a
# *container* restart to take effect: the loop re-executes node, node inherits
# this shell's environment, and this shell had already exported the old values.
# Deploying BRIDGE_ARTIFACTS_PORT made that concrete — the file was correct,
# `.restart-bridge.sh` restarted node, and the new listener never started.
#
# Sourcing can add or change a variable but cannot remove one, so the keys the file
# defined *last* time are remembered in `.env.durable.keys` and any that are no longer
# in the file are unset before sourcing. Without that, deleting a line and restarting
# does nothing: the old value survives in this shell's environment and every child
# inherits it — which is precisely the operation a rollback needs (turn the painter
# off, delete the key, restart).
load_durable_env() {
  if [ "$ENGINE" != "durable" ]; then
    return 0
  fi
  local file="$PROJECT_DIR/.env.durable"
  if [ ! -f "$file" ]; then
    return 0
  fi
  log "loading .env.durable"
  local keys="$PROJECT_DIR/.env.durable.keys"
  if [ -f "$keys" ]; then
    while read -r key; do
      [ -n "$key" ] || continue
      grep -q "^${key}=" "$file" || unset "$key"
    done < "$keys"
  fi
  set -a
  # shellcheck disable=SC1091
  . "$file"
  set +a
  grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' "$file" | tr -d '=' > "$keys"
}

load_durable_env

# Refuse to start when the durable engine has no subscription: it would pull
# nothing and look healthy while answering no one.
if [ "$ENGINE" = "durable" ] && [ -z "${PUBSUB_SUBSCRIPTION:-}" ]; then
  log "ERROR: PUBSUB_SUBSCRIPTION is not set — the durable engine would pull nothing"
  exit 1
fi
if [ "$ENGINE" = "durable" ]; then
  # The tunnel token comes from the secret store and nowhere else:
  #
  #     /secret set CLOUDFLARE_TUNNEL_TOKEN            (value on a card)
  #     /secret set CLOUDFLARE_TUNNEL_TOKEN --file /etc/cloudflared/token
  #
  # No environment fallback on purpose. A token in `.env.durable` would be
  # exported by `load_durable_env` into the bridge and inherited by every `bash`
  # tool call the agent runs — the exact exposure the store exists to avoid. If
  # the secret is absent the tunnel simply does not start, which is a supported
  # state: the bridge is reachable other ways.
  #
  # Read through `secret-get`, which uses SecretStore, rather than re-parsing
  # secrets.json here: one format, one implementation, so migration and
  # file-backed secrets behave identically in the supervisor and the bridge.
  CLOUDFLARE_TUNNEL_TOKEN=""
  getter="$PROJECT_DIR/dist/scripts/secret-get.js"
  if [ -f "$getter" ] && command -v node >/dev/null 2>&1; then
    CLOUDFLARE_TUNNEL_TOKEN="$(BRIDGE_DB="${BRIDGE_DB:-$PROJECT_DIR/bridge.sqlite}" \
      node "$getter" CLOUDFLARE_TUNNEL_TOKEN 2>/dev/null)" || CLOUDFLARE_TUNNEL_TOKEN=""
  else
    log "cloudflared: $getter missing (run 'npm run build') — cannot read CLOUDFLARE_TUNNEL_TOKEN"
  fi
  if [ -n "$CLOUDFLARE_TUNNEL_TOKEN" ]; then
    log "cloudflared: CLOUDFLARE_TUNNEL_TOKEN found in the secret store"
  fi
  # Absence is reported by start_tunnel(), which is also what decides not to
  # start. Logging it here too made every start say it twice.
  log "engine=durable db=${BRIDGE_DB:-$PROJECT_DIR/bridge.sqlite} subscription=$PUBSUB_SUBSCRIPTION spaces=${ALLOWED_SPACES:-(all)}"
else
  log "engine=sdk subscription=${PUBSUB_SUBSCRIPTION:-(unset)}"
fi

# --- Cloudflare Tunnel (optional) ---
#
# Only for the durable engine, and only when a config and credentials exist. The
# tunnel is what makes the web UI reachable without a Tailscale client, so it is
# started here rather than by a separate unit: if the bridge dies, the public
# hostname must stop answering rather than 502.
CF_CONFIG="$PROJECT_DIR/cloudflared.yml"
CF_BIN="${CLOUDFLARED_BIN:-}"
start_tunnel() {
  if [ "$ENGINE" != "durable" ]; then return 0; fi
  if [ ! -f "$CF_CONFIG" ]; then
    log "cloudflared: no $CF_CONFIG — tunnel not started"
    return 0
  fi
  if [ -z "$CF_BIN" ]; then
    CF_BIN="$(command -v cloudflared 2>/dev/null || true)"
  fi
  if [ -z "$CF_BIN" ] || [ ! -x "$CF_BIN" ]; then
    log "cloudflared: binary not found (set CLOUDFLARED_BIN) — tunnel not started"
    return 0
  fi
  # Refuse to expose a bridge that is listening on every interface: the tunnel
  # is only a security boundary if it is the ONLY way in.
  if [ "${BRIDGE_BIND:-127.0.0.1}" != "127.0.0.1" ]; then
    log "cloudflared: WARNING BRIDGE_BIND=${BRIDGE_BIND} — the bridge is reachable WITHOUT the tunnel and its Access policy"
  fi
  # No token means no tunnel. That is a supported state, not a failure: the
  # bridge is reachable through Google Chat regardless, so a missing secret must
  # not stop the process or flood the log with respawns.
  if [ -z "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]; then
    log "cloudflared: no CLOUDFLARE_TUNNEL_TOKEN secret — tunnel not started (set it with /secret in Chat)"
    return 0
  fi

  # `--config` is passed even though the token supplies credentials: without it
  # cloudflared pulls ingress from the Cloudflare dashboard, which has no
  # `disableChunkedEncoding` — and without that the edge buffers the /web event
  # stream, so the page stays blank while the model replies.
  log "cloudflared: starting tunnel with CLOUDFLARE_TUNNEL_TOKEN + local ingress ($CF_CONFIG)"
  "$CF_BIN" tunnel --config "$CF_CONFIG" run --token "$CLOUDFLARE_TUNNEL_TOKEN" \
    >> "$PROJECT_DIR/cloudflared.log" 2>&1 &
  TUNNEL_PID=$!
}

log "pi-gchat-bridge starting (log: $LOG_FILE)"
start_tunnel

# Restart backoff for the bridge itself.
#
# A fixed 5s retry is right for a one-off restart and wrong for a crash loop: the
# bridge once restarted 1,138 times at 100% CPU, which buried the real error under
# identical log lines. The delay now doubles to a five-minute ceiling, and resets
# once a run has lasted long enough to count as healthy — so a single restart is
# still immediate.
BACKOFF_MIN=5
BACKOFF_MAX=300
HEALTHY_AFTER=60
backoff=$BACKOFF_MIN
while true; do
  # Re-read `.env.durable` every time the bridge is re-executed, so a bridge
  # restart applies an environment change without restarting the container.
  load_durable_env
  started=$(date +%s)
  node "$ENTRYPOINT" >> "$LOG_FILE" 2>&1 &
  NODE_PID=$!
  wait "$NODE_PID"
  code=$?
  ran=$(( $(date +%s) - started ))
  if [ "$ran" -ge "$HEALTHY_AFTER" ]; then
    backoff=$BACKOFF_MIN
  else
    backoff=$(( backoff * 2 ))
    [ "$backoff" -gt "$BACKOFF_MAX" ] && backoff=$BACKOFF_MAX
  fi
  # 75 = another process owns the bridge database (see src/durable/main.ts).
  # That is a refusal, not a crash: the owner is already serving Chat, so
  # retrying every 5s would bury any real error under identical log lines.
  # Wait far longer instead — long enough to notice, short enough to recover
  # on its own once the other process exits.
  if [ "$code" = "75" ]; then
    log "bridge refused to start: database owned by another process — retrying in 120s"
    sleep 120
    continue
  fi
  log "bridge exited (code $code) after ${ran}s — restarting in ${backoff}s"
  # The tunnel outlives a bridge restart on purpose (cloudflared reconnects and
  # the edge returns 502 for a few seconds, which is better than a DNS change).
  # But if cloudflared itself died, bring it back.
  if [ -n "$TUNNEL_PID" ] && ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    log "cloudflared exited — restarting"
    TUNNEL_PID=""
    start_tunnel
  fi
  sleep "$backoff"
done
