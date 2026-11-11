# How the bridge is put together

The README explains what the bridge does and how to run it. This is the inside: the processes, the
store, the delivery model, and the rules that shaped them — with the reasons, because most of them
were learned from a failure and the failure is the part worth keeping.

## Four listeners, one of which writes

- **`PORT`** (`8081` in the durable deployment) — the **host**: `dist/durable/main.js`. Owns the
  SQLite store, and serves `/v1` (the conversation protocol), `/healthz` and `/idle`. It holds **no
  Chat credentials** and no browser session.
- **`BRIDGE_CHAT_PORT`** (`8084`) — the **Chat adapter**: `dist/chat-host.js`. Holds the service
  account, the Pub/Sub receiver, the delivery cursor and the painter, and serves `/notify`.
- **`BRIDGE_WEB_PORT`** (`8083`) — the **web adapter**: `dist/web-host.js`. Serves the pane and the
  routes it calls.
- **`BRIDGE_ARTIFACTS_PORT`** (`8082`) — the **artifact origin**. A separate *origin* is a security
  boundary, not a preference: those documents are scripted and framed by the pane, so they must not
  share an origin with the API the pane talks to.

The two adapters are forked by the host and talk to it over a chord link. **Restarting either one
cannot interrupt a turn**, because the turn is the host's — that is the property the whole split
exists for.

## The store

`bridge.sqlite`, written by exactly one process. Append-only: every model call, tool call and
document change is a commit, so an interrupted run resumes rather than being lost, and a message that
Pub/Sub redelivers is recognised by its id instead of being answered twice.

- **The binding is a document, not a file.** A session-scoped document maps `chatKey →
  conversationId`, written in the *same commit* that creates the conversation, so a crash cannot
  leave a conversation no thread points at.
- **One process owns it.** `bridge.sqlite.lock` is a pid file: a second bridge refuses to start
  rather than serving the same Chat messages from a second, blind harness.

## Delivery

The server has no memory of its readers. There is no delivery table and no per-surface offset: a
bridge keeps its own position (`bridge-ledger.json`), and the server guarantees an ordered log to
measure it against. A surface can be closed for a week and nobody has to remember anything on its
behalf.

- **The cursor is global**, because entry ids are: one number serves every conversation, so a busy
  thread cannot starve a quiet one of an earlier entry.
- **Adoption happens at startup only.** A bridge that was away paints what it missed, oldest first —
  a missing reply is worse than a visible burst.
- **The painter is the only mouth.** For each Chat conversation exactly one component posts: it reads
  the log past its cursor and posts the answer, quoting the prompt when the prompt came from another
  surface. Everything that used to arbitrate between two posters (claim documents, answer races) is
  gone rather than idle.
- **`/v1/poll` carries the facts and the draft.** One long poll states a cursor and gets entries;
  with `observe=1` it also carries the running turn's view and answers when *either* changes. Live
  text is a latest value, not a sequence of entries — a draft is a revision of one message, and
  putting revisions into an append-only log would make "what did the assistant say" ambiguous and
  make the log grow with turn length.

## The seam

Adapters reach the host through `SessionHost` (`src/session-host/api.ts`), and nothing else: a
boundary the tests enforce, because an adapter that can name a library type can reach past it. It is
plain data, bounded by construction — a projection, a derived list, an id — and the transcript never
travels.

Over a link, the same interface is published as chord contracts. The rule for what crosses is the
same in both directions: **an operation is published the day a running adapter calls it**, not
before. `unbind`, `replyToComment` and `writeNotice` were removed once an audit showed nothing called
them.

## Titles, and the second local model

`lfm-server.sh` runs the same model **twice**: the conversation router on `:8090` and a titler on
`:8091`. That looks wasteful and is deliberate.

- **A title is a one-shot summary.** It is never resumed, so caching its prompt is worthless — but it
  is long, and on CPU it is expensive to prefill.
- **Sharing slots is the problem.** Titles used to go to the conversation router. With `-np 2`, every
  title took a slot and evicted that slot's KV prefix — silently destroying precisely the cache that
  makes conversations fast.
- **Pinning `id_slot` does not fix it.** It protects one slot by permanently spending the other.
- **Separate processes cost little and remove it entirely.** The titler runs `-np 1 -c 8192` for
  roughly 180 MiB, and the bridge sends `cache_prompt: false` on every title request.

`BRIDGE_TOPIC_SUMMARY_BASE_URL` defaults to `:8091` for this reason. Pointing it back at `:8090`
"works" but reintroduces the eviction.

## Where the longer arguments live

Design decisions with a cost attached — delivery as client state, one liveness mechanism, the
command surface's four shapes — were written up as they were made, in the conversation's own
artifacts (`conversation-server-api.md`, `central-conversation-server.md`). This file is the part
that stayed true; those are the working.

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

