# pi-gchat-bridge

Bridge between **Google Chat** and the **pi coding agent**. Message a Google Chat
bot and it runs pi — with tools, skills, and per-space conversation history.

![The bridge answering a pasted image in Google Chat](docs/files/screenshot.png)

*pi* is a coding agent that runs on your machine with a session model, tools
and skills — see [pi.dev](https://pi.dev).

**Requires a Google Workspace account.** Custom Chat apps (bots) are only
available to Workspace organizations — personal Gmail accounts can use Chat
itself but can't install third-party Chat apps like this bridge.

## How messages arrive

Chat events are delivered via a **Cloud Pub/Sub pull subscription** — no public
endpoint, no tunnel, works for DMs *and* spaces. The bridge pulls events,
hands them to pi, and replies by posting a placeholder message that is **edited
in place** as pi streams, so you watch the answer appear live.

The bridge runs on **[Pi Durable](https://earendil.com/posts/pi-durable/)** — an
append-only, crash-safe conversation runtime. One process owns a SQLite store
(`bridge.sqlite`); Chat is a *client* of it, not the owner. That is what makes
**two frontends on one conversation** possible: the same conversation can be
watched and driven from Chat and from a browser at the same time (see
[Web frontend](#web-frontend)).

**Four listeners, one of which writes.** The store is owned by the host
(`dist/durable/main.js`), which serves `/v1`, `/healthz` and `/idle` on `PORT` and holds
no Chat credentials. The **Chat adapter** (`dist/chat-host.js`, `BRIDGE_CHAT_PORT`) holds
the service account, the Pub/Sub receiver, the delivery cursor and the painter, and serves
`/notify`; the **web adapter** (`dist/web-host.js`, `BRIDGE_WEB_PORT`) serves the page; the
**artifact origin** (`BRIDGE_ARTIFACTS_PORT`) is a separate origin on purpose, because those
documents are scripted and framed. The adapters are forked by the host and talk to it over a
chord link, so **restarting either one cannot interrupt a turn** — the turn is the host's.

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

**Prerequisites:** pi installed with provider API keys configured in
`~/.pi/agent`, and Node.js ≥ 22.19.

```bash
cd pi-gchat-bridge
npm install
cp .env.example .env
# edit .env: point GOOGLE_SERVICE_ACCOUNT_JSON at your key file
npm start            # runs the durable engine (tsx src/durable/main.ts)
```

For production, point your container at `./start-bridge.sh`, which supervises
the process, restarts it on crash, and starts cron and the local-model router.
`npm run start:sdk` runs the old SDK host instead.

Set `BRIDGE_CHAT_PORT` too (`.env.example` has it at 8084): the Chat adapter runs in its
own process and the host will not start without somewhere to point it.

That's it — the bot now answers messages in any space it's installed in, and
the same conversations are visible at `/web`.

## How it behaves

- **Live streaming replies** — after a short delay a "Thinking…" placeholder
  is posted and **patched in place** as pi generates the answer, so you watch the
  reply appear live. The patched text is sent with `markupSyntax: MARKDOWN`, so
  Markdown renders *while* it streams (code fences, bold, lists), not just at the
  end.
- **One conversation per thread** — keyed by thread, or by space for a
  non-threaded DM. Threads are fully independent conversations. Conversations
  live in the durable store, so they survive restarts *and* crashes: an
  interrupted turn is resumed, not lost. See
  [Session model & persistence](#session-model--persistence).
- **Interleaved messages (steer)** — sending a message while pi is working
  joins the *running* turn (`whenBusy: "steer"`): it is delivered after the
  current tool call finishes and before the next model call, so pi keeps its
  tool loop active and addresses your new message alongside the original work.
  Commands (`/help`, `/model`, `/settings`, `/resume`) instead interrupt the
  running reply. Because a steer joins the run, **a run that answers three
  messages posts one reply, not three** — the post is claimed per *answer* in
  the `gchat.posted-answers` document, so a queued message can never make the
  same reply appear twice.
- **pi extensions & skills work** — the session loads your `~/.pi/agent`
  extensions, so `/commands` and skills behave like in the TUI.
- **Images & text** — pasted (or uploaded) images are downloaded and passed to
  pi as multimodal input, so a vision model can describe what you send. Images
  can arrive with text or on their own (an image-only message is a valid
  prompt); non-image attachments are skipped with a notice.

  > Actually describing an image needs a **multimodal model** — a text-only
  > model won't see it (pi omits the image and the reply ignores it). The bot
  > still **can't send** images — that's a platform limit, see
  > [Known limitations](#known-limitations).

## Session model & persistence

Conversations live in **`bridge.sqlite`**, written by exactly one process. The
store is append-only: every model call, tool call and document change is a
commit, so an interrupted run resumes rather than being lost, and a message
that Pub/Sub redelivers is recognised by its id instead of being answered
twice.

- **The binding is a document, not a file.** A session-scoped document maps
  `chatKey → conversationId`, written in the *same commit* that creates the
  conversation, so a crash cannot leave a conversation no thread points at.
- **`/secret`** lists stored secrets (names and a tail, never values); **`/secret set NAME`** posts a card for out-of-band entry; **`/secret remove NAME`** deletes. Values never enter the conversation — see [Security notes](#security-notes). In the browser the same three forms exist, gated on the same `SECRET_USERS` allow-list, and the store is reached through the seam: an adapter may write a secret and **no operation returns one**.
- **`/sessions`** lists conversations; **`/resume`** rebinds a thread to one of
  them. `/name` gives one a display name (Chat-side label only).
- **Legacy history was imported once, at cutover.** The one-shot migration tools
  (`import-all`, `import-legacy`, `replay`, `prefix-probe`) were deleted once the
  cutover was done — they are in git history if a re-import is ever needed. What
  remains is `src/durable/smoke.ts`: one real prompt through one real model
  against a scratch database, the only end-to-end check that needs no Chat app,
  no Pub/Sub and no credentials.
- **One process owns the database.** `bridge.sqlite.lock` is a pid file: a
  second bridge refuses to start rather than serving the same Chat messages
  from a second, blind in-memory harness. Two supervisors cannot run either
  (`.start-bridge.pid`).

### Two local servers, and why

`lfm-server.sh` runs the same model **twice**: the conversation router on
`:8090` and a titler on `:8091`. That looks wasteful and is deliberate.

- **A title is a one-shot summary.** It is never resumed, so caching its prompt
  is worthless — but it is long, and on CPU it is expensive to prefill.
- **Sharing slots is the problem.** Titles used to go to the conversation
  router. With `-np 2`, every title took a slot and evicted that slot's KV
  prefix — i.e. it silently destroyed precisely the cache that makes
  conversations fast. Because the summary is long and the conversation prefix
  is what got thrown away, this was the single worst way to spend those slots.
- **Pinning `id_slot` does not fix it.** It protects one slot by permanently
  spending the other, so a title and a conversation could still never run at
  the same time — and the pinned slot's contents still get overwritten.
- **Separate processes cost little and remove it entirely.** The titler runs
  `-np 1 -c 8192` (a title needs a fraction of the context) for roughly 180 MiB,
  and the bridge sends `cache_prompt: false` on every title request, so the
  titler's slot accumulates nothing it will never reuse.

The bridge defaults `BRIDGE_TOPIC_SUMMARY_BASE_URL` to `:8091` for this reason.
Pointing it back at `:8090` "works" but reintroduces the eviction.

### Model and thinking level

- **`/model` in a conversation** switches **only that conversation** — one
  card with two dropdowns: model and thinking level. Both are applied with
  `conversation.configure()`, so they survive restarts and other conversations
  are unaffected. Neither changes the global defaults.
  > Switching models in a thread with a turn in flight **interrupts** that turn
  > (the new model cannot apply mid-turn). The following message then runs on
  > the new model.
- **Thinking in the `/model` card** lists **only the levels the selected
  model actually supports**, and re-renders when you change the model: the
  dropdown carries an `onChangeAction`, so Chat submits the form and the
  bridge patches the same card with that model's levels (they're per-model —
  pi's rule is `reasoning: false` → `off` only, otherwise everything except
  what `thinkingLevelMap` nulls out, with `xhigh`/`max` only when mapped).
  `— keep current —` stays available only when the current level is one of
  them; otherwise the dropdown pre-selects the level pi would clamp to (e.g.
  `medium` → `high` on a model that lacks `medium`), so the card never shows a
  level that can't happen. The confirmation still reports the level that took
  effect. Non-reasoning models (`reasoning: false` in `models.json`) are
  always `off`.
- **`/model` in a brand-new conversation** (no session yet) **starts that
  conversation** on the model you pick: the session is created on it (written
  as a `model_change` entry) and the bridge posts a gchat-only notice
  — *“Starting a new conversation with model …”* — that is never sent to pi.
  The global defaults are untouched.
- **Topic titles on the “Model switched” card.** When that card *starts* a
  conversation it becomes the thread's top message — i.e. the one line the
  space's conversation list shows — which says which model is running but
  nothing about the subject. So once the first reply has been posted, the
  bridge asks a **local model** (llama.cpp, no API cost, always available) for
  a one-line topic and patches only the card's **header**, keeping the
  "New conversation on *model*" body as it was:

  ```
  Sign requesting employees to monitor noise levels in a workspace
  ───
  New conversation on LFM3-VL-2B Q8 (local CPU, free) (llama-local).
  ```

  It runs **detached, after the reply**, so a slow CPU model never delays
  anything, and it reads only the first user message plus the first
  assistant reply, skipping thinking blocks and tool output. Images are
  forwarded, so a photo-only "what's going on here" gets a title too. The
  title is written **only to the Chat card**, never to the session file, so
  pi's history and prompt cache are untouched; `/name` still sets the session
  name separately. If the local model is down or too slow the card keeps the
  plain "Model switched" wording (no retry). Configure or disable with
  `BRIDGE_TOPIC_SUMMARY*` below.
- **`/settings`** (formerly `/defaultmodel`, still accepted as an alias)
  changes the **defaults for *new* conversations** in settings.json, again as
  model + thinking level, with the same dynamic thinking list.
  Existing conversations keep their own model and
  level — switch those individually with `/model` in each conversation.
  `defaultThinkingLevel` is model-independent, so it is clamped per model when
  a new conversation starts from it.
- **`/status`** shows the conversation's model and thinking level (or, with no
  conversation yet, the defaults that a new one would use).
- API access needs an API key scoped to the provider's models, or the model
  will appear in the picker but fail to be selected.

## Web frontend

The same conversations, in a browser. The bridge serves a small page (no build
step) at `/web` — or under whatever prefix a reverse proxy gives it.

- **`GET /web`** — the page (served by the web adapter when `BRIDGE_WEB_ENGINE=link`)
- **`GET /web/api/conversations`** — the index, newest first
- **`GET /web/api/c/:id/history?before=`** — a page of transcript, **anchored**: `before` is
  the oldest entry id held and `before=0` is the first paint. Markdown is rendered
  server-side here, because this origin can submit messages and a client-side renderer
  would be an injection path that can drive tools
- **`GET /web/api/c/:id/events`** — `text/event-stream`: whole snapshots plus
  the current tool status
- **`POST /web/api/c/:id/message`** — submit a message (`whenBusy: "steer"`),
  with optional inline images
- **`POST /web/api/c/:id/commands`** — the slash commands, answered with one of four shapes
  (`text`, `list`, `choice`, `form`) rather than a card; `/model` returns a form whose
  thinking levels follow the model you pick
- **`GET /web/api/c/:id/artifacts`**, **`…/comments`** — the artifact drawer and the review
  comments

**Images.** Three ways in, one place to land: paste a screenshot, press 📎 to
pick files, or drop them on the pane. They become thumbnails above the composer
(each removable) and ride with the message as content parts — the shape Chat
sends, so the model and the transcript agree.

- Nothing is uploaded until you send, so there is no orphaned temp file to
expire; the whole message is one payload.
- Refused before sending, with a reason naming the file: anything that is not
  `image/*`, anything over 8 MB after decoding, or more than 10 images in one
  message. The route enforces the same limits, so a direct POST cannot bypass
them.
- The 24 MB body cap is the real ceiling for a message full of images; the
  per-image and per-message limits exist so that case is a sentence rather than
a bare `413`.
- A phone has no "paste" for a photo that was never on its clipboard, which is
  the case the picker and drop exist for.

**Why this is in-process, not a separate app.** Pi Durable's `viewState()` and
`subscribe()` are in-memory fan-out: any number of clients can attach to a
conversation *inside the process that owns it*. Its storage has no cross-process
change notification, so a server in another process could never see a Chat turn
commit. Chat and the browser are therefore two sinks on one conversation — a
turn started in Chat streams into the browser and vice versa — rather than two
conversations being replicated. This is also why a standalone web app (e.g.
`pi-pocket`) cannot be pointed at this store: it takes the store exclusively.

One `viewState()` per connected browser, seeded from its snapshot, so a client
connecting mid-turn paints the in-progress answer instead of a blank page.

**Reverse proxy.** The page is mount-agnostic: every URL is resolved relative to
the page's own directory, and the server strips an optional prefix before
`/web`, so both `/pi/web` (prefix passed through) and `/web` (prefix stripped)
work with no base-path configuration. Two proxy settings matter:

- **Buffer off** for `/web/api/` — otherwise SSE frames arrive in clumps
- **Read timeout above ~30 s** — the server sends a `keepalive` comment every
  15 s

**Security.** The bridge implements **no authentication of its own**, by
design: it binds `127.0.0.1` (`BRIDGE_BIND`) and expects an identity-aware proxy
in front of it. Anyone who can reach the port can read every conversation and
submit as the bot — and this bot can run `bash`. Do not bind `0.0.0.0` unless
that is genuinely what you want.

### Installing it as an app

The page is a progressive web app in the narrow sense that matters here: it can be
installed, and once installed it opens as its own window with no browser chrome.

- **`GET /web/manifest.webmanifest`** — generated per request, because `start_url`
  and `scope` are the mount root of the request that asked for it (`/web/`,
  `/pi/web/`, or `/` behind a prefix-stripping proxy). A static manifest could only
  name one of those, and a wrong `start_url` installs an icon that opens the wrong
  place. The scope is always exactly the mount, never `/`, so an install behind a
  prefix cannot capture the rest of the origin.
- **iOS** ignores enough of the manifest that the page also carries
  `apple-mobile-web-app-capable`, a status-bar style and a title. Install from
  Safari's share sheet — there is no prompt.
- **No service worker.** An installed pane is the *same conversation* as the Chat
  thread, so it has no offline story worth caching: no history to page, no message
  to submit, no model to answer. A worker would only serve a shell that cannot do
  anything, and would add an update protocol underneath the `pageVersion` reload
  the page already does.
- **Nothing about access changes.** Installing does not authenticate anything: an
  installed app is still the same origin behind the same proxy policy, and the
  bridge still has no auth of its own.

### Reaching it without a VPN client

`tailscale serve` is the simplest option if every device can run Tailscale. For
devices that can't, **Cloudflare Tunnel + Access** gives a public hostname with
SSO and no client — see [`cloudflared.yml`](cloudflared.yml):

```
browser → Cloudflare edge → Access policy → tunnel → 127.0.0.1:8081
```

- **Authentication happens at the edge.** Access evaluates the policy *before*
  the request enters the tunnel, so unauthenticated traffic never reaches this
  machine. Nothing in the bridge decides who gets in.
- Cloudflare then injects `Cf-Access-Authenticated-User-Email`, which the bridge
  **logs per submission** (`[web] <email>: submitted to conversation N`). That is
  the only identity header the bridge reads — other proxies' variants are
  deliberately ignored, since some (`X-Forwarded-Email`) are user-controllable.
- Identity headers are honoured only when the socket peer is
  `BRIDGE_TRUSTED_PROXY` — otherwise they are spoofable by anything that can
  reach the port, and a warning is logged instead.
- **`disableChunkedEncoding: true`** in the tunnel config is required for SSE:
  without it the edge can hold frames until the response ends, and an event
  stream never ends. `keepAliveTimeout` must exceed the 15 s keepalive the
  bridge sends.

Cost is $0 for a single user (Zero Trust Free includes 50 seats). The trade is
that Cloudflare terminates TLS and can see prompts and command output — a real
decision for a bridge with shell access.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | — (required) | Path to service account key |
| `PUBSUB_SUBSCRIPTION` | — (required) | `projects/.../subscriptions/...` |
| `PI_CWD` | bridge dir | Working dir for pi tools |
| `BRIDGE_ENGINE` | `durable` | `durable` (Pi Durable) or `sdk` (the old SDK host, kept for rollback) |
| `BRIDGE_DB` | `./bridge.sqlite` | The durable store. One process owns it |
| `BRIDGE_BIND` | `127.0.0.1` | Address the HTTP server binds. Loopback by default; a tunnel or proxy goes in front |
| `BRIDGE_TRUSTED_PROXY` | — | Address identity headers are trusted from. Empty = trust none, even on loopback |
| `BRIDGE_WEB_TOKEN` | — | Bearer token for web writes; empty = no check (rely on the proxy) |
| `BRIDGE_WEB_ENGINE` | `inprocess` | `link` serves `/web` from a forked adapter (`dist/web-host.js`) on `BRIDGE_WEB_PORT` |
| `BRIDGE_WEB_PORT` | — | Where the web adapter listens. The tunnel's ingress points here, not at `PORT` |
| `BRIDGE_CHAT_PORT` | — (required) | Where the Chat adapter (`dist/chat-host.js`) listens — **and where `/notify` is served**. `cron/.env` points there. A request to `PORT`/notify answers with this address |
| `BRIDGE_SESSIONS_DIR` | `./sessions` | Legacy JSONL sessions — read by the importer and the old engine only |
| `BRIDGE_STATE_FILE` | `./state.json` | Legacy dedupe state — superseded by the store's submission ids |
| `PORT` | `8080` | Health endpoint (0 disables) |
| `BRIDGE_STALL_TIMEOUT_MS` | `1200000` (20 min) | Watchdog: force-reset a session streaming with no agent activity for this long (0 disables) |
| `BRIDGE_WATCHDOG_INTERVAL_MS` | `30000` | Watchdog scan interval |
| `BRIDGE_SESSION_IDLE_MS` | `0` | Evict an idle, non-streaming session from memory after this long (0 disables) |
| `ALLOWED_SPACES` | — | Comma-separated spaces (name or ID) the bridge responds in; empty = all |
| `ALLOWED_USERS` | — | Comma-separated users (name or ID) allowed to trigger pi, including card clicks; empty = anyone |
| `SECRET_USERS` | — | Comma-separated users allowed to use `/secret`; empty = same as `ALLOWED_USERS` |
| `BRIDGE_SECRETS_FILE` | `~/.pi-bridge/secrets.json` | Where `/secret` stores values. Deliberately outside `PI_CWD` |
| `BRIDGE_REPLACE_ON_FINISH` | `1` | `1`: post the final answer as a new message (the completion notification), then delete the streaming placeholder (leaves a "Message deleted" stub). `0`: keep the patched placeholder as the answer (no stub; the notification is the one posted when the placeholder appears). |
| `BRIDGE_TOPIC_SUMMARY` | `1` | Re-title the `/model` "Model switched" card with a local-model topic line once the first reply lands. `0` keeps the plain wording. |
| `BRIDGE_TOPIC_SUMMARY_BASE_URL` | `http://127.0.0.1:8091/v1` | The **titler** server (see [Two local servers](#two-local-servers-and-why)). Not the conversation router. |
| `BRIDGE_TOPIC_SUMMARY_MODEL` | `lfm3-vl-2b-q8` | Model id requested from that endpoint. |
| `BRIDGE_TOPIC_SUMMARY_TIMEOUT_MS` | `900000` (15 min) | Give up on a title after this long — CPU inference is slow and the server may have one slot. The job is detached, so waiting is free. |

## Testing

```bash
npm test            # only what your change can affect (seconds)
npm run test:all    # the whole suite, isolated processes (about three minutes)
```

Runs the unit test suite (Node's built-in runner via `tsx`). It covers the pure
logic: projection of a durable view into a Chat reply, the Chat sink, the
router's dedupe/steering contract, the command layer's query semantics, the
web sink, and failure notices. Tests never open the live database or call a
model — the harness is reached through structural fakes.

`npm test` is change-aware, in the smallest useful way: each test file has a key
made of everything it transitively imports plus the tooling that changes what a
test *means* (`tsconfig`, `package.json`, non-`.ts` files read at runtime such as
`page.html`), and a file whose key is unchanged since it last passed is skipped.
`npm run test:all` ignores that cache and runs everything in isolated processes —
use it before believing a green run, and after touching something the analysis
cannot see.

```bash
node scripts/changed-tests.mjs --list      # what would run, run nothing
node scripts/changed-tests.mjs --explain test/ledger.test.ts   # why is this running?
```

If a change seems to have skipped too much, `--explain` names the file's whole
dependency closure and says when an import could not be resolved statically —
those files always run. Delete `node_modules/.cache/bridge-tests/` to forget
everything.

```bash
npm run evals                             # local-model evals (topic titles)
npm run evals -- --case disk-space --judge
```

`evals/` holds the model-quality evals for jobs that aren't deterministic code —
currently the `/model` card titler. Cases are mined from real conversations in
`sessions/` and graded deterministically first, with an optional LLM judge for
the judgement calls. See `evals/README.md`.

### Stuck turns

The old watchdog (`BRIDGE_STALL_TIMEOUT_MS`) forced a hung *session* to reset.
On the durable engine this is the harness's job: a run that stops making
progress is parked and resumed on the next start, and `harness.resume()` runs
at startup. A turn that ends without an answer is now logged with its status,
reason, duration and conversation id, and Chat is told which of those it was —
*a stopped turn*, a *finished-but-empty* one, or a *failed* one — because those
need different responses from a person.

The historical case, kept for context:
The watchdog checks each streaming session for agent activity (any emitted
event) and, after `BRIDGE_STALL_TIMEOUT_MS` of silence, aborts the stuck run,
drops the incomplete trailing turn from the session file (so the hung tool call
is never re-run), and reopens the session. Deferred "busy" messages are then
redelivered by Pub/Sub to the fresh session.

## Roadmap

- [x] Pub/Sub receiver (DMs + spaces, no public endpoint)
- [x] Streaming replies (live in-place editing)
- [x] Pi Durable engine (crash-safe store, one conversation per thread)
- [x] Web frontend sharing conversations with Chat
- [x] Topic titles, on a dedicated local titler server
- [ ] Artifacts (agent-published HTML/Markdown/SVG, versioned per id)
- [x] Allowed-users filter (whitelist who can message the bot) — `ALLOWED_USERS`, applied to messages *and* card clicks
- [x] Parallel processing: per-thread sessions + concurrent dispatch (threads are independent; serial within a thread)

## Security notes

### The threat model, stated

This bridge defends against **accident**. It does not defend against an attacker
who already has code execution on this machine, and it does not defend against
the model itself being adversarial — if the agent can run `bash`, it can reach
anything the bridge user can reach.

Two things follow, and they are deliberate rather than oversights:

- The bridge and its shell share a UID. The secret store
  (`~/.pi-bridge/secrets.json`, mode 0600) is therefore *readable* by anything
  the agent runs. It buys "not in the conversation, not in the session export,
  not in the model's context, not in the Chat scrollback", which is the risk that
  actually bites.
- Nothing here replaces not giving the bridge credentials it does not need.
  Narrow, short-lived credentials beat every mechanism below.

### What is in place

- **The service account has `chat.bot` scope only** — it can read messages in
  spaces it is in and post as the bot. It cannot touch Drive, Mail or Calendar.
- **`ALLOWED_USERS` / `ALLOWED_SPACES`** gate who can trigger the bot. Both apply
  to messages *and* card clicks; a card click can open a control that stores a
  credential, so "who clicked" is as load-bearing as "who typed".
- **`SECRET_USERS`** gates `/secret` separately (falling back to
  `ALLOWED_USERS` when unset), because spending tokens and reading the secret
  inventory are different risks.
- **`/web` has no authentication of its own, by design.** It binds loopback and
  expects an identity-aware proxy in front. Anyone who can reach the port can
  read every conversation and submit as the bot — and this bot can run `bash`.
- **Secrets stay out of the model's context.** Two mechanisms, deliberately
  complementary:
  - `/secret set NAME` captures a value on a **card**, so it never becomes a
    message. `runDurableCommand()` consumes the submission before
    `router.deliver()`, so the value cannot reach the transcript.
  - A redaction extension (`src/durable/extensions/`) scrubs every registered
    value from tool output (`afterTool`) and from **every model request**
    (`beforeRequest`) — the last gate before bytes leave the machine. Each value
    is matched as typed, JSON-escaped, URL-encoded and in three base64
    alphabets. It fails closed: if redaction cannot complete, the request is not
    sent.

### What is not in place (known, accepted)

- **Redaction is pattern-based, not a boundary.** A transformed value (hex,
  reversed, split, inside a larger blob) passes. A secret written to a file by
  the `write` tool stays on disk; only its later *reads* are scrubbed.
- **Structured tool output is not rewritten.** `structuredOutput` is
  schema-validated for program callers, so rewriting its strings would break the
  contract. A secret returned that way never enters the transcript, but a
  codemode script sees it.
- **`~/.gmcli` and similar token stores are readable by the agent.**
  Credentials owned by a filesystem-reading CLI cannot be protected by an HTTP
  proxy or by redaction.
- **Provider credentials are not yet off-host.** API keys are still supplied to
  the bridge; an egress proxy that injects them upstream — so the agent never
  holds a real value — is the next step, not a shipped feature.

### If you expose this beyond the machine

1. Keep `BRIDGE_BIND=127.0.0.1`. The tunnel is a security boundary only if it is
   the only way in; a second listener makes the Access policy decorative.
2. Put identity-aware auth at the edge (see `CLOUDFLARE.md`), with a short
   session and WebAuthn if you have it.
3. Never expose the secrets proxy through the tunnel — it is an egress gate for
   the agent, not a service for the world.

## Known limitations

These are platform-level constraints (verified Aug 2026) — the bridge can't
work around them without external pieces:

- **Only one bridge may run at a time.** With multiple instances pulling the
  same Pub/Sub subscription, each message is delivered only to the instance
  that pulls it first, so replies get split across instances (each message
  goes to just one) rather than duplicated.

- **Personal Gmail accounts can't use the bridge.** Custom Chat apps (bots)
  are only available to Google Workspace organizations — a personal Gmail
  account can chat with a bot but can't install or develop one, so the bridge
  needs a Workspace account.

- **Markdown tables don't render — the bridge converts them.** Since Aug 2026
  replies go out with `markupSyntax: MARKUP_SYNTAX_MARKDOWN`, so standard
  Markdown (bold, italic, strikethrough, monospace, code fences,
  bulleted/nested/numbered lists, block quotes, links) renders properly in
  Chat. GFM pipe tables are *not* in the supported subset, and Chat's fallback
  is destructive: the rows are concatenated with **no** separator, so a table
  collapses into a run-on paragraph (`… F16258.1 ± 34.03.58 t/s…`) and swallows
  whatever line follows it. `src/chat-markdown.ts` therefore rewrites every
  outgoing message (posts, PATCHes, `/notify`) before it leaves the bridge:
  pipe tables become one bullet per row with the column names taken from the
  header (`- **Q8_0** — method: naive RTN from F16; PPL: 258.1 ± 34.0`),
  headings (`## x`, which Chat renders as a plain bold line) become `**x**`,
  and single line breaks become CommonMark hard breaks (two trailing spaces,
  verified supported) so lines aren't glued together — a plain `\n` inside a
  paragraph is joined with a space. Fenced code blocks pass through untouched.
  There is still no real table widget (cards don't have one either), and the
  model is also told up front not to emit tables (`chat-format` extension in
  `pi-agent/extensions/`), which reads better than a mechanical conversion.
  Tracked upstream: [issue 428659965](https://issuetracker.google.com/issues/428659965).

- **Streamed placeholders render Markdown (Oct 2026).** A text PATCH keeps the
  message in Markdown syntax as long as `markupSyntax` is sent **in the body**
  (`updateMask=text`); only the field-mask form (`updateMask=text,markupSyntax`
  or `updateMask=markupSyntax`) still 400s with "Unsupported path name in message
  field mask". Send a PATCH *without* the field and the message drops back to
  legacy Chat syntax.

- **Sentences are never split mid-line.** Replies longer than the 4,000-char
  message cap are chunked at a line boundary where one exists (`splitMessage`),
  and a fenced code block that straddles the cut is closed at the end of one
  chunk and reopened at the start of the next, so the second half isn't
  rendered as prose.

- **The "Message deleted" stub is a notification trade-off.** Notifications fire
  on message *creation*, not on a PATCH (with app auth there is no other
  notify-on-update hook), so with `BRIDGE_REPLACE_ON_FINISH=1` (default) the
  answer is posted as a new message — that create is the "reply is ready" ping —
  and the placeholder is deleted afterwards, which leaves the stub. The answer
  is created *before* the placeholder is deleted, so a failed create falls back
  to keeping the streamed placeholder as the answer instead of losing the reply.
  With `BRIDGE_REPLACE_ON_FINISH=0` the placeholder becomes the answer (no stub,
  no duplicate message), but the ping is the one emitted when "Thinking…"
  appears — and in a top-level conversation the placeholder is then *not* sent
  silent, otherwise a slow reply would arrive with no notification at all.

- **Threaded conversations get more than one notification per reply.** In a
  thread you'll get a ping for the "Thinking…" placeholder, another for the
  relocated placeholder after a steering message, and — with the default
  `BRIDGE_REPLACE_ON_FINISH=1` — one for the final answer. Google's API rejects
  `silent` for threaded messages (403 when combined with `messageReplyOption`,
  verified Aug 2026) and thread placement isn't patchable, so a silent message
  inside an existing thread isn't possible. Top-level (non-threaded)
  conversations get exactly one notification.

- **Bots can't upload media attachments.** The `attachments:upload`
  (`media.upload`) endpoint rejects service-account auth outright
  ("This method doesn't support app authentication with a service account")
  — even with `chat.messages` claimed on the service-account token. It
  requires **user delegation**: user OAuth (`chat.messages` scope, one-time
  consent) or Workspace **domain-wide delegation** (service account
  impersonating a user). Either way the attachment message is attributed to
  the delegated user, not the bot, so inline images from pi aren't possible
  with the current `chat.bot`-only setup. Tracked upstream:
  [issue 447642391](https://issuetracker.google.com/issues/447642391).

- **No typing/thinking indicators.** The Chat API currently has no support
  for typing or thinking indicators for bots — the bridge fakes liveness with
  the delayed "Thinking…" placeholder instead. Tracked upstream:
  [issue 166140696](https://issuetracker.google.com/issues/166140696).

## Disclaimer

This is a personal project. The views, code, and opinions expressed here are
my own and do not represent those of my current or past employers.
