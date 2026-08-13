# pi-chat-bridge

Bridge between **Google Chat** and the **pi coding agent**. Message a Google Chat
bot and it runs pi — with tools, skills, and per-space conversation history.

```
Google Chat (you)
    │  message
    ▼
Chat app (bot) ──event──▶  Pub/Sub topic ──▶  pull subscription
                                              │
                                              ▼
                              bridge ──▶  pi AgentSession (SDK, in-process)
                                              │  streamed reply
                                              └──▶  Chat API: live message patch
```

## How messages arrive

Chat events are delivered via a **Cloud Pub/Sub pull subscription** — no public
endpoint, no tunnel, works for DMs *and* spaces. The bridge pulls events,
hands them to pi, and replies by posting a placeholder message that is **edited
in place** as pi streams, so you watch the answer appear live.

(Architecture note: bots can't list messages via the Chat API without
admin-approved restricted scopes, and DMs are unsupported there entirely —
events via Pub/Sub are the supported path.)

## One-time setup (Google Cloud Console)

1. **Create a project** at <https://console.cloud.google.com/projectcreate> (or reuse one).
2. **Enable the Google Chat API** (<https://console.cloud.google.com/apis/api/chat.googleapis.com>).
3. **Configure the Chat app** (<https://console.cloud.google.com/apis/api/chat.googleapis.com> → *Configuration*):
   - App name, avatar, description (e.g. "pi bridge")
   - **Do NOT** check "Build this Chat app as a Workspace add-on" (irreversible)
   - Connection settings → **Cloud Pub/Sub** → topic `projects/<project>/topics/chat-events`
   - Authentication Audience → **Project number**
   - Publishing: **"Specific people or group"** (add `your-email@example.com`) or *"Everyone in your organization"* — internal, no Google review
   - **Service account**: select the one created in step 4
4. **Create a service account** (IAM & Admin → Service Accounts → *Create service account*) and **download its JSON key** (Keys → Add key → JSON).
5. **Create the Pub/Sub topic + pull subscription** (Pub/Sub → Topics → *Create topic*):
   - Topic `chat-events`, subscription `chat-events-sub` (delivery type **Pull**)
   - Topic IAM: `chat-api-push@system.gserviceaccount.com` → **Pub/Sub Publisher** (required!)
   - Subscription IAM: `chat-bot@<project>.iam.gserviceaccount.com` → **Pub/Sub Subscriber**
6. In **Google Chat**, add the app to a space (or DM it) to install it.

## Local setup

```bash
cd pi-chat-bridge
npm install
cp .env.example .env
# edit .env: point GOOGLE_SERVICE_ACCOUNT_JSON at your key file
npm start
```

That's it — the bot now answers messages in any space it's installed in.

## How it behaves

- **Live streaming replies** — a "Thinking…" placeholder is posted, then
  **edited in place** as pi generates the answer (debounced patches; > 4000-char
  replies spill into follow-up messages).
- **One pi session per thread** — conversations persist across bridge
  restarts (JSONL files under `sessions/`, keyed by thread; non-threaded DMs
  key by space). Threads are fully independent conversations. See
  [Session model & persistence](#session-model--persistence) for how sessions
  are named, adopted, and kept across restarts.
- **Parallel across threads, independent conversations** — each
  conversation is handled independently and concurrently (event-driven async,
  no threads needed); a long reply in one thread never blocks another.
- **Interleaved messages (steer)** — sending a message while pi is working
  queues it into the *running* turn: it's delivered after the current tool
  call finishes (tool results land first) and before the next LLM call, so
  pi keeps its tool loop active and addresses your new message alongside the
  original work — "tool call start, message, tool call response". Commands
  (`/help`, `/model`, `/resume`) instead interrupt the running reply.
- **Thread-aware replies** — replies go back into the thread you messaged in.
- **pi extensions & skills work** — the session loads your `~/.pi/agent`
  extensions, so `/commands` and skills behave like in the TUI.
- **Bot messages are ignored** — no echo loops.

## Session model & persistence

- **Deterministic mapping, no registry.** Each Chat thread maps to one pi
  session file by a pure naming rule: `spaces/<space>/threads/<thread>` →
  `sessions/spaces_<space>_threads_<thread>.jsonl` (non-alphanumerics become
  `_`); non-threaded DMs key by space instead. No mapping state is kept — the
  filename *is* the state, re-derivable from the thread name in every event.
- **Lazy open & adoption.** Sessions are opened lazily on first message in a
  thread (nothing loads at startup). If the derived file exists, the bridge
  adopts its history; if not, it creates a fresh one. The in-memory session
  cache is disposable — losing it only costs a re-open of the same file.
- **Survives restarts by filename.** A conversation persists across bridge
  restarts iff its history sits at the derived path. External tooling can hand
  a conversation to the bridge by writing that file itself — e.g. a cron job
  that runs a pi session to do work (analysis, summaries), then lets replies
  in the thread continue that session with full context. For app-created
  threads, the app can choose a `threadKey` (stored by Google on the thread,
  echoed back in events) and the session keys by `space/threadKey` — so the
  session file path is known **before** the thread exists and the analysis can
  run first, with the finished result posted into a fully prefilled
  conversation. For threads the app didn't create (no `threadKey`), the key
  falls back to the server-generated thread name, then the space.
- **Single-consumer discipline.** The bridge is event-driven: only Chat
  messages trigger posts, and only the bridge (or the cron pattern above)
  writes thread session files. If another process also writes a session file
  the bridge has open, its new messages will **not** appear in Google Chat,
  and full-file rewrites (compaction / migration) truncate from the writer's
  in-memory state — silently dropping the other writer's messages. Keep one
  live writer per session file at a time.
- **`/resume`, `/sessions`, `/list`** — manually adopt *any* session file
  (bridge store or pi's global store) into the current thread. This is an
  **import, not a live link**: the binding is in-memory only and is lost on
  bridge restart (the thread reverts to its derived-path file). After
  resuming, continuing the source session elsewhere (e.g. in the TUI) forks
  the conversation — those messages never appear in Chat. To make an adopted
  session restart-proof, copy it onto the thread's derived path instead of
  sharing or symlinking it (shared files reintroduce the multi-writer hazards
  above).

## Run with Docker (Synology / any Docker host)

The bridge ships with a `Dockerfile` and `docker-compose.yml`. The container
runs `node dist/index.js` with a **healthcheck** on `:8080/healthz` and
`restart: unless-stopped`, so it comes back automatically after reboots or
container restarts.

### One-time setup (in the project dir)

```bash
# 1. Copy pi's global config into the container mount (credentials, extensions,
#    skills). This includes auth.json with your provider API keys:
cp -r ~/.pi/agent ./pi-agent

# 2. Create the workspace dir pi's tools will operate on:
mkdir -p workspace

# 3. Migrate existing sessions/state into the persistent data dir:
mkdir -p data
mv sessions data/ 2>/dev/null || true
mv state.json data/ 2>/dev/null || true

# 4. Build and start:
docker compose up -d --build

# 5. Watch logs:
docker compose logs -f
```

> Only ONE bridge may run at a time — stop any non-Docker instance before
> starting the container, or both will pull the same Pub/Sub subscription and
> race (duplicate replies).

### Layout inside the container

| Host path (project dir) | Container path | Purpose |
|---|---|---|
| `./data` | `/app/data` | pi sessions + dedupe state (persisted) |
| `./chat-bot-key.json` | `/workspace/pi-chat-bridge/chat-bot-key.json` | bot key (matches `.env`) |
| `./pi-agent` | `/root/.pi/agent` | pi provider creds + extensions + skills |
| `./workspace` | `/workspace` | where pi's tools (`PI_CWD`) operate |

`restart: unless-stopped` + the healthcheck mean Container Manager will restart
the bridge automatically if it crashes or the host reboots.

**Note for ARM Synology models:** the pi SDK bundles native image tooling
(`photon-node`). If the image fails to build/start on ARM, let us know — there
may be a platform fallback needed.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | — (required) | Path to service account key |
| `PUBSUB_SUBSCRIPTION` | — (required) | `projects/.../subscriptions/...` |
| `PULL_INTERVAL_MS` | `1000` | Pub/Sub pull cadence |
| `PI_CWD` | bridge dir | Working dir for pi tools |
| `BRIDGE_SESSIONS_DIR` | `./sessions` | Per-space pi session files |
| `BRIDGE_STATE_FILE` | `./state.json` | Message dedupe state |
| `PORT` | `8080` | Health endpoint (0 disables) |
| `BRIDGE_STALL_TIMEOUT_MS` | `1200000` (20 min) | Watchdog: force-reset a session streaming with no agent activity for this long (0 disables) |
| `BRIDGE_WATCHDOG_INTERVAL_MS` | `30000` | Watchdog scan interval |

### Stuck-session watchdog

If a session's tool call hangs (e.g. the agent runs a network fetch without a
timeout), the session streams forever and every message in that conversation is
deferred as "busy" — exactly what happened with the 22:43 `PY3n26MpvnI` hang.
The watchdog checks each streaming session for agent activity (any emitted
event) and, after `BRIDGE_STALL_TIMEOUT_MS` of silence, aborts the stuck run,
drops the incomplete trailing turn from the session file (so the hung tool call
is never re-run), and reopens the session. Deferred "busy" messages are then
redelivered by Pub/Sub to the fresh session.

## Roadmap

- [x] Pub/Sub receiver (DMs + spaces, no public endpoint)
- [x] Docker deployment with restart policy + healthcheck
- [x] Streaming replies (live in-place editing)
- [ ] Allowed-users filter (whitelist who can message the bot)
- [x] Parallel processing: per-thread sessions + concurrent dispatch (threads are independent; serial within a thread)

## Security notes

- The service account has **`chat.bot` scope only** — it can read messages in
  spaces it's in and post as the bot. It cannot touch your Drive/Mail/Calendar.
- pi sessions in the bridge get the **full default toolset** (`read`, `bash`,
  `edit`, `write`) against `PI_CWD`. Anyone who can message the bot can run
  commands — keep the app limited to your org / specific people.
