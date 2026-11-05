# The session-host seam: `SessionHostApi`

Status: proposal, not started. Builds on [migration-to-durable.md](migration-to-durable.md); changes
none of its decisions. Partly validated by the artifact origin, which shipped first — see below.

## Why

The durable migration made the harness own the sessions, but the adapters still live *inside* it.
Every Chat and web code path reaches through `BridgeHost` into `host.harness` and pi-durable's own
types, so "the web adapter" cannot be built, tested, or restarted without the storage file, the
models, the tool registry and the pid lock.

The point of this proposal is **not** a second process. It is one interface with no pi-durable and
no chord types in it, so that all of these become transport choices instead of rewrites:

- a web adapter in its own process, restartable while a turn is running
- an adapter tested against a fake host, with no SQLite and no model
- two web adapters (dev + live) on one host
- the next surface (voice, a CLI) without touching the host

Success criterion, checkable by a test: `grep -r "@earendil-works/pi-durable" src/adapter/` finds
nothing, and `grep -r "host.harness" src/adapter/` finds nothing.

## What the artifact origin already validated

`docs/artifacts.md` shipped a second HTTP surface *inside the same process*: a separate listener on
its own port, its own hostname, and a route table that contains only reads. It is the smallest
possible version of this proposal, and it produced three pieces of evidence rather than argument.

**Capability separation by route table is cheap and real.** The artifact host cannot reach
`/web/api/.../message` because no such route is registered there — not because a header check said
so. That cost one `http.createServer` call.

**The seam's primitive is already shared by two consumers.** The artifact index needed a
conversation lookup, a `viewState()` snapshot, and `dispose()`. That is `attach` minus the
subscription — so `snapshot(conversationId)` is the primitive both the web pane and the artifact
index want, and neither wants anything else.

**But the coupling grew.** Adapters and Chat-side helpers now reach through `host.*` 67 times across
five files, and five files in `src/adapter/` import pi-durable or chord types (was four). Every new
surface re-derives the same handful of operations, which is the argument for building the seam
before a sixth appears.

## Responsibilities

| | Session host (one process, one DB) | Adapter (one per surface) |
|---|---|---|
| Storage | owns the file, the lock, all commits | none |
| Turns | submit, steer, await, abort, resume | — |
| Conversations | create, configure, compact, view | which name maps to which conversation |
| Model catalog | `ModelRuntime`, thinking-level support | which model a name prefers |
| Rendering | projection (`liveText`, `busy`, `tools`) | Chat markdown, chunking, cards, HTML/SSE |
| Secrets | registry, redaction **before** text leaves | `/secret` UX and its allow-list |
| Titles | model call + transcript (local router) | when to ask for one |
| Transport | — | Pub/Sub pull/ack, Chat API, HTTP |

Two consequences worth stating in the code, because both are easy to get wrong later:

1. **Redaction is host-side.** A frame or an answer that leaves the host is already redacted, so an
   adapter cannot leak a secret by forgetting to call a redactor.
2. **Titles are host-side.** The title model here is a local 2B router on two cores; a second model
   runtime in an adapter would compete with the host for the same CPU and re-prefill the same
   conversation.

## The interface

Plain data types only: `conversationId` and `entryId` are `number` on the seam (the branded
`ConversationId`/`EntryId` stop at the boundary), and cancellation is an `AbortSignal`, never a
chord `Context`.

### Names and identity

Chat keys are *the adapter's* names. The host stores them but does not interpret them ("a name is a
string the adapter chose and will ask for again").

| Op | Replaces | Missing today |
|---|---|---|
| `getOrCreate(name, agent) → NamedConversation` | `BridgeHost.conversationFor()` (9 call sites), the `BindingsDoc` read-modify-write, and the in-memory `pending` map | Uniqueness is check-then-act: `bindingFor()` reads **outside** the commit, then `create()` commits. See D1 |
| `resolve(name) → NamedConversation \| undefined` | `host.bindingFor()` (16 sites) | — |
| `list() → NamedConversation[]` | `host.bindings()` (3 sites) | — |
| `create(name, agent) → NamedConversation` | `queries.startConversation()` (`/new`) | `/new` currently duplicates the bind+configure commit that `host.create()` already does |
| `bind(name, conversationId, opts) → boolean` | `queries.rebind()` (`/resume`) | — |
| `unbind(name) → boolean` | `host.unbind()` | — |
| `label(name, label)` | `queries.renameConversation()` (`/name`) | — |

`NamedConversation = { conversationId, name, label?, model, thinkingLevel?, createdAt }` — the
binding record, minus its storage representation.

### Turns

| Op | Replaces | Missing today |
|---|---|---|
| `submit(conversationId, { requestId, content, whenBusy }) → { submissionId }` | `router.deliver()` → `conversation.submit()`, and the `requestId` dedupe contract | Nothing structural; it needs a documented "accepted" meaning (D2) |
| `await(submissionId, { signal }) → Settled` | `submission.wait()` **plus** the four lines in `main.ts` that commit `AssistantEntry`, flatten `model[].content[].text` and inspect `reason`/`detail` | The final-text extraction belongs on the host; adapters should never see an entry (D4) |
| `abort(conversationId) → boolean` | `conversation.abort()` (`router.interrupt()`) | — |
| `write(conversationId, entry) → entryId` | `router.noticeSubmission()` (an `app.notice` write) | Adapter-authored entry kinds need a declared schema on the seam |

`Settled = { status: "done", answerId, text } | { status: "unanswered", reason?, detail? }`.
`answerId` stays on the seam because the Chat adapter's delivery claim is keyed by it (`posted-doc.ts`).

### View

| Op | Replaces | Missing today |
|---|---|---|
| `snapshot(conversationId) → ProjectedView` | `conversation.viewState()`'s snapshot half (10 sites in `src/`) | Done — see "Boundary readiness" for why it is a projection and not entries |
| `artifacts(conversationId) → ArtifactFile[]` | the artifact index walking `entries` and filtering paths itself | Done — derived host-side, so 19 records cross instead of 1,085 entries |
| `attach(conversationId, sink) → ViewHandle` | `conversation.viewState()`'s subscribe half + `projectView()` called in each adapter | Projection must move host-side (D3), or every adapter keeps a pi-durable type |
| `status(conversationId) → ConversationStatus` | `queries.conversationStatus()` / the `/model` card: `conversation.agent()` + `viewState()` + usage, assembled in the adapter | Assembling "what `/status` shows" is host knowledge |

`attach` is snapshot-first and then frames, exactly as `viewState().subscribe()` is today. Frames are
whole snapshots, which is why a dropped frame, a reconnecting browser, and a restarted adapter are
all harmless — no resync protocol exists or is needed. Over a socket this becomes the difference
between a bounded queue with drop-oldest and a stall.

### Settings and models

| Op | Replaces | Missing today |
|---|---|---|
| `agent(conversationId) → AgentInfo` | `conversation.agent()` | — |
| `setModel(conversationId, { provider, modelId, thinkingLevel? }) → AgentInfo` | `queries.switchModel()`: `configure()` **and** the binding update in one commit | Keeping that atomicity is the reason this is one op rather than two |
| `compact(conversationId, instructions?)` | `conversation.compact()` (`/compact`) | — |
| `models() → ModelInfo[]` | `host.modelRuntime.getAllAvailable()` (14 `modelRuntime` sites) | Model metadata must be plain data, not a `Model` |
| `thinkingLevels(model) → string[] \| undefined` | `queries.supportedThinkingLevels()` | — |
| `usage() → UsageTotals` | `harness.usage()` | — |

### Adapter-scoped durable state

Adapters need durable storage too: the bindings doc, `PostedAnswersDoc` (one answer, one Chat post),
`VerdictsDoc` (notification validation), and `state.json`'s processed list. Today they get it by
importing `defineDoc` and calling `harness.commit()`. The host should expose it narrowly instead:

| Op | Replaces | Missing today |
|---|---|---|
| `doc.get(namespace, key)` / `doc.set(namespace, key, value)` | `BindingsDoc`, `VerdictsDoc` commits | Namespacing, so one adapter cannot read another's state by accident |
| `doc.claim(namespace, key, value) → boolean` | `posted-doc.claimAnswer()` — the atomic "post this answer once" | Must be a single compare-and-set commit; anything stronger is a transaction API leaking through (D5) |
| `title(conversationId) → string \| undefined` | `durable/topic.ts` (`applyDurableTopicSummary`) | Whether the host owns the model call (D7) |
| `secret(name, value)` / `secretNames() → string[]` | `SecretStore` + `createSecretRedactor()` wiring | The adapter must not need the store's file path (D6) |

### Lifecycle

- `info() → { protocolVersion, epoch, dbPath, cwd, startedAt }` — `epoch` changes on host restart, so
  an adapter can tell "the host restarted, re-attach" from "the stream went quiet". In-process this
  is nearly free; over a socket it is the difference between a reconnect and a mystery.

That is 26 operations by the time S1–S4 landed, counted one per row above plus `awaitSubmission`,
`write`, `compact`/`abort`, and the five adapter-state operations. Earlier I estimated "12–14"; the
measured surface says otherwise — most of the extra is adapter-owned state, which is not
"conversation" work but has to live somewhere both sides agree on.

## The Chat path, after the seam

```
Pub/Sub ─► adapter: keyFor(space, thread) ─► host.getOrCreate(name, agent)
                     │                                    │
                     ├─► host.attach(id, sink) ─► ReplyStream (paint)
                     ├─► host.submit(id, {requestId, text, whenBusy: "steer"})
                     │            └─ commit accepted ─► ack Pub/Sub        (D2)
                     └─► host.await(submissionId) ─► Settled{answerId, text}
                                  │
                                  ├─► host.doc.claim("gchat", chatKey, answerId) ─► post, or skip
                                  └─► stream.finish(text)
```

Everything Chat-shaped — threading, chunking, markdown, cards, the claim, the ack — stays on the
left. Everything durable — the turn, the projection, the answer, the redactor — is on the right.

## Decisions to settle first

- **D1 — `getOrCreate` must be unique by name.** Today `conversationFor()` reads the binding outside
  the commit and guards the race with a per-process `pending` map. Two adapters racing on one name
  would create two conversations and leave the loser's binding dangling (last write wins on
  `byChatKey`). Recommendation: do the read *inside* the commit and keep one commit per creation;
  the storage serialises commits, so that is correct across processes. Add a test that fires N
  concurrent `getOrCreate` calls for one name and asserts one conversation.
- **D2 — "accepted" means committed, and that is when Pub/Sub is acked.** Not when the answer is
  ready. That is what lets an adapter restart mid-turn without losing or re-asking the message; the
  `requestId` makes redelivery idempotent. Today the ack happens after the *answer* is posted, which
  is why a four-hour tool hang held four messages unacked.
- **D3 — the host projects.** Frames carry `{ liveText, busy, tools, entries }` as plain data, so
  `projection.ts` moves behind the seam and no adapter imports a pi-durable `ViewLike`.
- **D4 — `await()` returns the answer text.** Otherwise every adapter re-implements entry flattening
  and the `AssistantEntry` import.
- **D5 — adapter documents live in host storage**, namespaced, with exactly one atomic primitive
  (`claim`). Alternative — an adapter-local SQLite file — is simpler to build and worse in kind: the
  claim must be atomic with respect to the same answer, and splitting the store would put the
  duplicate-post bug back on the table.
- **D6 — secrets are written through the host**, because the redaction registry is host-owned and
  must see a `/secret` write immediately (it already re-reads per call for exactly this reason).
- **D7 — titles are a host op.** Same CPU argument as above; the adapter keeps only the "should I ask
  for a title now" policy and the Chat card plumbing.
- **D8 — cancellation is `signal`, not `Context`.** Otherwise `@earendil-works/chord` stays in the
  adapters and the seam is not a seam.
- **D9 — brands stop at the boundary.** `conversationId`/`entryId` become `number`. We lose
  compile-time distinction between the two; accept it, or add local nominal types at the seam.
- **D10 — sinks are non-blocking.** A Chat PATCH that takes 300 ms must not delay a commit. Today that
  is free (in-process, sync callback); over a socket it needs a bounded per-sink queue with
  drop-oldest, safe because every frame is a whole snapshot.
- **D11 — the seam carries a projection and a derived list, not entries.** *(Revised: the original said
  the seam should carry entries and keep derivation in the adapter. Measurement killed that.)* The
  largest conversation here is 1,085 entries / 2.8 MB / ~28 ms to marshal — per attach, per client,
  and chord deflates large frames before they cross, which costs CPU on data that does not compress.
  So `snapshot()` returns `ProjectedView` (bounded by construction) and `artifacts()` returns derived
  records. Entries never cross. Markdown rendering stays in the adapter: that is presentation.

## Boundary readiness

The processes are always on one machine, so latency and bandwidth are not the costs. **Marshalling
is**, and it is per byte regardless of distance. Measured on this store: 1,085 entries = 2.8 MB =
~28 ms to stringify plus ~15 ms to parse, per attach, per client. Chord also deflates frames above
`PACK_THRESHOLD`, which costs more CPU on data that is already compressed (base64 images gain
nothing).

So the rule is: **structure crosses by value, bytes cross by reference.**

| Shape | Ops | Why |
|---|---|---|
| **Calls** — small JSON in, small JSON out | `list`, `resolve`, `getOrCreate`, `snapshot`, `artifacts`, `setModel`, `status`, `agent`, `usage`, `models`, `info`, `bind`, `label`, `unbind`, `doc.get`, `doc.set`, `doc.claim`, `abort` | Bounded by construction: a projection, a derived list, an id, a record |
| **Frames** — server-pushed state, one attachment id | `attach` | A callback cannot be serialized. Over a link this is "send to attachment N" + `detach(id)`; chord's replicated state is already this shape |
| **Inline, once per message** | `submit` content parts | A Chat attachment arrives already base64 and is one payload, not a repeated frame — so it travels as-is. The "bytes by reference" rule is about the 100 ms frame channel, and applying it here cost a working feature for a boundary that does not exist yet. A file-reference form arrives when a caller has a file |
| **Tasks** — start, then observe | `submit`+`await`, `compact`, `title` | `compact` and `title` are model calls (the local titler's timeout is 15 min). A blocking request that can take minutes loses its work when a link drops |

Two operations that look like calls and are not: `compact` and `title`. They are turns in disguise and
need a `start…() → taskId` shape before they cross anything.

## Migration steps

Each step is independently shippable and leaves `npm test` green. The `BridgeHost` methods stay in
place until the last adapter is ported; the seam is additive.

- **S0 — the seam exists.** `src/session-host/api.ts` (types only) and `src/session-host/inprocess.ts`
  (implements it over `BridgeHost`). No adapter changes. Exit: typecheck clean, no behaviour change.
- **S1 — port the read-only adapters: web and artifacts. DONE.** `list`, `snapshot`, `attach`,
  `submit`, `artifacts`. `web.ts` and `artifacts-server.ts` import neither library and never touch
  `host.harness`; `test/web.test.ts` and `test/artifacts-server.test.ts` run against a fake seam with
  no SQLite. One contract change came out of it: **the current state arrives as the first frame of
  `attach`**, which removes the snapshot-versus-early-frame ordering hazard.
- **S2 — port `queries.ts`.** Kills the 14 `host.modelRuntime` reach-throughs and the 9 `viewState`
  ones; `ModelInfo`/`ConversationStatus` become plain data.
- **S3 — port `router.ts` and the `main.ts` turn path. DONE.** `submit` / `awaitSubmission` / `abort` /
  `write`. The `AssistantEntry` commit and the text flattening moved into the host, so `main.ts`
  holds no pi-durable import, and `src/adapter/` has **zero** `host.*` reach-throughs. Submissions are
  addressed by id (`harness.submission(id)`) rather than held as handles, which is why the wait
  survives a restart and why this operation can cross a link later.
- **S4 — adapter-owned state and titles. DONE** (with the guard test: `test/seam-guard.test.ts` fails the
  build if an adapter names pi-durable or chord, reaches through `host.*`, or a new file appears in
  `src/adapter/` without being added to the list). The claim on an answer, the notifier's verdicts and
  a conversation's first turn are seam operations; `posted-doc.ts` is gone and `notify.ts`/`topic.ts`
  take the seam. One deviation, recorded rather than hidden: D5 said `doc.get/set/claim` — a generic
  namespaced store — but the claims that exist are *typed* and live in documents that predate the
  seam. A generic store would have meant migrating live claims, for a claim whose job is to survive
  exactly that. So the surface is `claimAnswer`/`releaseAnswer`/`recordVerdict`/`verdict`/
  `firstTurn`: fewer foot-guns, no migration, and the semantics are in the names.
- **S5 — the link. Spike done; the approach is chord contracts, not a hand-rolled socket.**

  The open question was whether a chord host can publish pi-durable's *foreign* callback subscription
  as replicated state. It can, and it survives a real process boundary. Both shapes were run:

  ```ts
  server.serve(ConversationView, (_input, _principal, self) => {
    const entries = self.state("entries", Type.Number(), 0);
    self.task(async (ctx) => {                    // owned by the object: aborts when the last
      const opened = await conversation.viewState(ctx);   // client releases its reference
      const push = (value) => entries.change(ctx, () => value.entries?.length ?? 0);
      push(opened.value);                         // snapshot first
      opened.subscribe(push);                     // then deltas
      await untilAborted(ctx.signal); opened.dispose();
    });
    return { variant: "default", entries };
  });
  ```

  Client: `createHost({ kind: "client", upstream: { link: ipcLink(process), principal: "server" } })`
  → `ctx.get(ConversationView, { conversation })` → `ref.entries.subscribe(...)`. A forked child
  process saw `{entries: 0}` then `0 → 1 → 2` as the conversation changed; the same script over
  `memoryLinkPair()` behaves identically.

  Three findings worth carrying into the build:

  - **Writes need a task ctx, not `BACKGROUND_CONTEXT`** — chord's cell guard reads `ctx.signal`, and
    the background context has none. The task ctx is also the right lifetime: it aborts when the
    object is released, which is exactly "one attachment per client, disposed on disconnect".
  - **State must be schema-shaped** (TypeBox), so `ProjectedView` needs a schema. `tools[].arguments`
    is `unknown` today; it has to become `JsonValue`, or the tool line loses its arguments.
  A second spike proved the other direction — adapter → host *calls* — over the same IPC link:
  `append()` returned in 29 ms, a deliberate `slow(1500)` returned in 1512 ms, and a state write made
  inside that call was observed by the client as replicated state. So `submit`/`snapshot` are ordinary
  remote methods, and a call that takes a second or two is fine.

  Three more findings, all of them build-time constraints rather than risks:

  - **Do not mix the two libraries' contexts.** Passing chord's method `ctx` into
    `conversation.submit()` fails inside pi-durable with `Cannot read properties of undefined
    (reading 'startSpan')` — pi-durable wants its own context (with its telemetry adapter), chord wants
    its own (with a span). The seam implementation must keep them apart: pi-durable calls get
    `BACKGROUND_CONTEXT`, chord state writes get the call's `ctx`.
  - **The IPC channel belongs to `ipcLink`.** Anything else on `process.send`/`process.on("message")`
    is parsed as link frames and errors out — which is how the first run of this spike failed. Adapter
    processes report on stdout, or take a second channel.
  - **`awaitSubmission` should be state, not a blocking call.** It can take minutes; chord's rule is
    that a method must not wait for a person, a sleep, or an endless loop. Model it as a cell the
    adapter observes (`{status, answerId, text}`), which is what the `settled` cell in this spike
    already demonstrates.

  **First increment landed** (`src/session-host/link.ts` + `link-contract.ts`): an in-process
  `SessionHost` is published as two chord objects (session, conversation) and a second
  `SessionHost` is implemented over a client host. `test/session-host-link.test.ts` runs `getOrCreate`,
  `list`, `resolve`, `attach` (snapshot then a real frame), `submit` (including the "no such
  conversation" value) and `artifacts` through a link — the same interface the adapters already use,
  so moving one out is a deployment change.

  Two things the increment forced:

  - **A `has(conversation)` method on the session object.** A chord object springs into existence on
    demand, so without it "the conversation is gone" and "the conversation is empty" are the same
    state, and the seam promises `undefined` for the first.
  - **Nothing else is published.** `state`, `models`, `setModel`, `create`, `bind`, `unbind`,
    `label`, `compact`, `abort`, `usage`, `awaitSubmission`, `write`, the claim/verdict operations and
    `firstTurn` throw `not implemented over the link yet`. Each becomes a contract method the day an
    adapter in another process needs it — and `awaitSubmission` is the one that will need the
    state-instead-of-call shape the second spike established.

  What remains: `start-bridge.sh` supervising a second process, and the web adapter pointed at a
  linked seam instead of the in-process one.

## Non-goals

- No multi-process requirement in S0–S4. This is in-process refactoring until S5.
- Pub/Sub stays in the gchat adapter, as corrected. The host never learns what a thread is.
- No protocol versioning before S5, and no ops "for later". 24 is already the measured surface.
- No change to Chat rendering, dedupe by `requestId`, or the one-answer-one-post claim.
- The pid lock and the single-writer rule stay exactly as they are; the host remains a singleton.

## Risks

- **Seam rot.** Someone reaches for `host.harness` again and the interface becomes decorative. The
  guard test in S4 is the mitigation, and it must run on every commit.
- **Ack-order bugs cost messages**, not replies: ack too early and a Pub/Sub message is gone. D2 is
  the one decision worth writing tests for before anything else moves.
- **Over-abstraction.** Every op here has a measured call site; that is the bar for adding another.
- **Lost type safety at the boundary** (D9) — branded ids become numbers, and `Model` becomes
  `ModelInfo`. Cheap to accept, expensive to discover late.
- **The host is still a singleton**, so a host restart still interrupts turns. Durability covers it
  (`harness.resume()`), and it is out of scope here.

## Appendix: measured coupling

`host.*` reach-throughs by file — the list the seam has to eliminate. `web.ts` and
`artifacts-server.ts` are now at zero (S1); what remains is the Chat path plus Chat-side helpers that
will move behind an adapter or stay host wiring.

```
src/adapter/queries.ts          0   ← S2
src/adapter/commands.ts         0   ← S2
src/adapter/router.ts           0   ← S3
src/adapter/web.ts              0   ← S1
src/adapter/artifacts-server.ts 0   ← S1
src/adapter/view-sink.ts        0   ← S3
src/durable/notify.ts           0   ← S4
src/durable/topic.ts            0   ← S4
posted-doc.ts                 gone  ← S4
----                       ----
adapters + Chat helpers         0

src/durable/smoke.ts            0   ← rewritten against the seam
(deleted: import-all, import-legacy, replay, prefix-probe — one-shot tools)
```

The one-shot migration tools — `import-all`, `import-legacy`, `replay`, `prefix-probe` — were deleted
once the cutover was behind us: they existed to move history and to compare engines, both of which
are finished, and each was a standing typecheck burden against APIs that keep moving. Git history
has them. `smoke.ts` survives because it answers a question that does not expire — "is this box's
stack working?" — and it is now written against the seam, so it fails to compile if the seam moves
underneath every adapter.

By symbol: `host.context` 48, `host.harness` 22, `host.bindingFor` 16, `host.modelRuntime` 14,
`host.conversationFor` 9, `host.cwdPath` 8, `host.close` 6, `host.bindings` 3, `host.dbPath` 1.

Conversation methods reached from outside `host.ts`: `viewState` 10, `submit` 7, `commit` 3,
`reset` 2, `configure` 2, `agent` 2, `compact` 1, `abort` 1 — plus `opened.subscribe` twice and
`opened.dispose` three times, which is the attach/dispose lifecycle the seam formalises.

Library imports inside `src/adapter/`: **one**, `commands.ts` reaching for `pi-coding-agent`'s
`SettingsManager` and `getAgentDir` — pi's `settings.json`, which is shared with the TUI and cron and
deliberately not the host's. No `pi-durable` and no `chord` anywhere in the adapter layer.

`artifacts-server.ts` is the newest and smallest: two reach-throughs, both `host.harness` +
`host.context`, to take one snapshot. It is also the clearest case for `snapshot()` existing — two
lines of adapter code stand in for an operation the seam should name.
