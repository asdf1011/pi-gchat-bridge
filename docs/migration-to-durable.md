# Migrating pi-gchat-bridge to Pi Durable

Status: plan, not started. Branch: `durable`. Target: `@earendil-works/pi-durable` 1.4.0.

## Why

Today the bridge *is* a hand-rolled harness. This migration replaces that plumbing with the
official one, and in doing so makes the bridge a **frontend adapter** instead of a session owner.
The concrete wins:

- **Exactly-once submissions.** Chat message name → `requestId`. Deletes `state.json` dedupe.
- **Crash safety.** Per-task checkpoints + `harness.resume()`. Deletes the stall watchdog's
  file-truncation hack and the "busy forever" class of bug.
- **Conversations as first-class objects.** Fork, compaction, per-conversation agent, usage —
  instead of a JSONL file per thread plus `resumeMap`.
- **Multi-surface.** `viewState()` is designed for many clients on one conversation. Web and
  voice become additional sinks, and "same conversation in Chat and the browser" is native.
- **~1,600 lines deleted** (see [Keep / kill](#keep--kill)).

## Before / after

```
TODAY                                  AFTER
Pub/Sub ─► ChatRouter ─► AgentSession   Pub/Sub ─► ChatAdapter ─┐
              │  (per thread)                    │  submit()   │
              │  watchdog, steers,              │  viewState()│
              │  idle eviction, session files   ▼             │
              ▼                              Harness (pi-durable, SQLite)
           ~/.pi/agent sessions/                 │
                                                 ├─ conversation per Chat thread
                                                 ├─ per-task checkpoints, resume()
                                                 ├─ compaction as a task
                                                 └─ extensions: CodingTools + ours
```

What stays: Pub/Sub, Chat API, cards, markdown conversion, notifications, topic titles.
What goes: session lifecycle, dedupe, watchdog, steer queue, session-file reading/writing.

## Locked decisions

1. **Storage: SQLite** via `openNodeSqliteStorage(BRIDGE_DB)`. Not JSONL — it keeps the whole
   history in memory, and gchat threads are long-lived.
2. **Models stay on `ModelRuntime`.** `ModelRuntime implements Models`, so the existing
   `~/.pi/agent/models.json`, `auth.json`, custom providers (llama-local, deepseek) and virtual
   models are passed straight in: `Harness.open(storage, { models: modelRuntime, ... })`.
   Verified pattern: pi-pocket does exactly this (`app.ts:747/899`). **No model-config rewrite.**
3. **pi-coding-agent is upgraded 0.99.2 → 1.4.0 first.** pi-durable pins `pi-ai@1.4.0` exactly;
   leaving coding-agent at 0.99.2 gives two pi-ai copies and a cross-version `Models`. pi-pocket
   pins the whole set at 1.4.0. This upgrade is therefore a prerequisite, done and verified
   separately while the legacy bridge still works.
4. **pi-coding-agent is kept as a dependency only for**: `ModelRuntime`, settings, ids/agent dir,
   and (later) skills. It no longer creates sessions.
5. **Thread → conversation index is a session-scoped document.** `defineDoc({ scope: "session" })`
   (doc families exist too). Same pattern as pi-pocket's `SessionsDoc`. Replaces `resumeMap` and
   `state.json`, and is atomic with the commits that create conversations.
6. **The Chat sink reads `viewState()`**, not agent events. `watchEvents()` exists but is
   experimental and ships more bytes; the view is the documented UI surface. Verified: partials
   arrive as distinct frames (~28 over a 3-sentence answer at the default 100 ms cadence), so the
   edit-in-place typing effect is preserved without tuning.
7. **`viewState()` shape, confirmed:** `value.entries`, and `value.docs` =
   `pi.agent`, `pi.live`, `pi.inbox`, `pi.provider`, `pi.usage`. Streamed text is
   `docs["pi.live"].generation.message` (an AssistantMessage) — **not** `.partial`. Busy is
   `docs["pi.live"].run`. Tool status is `docs["pi.live"].tools[].status`
   (`pending`/`running`/`done`) with `.arguments`.
8. **Tool output lives in the entry's `model`, not its `data`.** A `pi.tool-result` entry has
   `data: { diagnostics: [] }` and the actual output in
   `entry.model[0].content[].text`. `/status`, cards and any tool rendering must read `.model`.
9. **`agent.model` is a `ModelRef`** — `{ provider, modelId }`. Existing code that reads a
   model's `.id` must use `.modelId`.
7. **One process owns the storage.** Already true (one Pub/Sub puller). Add a startup lock so a
   second instance fails fast instead of corrupting.

## Steps

### M0 — Spike — **DONE** (see [M0 results](#m0-results))

Prove the stack on *this* machine before touching the bridge. All exit criteria passed.

- Add `@earendil-works/pi-durable@1.4.0` + `@earendil-works/chord` to a scratch script.
- `Harness.open(MemoryStorage, { models: await ModelRuntime.create(), registry })`.
- Submit a prompt on `deepseek-flash`; confirm streaming via `viewState()`.
- Confirm `CodingTools` + `NodeExecutionEnv({ cwd })` run `bash`/`read` in `PI_CWD`.
- Confirm an **image block** in `content` reaches a vision model
  (`UserInput = UserMessage["content"]`, so it should).
- Confirm one of the local llama.cpp models works through `ModelRuntime`.

**Exit:** one script prints a streamed answer with a tool call, from a real configured model.

### M1 — Upgrade pi-coding-agent to 1.4.0 — **DONE** (see [M1 results](#m1-results))

- Bump to `1.4.0` in `package.json`; `npm ls @earendil-works/pi-ai` must show **one** copy.
- Re-verify the bridge's uses of it: `createAgentSession`, `bindExtensions`, `SessionManager`,
  `ModelRuntime`, `sessionStats`, custom entries. Fix fallout.
- Run `npm test`, then a live Chat smoke test (`/status`, `/model`, a tool call, a steer).

**Exit:** legacy bridge behaves identically on 1.4.0. This is independently shippable.

### M2 — Durable host skeleton — **DONE** (host + bindings; see [M2 results](#m2-results))

New `src/durable/`:

- `host.ts` — `Harness.open(storage, { models, registry, settings, env, onReport })`,
  `harness.resume()`, `harness.closed` → supervisor restart.
- `registry.ts` — `CodingTools` + `chat-format` + `tool-policy` ports + `thinking-budget`.
- `index-doc.ts` — session-scoped doc: Chat thread key → `{ conversationId, model, thinking }`.
- `settings` mapping from `config.ts` + `settings.json`: `stream.timeoutMs`, `retry.maxRetries`,
  `compaction.reserveTokens`, `progress` (defaults 100 ms partials), `toolExecution: "parallel"`.

Bundle size note: the package root loads TypeBox (~23 MB peak RSS unbundled).

**Exit:** a `tsx src/durable/smoke.ts "hello"` prints a streamed answer on SQLite, survives a
`kill -9` mid-run, and answers the same submission after restart.

### M3 — Chat adapter (the sink)

Rewrite `stream.ts`'s input, keep its Chat-API behaviour.

- `src/adapter/sink.ts` — `conversation.viewState()` → `subscribe((view) => project(view))`.
- `project(view)` returns `{ text, finalText, thinking, toolsInFlight, busy }` from
  `view.entries`, `docs["pi.live"]` (partial generation, tool calls + output),
  `docs["pi.inbox"]`, `docs["pi.usage"]`.
- Keep unchanged: `chat-markdown.ts` conversion, `splitMessage` chunking, code-fence closing,
  the `markers` relocation dance, `BRIDGE_REPLACE_ON_FINISH` notification trade-off, the
  4,000-char cap handling.
- Throttle PATCHes independently of commit cadence (commits land every ~100 ms).

**Exit:** a plain Chat Q&A and a tool-using turn look identical to today.

### M4 — Routing, dedupe, steering — **DONE** (see [M4 results](#m4-results))

- `src/adapter/router.ts` — replaces `AgentRouter`. `handleMessage(incoming)`:
  - key = `keyFor(space, thread, threadKey)` (unchanged function), looked up in the index doc;
    create the conversation on miss (`harness.createConversation` + `configure`).
  - `submit({ type: "input", content, requestId: <Chat message resource name>, whenBusy })`.
  - `requestId` is the Chat message name that `state.ts` already derives — the dedupe is now the
    platform's, so `state.ts` shrinks to nothing.
- Steering: `whenBusy: "steer"` replaces `pendingSteers` + `toolsInFlight` bookkeeping.
  `interrupt()` → `conversation.abort()`.
- Busy detection: `isBusy()` reads the view's run state instead of tracking it.
- Notifications: `notify.ts`'s `appendNotificationTurns`/`seedNotificationSession` hacks become a
  single `submit({ type: "write", entry: { kind: "app.notice", data } })` — writes are appended at
  once, even mid-run, and never reach the model. **Most of these two modules disappear.**

**Exit:** duplicate Pub/Sub redelivery produces one answer; a mid-run steer lands after the
current tool round; restart mid-run resumes and answers.

### M5 — Commands and cards

`commands.ts` re-targeted (cards largely unchanged, they're already view models):

- `/model`, `/settings`, `/status` → `conversation.configure()`, `conversation.agent()`,
  `docs["pi.usage"]`. Thinking-level list logic (`thinkingLevelsForModel`) stays as-is.
- `/new`, `/fork`, `/compact`, `/abort` — newly possible, cheap to expose.
- `/name` → Chat-side title only (durable conversations have no name field).
- `/resume`, `/sessions` → list conversations via
  `harness.commit(tx => tx.scanConversations(...))` + the index doc; adopt = rewrite the binding.
- `/list` — same.

**Exit:** every command in the current README works, plus the four new ones.

### M6 — Watchdog, supervisor, parked tasks

- Tool/model timeouts: `settings.stream.timeoutMs`, plus a host-side tool watchdog armed from the
  view (same idea as today's `BRIDGE_STALL_TIMEOUT_MS`, and as pi-pocket's tool watchdog).
- `harness.closed` → exit non-zero, let systemd restart. Reopen + `resume()`.
- Parked tasks (`restartLimit`, default 5) → surface as a Chat notice, offer `harness.retryTask(id)`
  via a `/retry` command.

**Exit:** a hung tool no longer wedges a thread forever, and a crash loop parks instead of looping.

### M7 — Cutover

1. **Replay corpus first.** Extract real user messages + expected replies from `sessions/*.jsonl`,
   feed them through the durable stack offline against real models, eyeball the projections. This
   is the only pre-cutover validation that uses real traffic without double-pulling Pub/Sub.
2. Cutover window: stop legacy unit → start `durable` unit → send three test messages (Q&A, tool
   call, steer).
3. **Rollback:** durable writes only `bridge.sqlite`; legacy `state.json` and `sessions/` are not
   modified. Rollback = stop new unit, start old. Caveat: replies sent during the durable window
   aren't in `state.json`, so Pub/Sub may redeliver and the old bridge may answer them again —
   bounded to the cutover window, acceptable, and removable by writing processed IDs to
   `state.json` during the canary.
4. Canary 24 h, then delete the legacy path in a follow-up commit (keep the branch).

**Exit:** a full working day on the durable bridge with no manual intervention.

### M8 — New surfaces (separate milestone, the actual payoff)

- **Web:** HTTP + SSE over `viewState()` — pi-pocket's `server/http/events.ts` is the shape
  (`text/event-stream`, snapshot then deltas). Auth by token, one static page.
- **Voice:** same sink + TTS; a `speak` tool as a durable extension.
- Chat and web attach to the *same* conversation: that's the feature that motivated all of this.

## Keep / kill

Keep (unchanged or lightly touched):

- `chat-client.ts` (359) — Chat API, attachments, PATCH
- `cards.ts` (498) — model/settings/thinking cards
- `chat-markdown.ts` (182) — table→bullets, headings, hard breaks
- `topic-summary.ts` (254) — local llama titler over OpenAI-compatible HTTP
- `pubsub-receiver.ts` (363), `auth.ts` (160), `access.ts` (15), `config.ts` (99), `logger.ts` (27)
- `notify.ts` (352) — shrinks to the `/notify` endpoint; session-seeding half goes

Rewrite: `stream.ts` (338 → sink over view), `commands.ts` (454), `index.ts` (298), `types.ts` (87).

Delete: `agent-sessions.ts` (1,123), `session-file.ts` (367), `session-key.ts` (38, keeps
`keyFor`), `state.ts` (124), most of `notify.ts`, `constants.ts` (40) mostly.

Net: ~1,600 removed, ~500–700 added.

## Risk register

- **Experimental API.** "Changes without notice between releases." Pin `1.4.0` exactly, no `^`,
  read CHANGELOG before any bump, keep the version in one place.
- **pi-coding-agent 0.99.2 → 1.4.0** is a major bump on custom integration points
  (`bindExtensions`, custom entries, session-file writes). Mitigated by doing it first, alone,
  against the unchanged legacy bridge.
- **Two pi-ai copies** silently break `models: ModelRuntime`. Guard with an `npm ls` check in CI.
- **History does not migrate.** Durable's schema (entries/tasks/documents) is not coding-agent
  JSONL. See open question 1.
- **Behaviour drift** from background compaction, restart resumption, and parked tasks — all
  improvements, all visible to users; document them in the README changelog.
- **Chat-API constraints unchanged** (4,000-char cap, no tables, notification-on-create, no bot
  attachments). The markdown/card layer carries over untouched.
- **One storage owner.** A second instance must not start. Add a lock file.
- **Blast radius of `onReport`.** Storage errors end the harness by design; the supervisor must
  restart, not retry in-process.

## Testing

- Keep: `chat-markdown`, `topic-summary`, `session-key`, `access` tests (pure logic, unaffected).
- New, against `MemoryStorage` + the faux provider: submit → view projection; steer placement;
  `requestId` idempotency across reopen; `resume()` after simulated crash; abort; compaction;
  index-doc binding; parked task handling.
- New: a projection golden test — the same view fed to `project()` twice renders identical Chat
  text, so chunking/markers stay deterministic.

## Open questions

1. **Existing history — decided.** Nice-to-have, not a blocker, and only if it needs nothing
   persistently hacky. It doesn't: the import is a **one-shot offline script** (`tools/import-legacy.ts`)
   that reads `sessions/*.jsonl` and writes `pi.user` / `pi.assistant` entries through the public
   `init`/`submit` API **once**, then is never run again. What would be hacky and is explicitly
   ruled out: a live dual-read path, keeping `session-file.ts` around, or teaching the runtime to
   read coding-agent JSONL. Lossy by design (no thinking, no tool calls, no branch structure);
   `pi.system` entries from the old transcript are dropped. Runs at M7, after cutover, per thread.
2. **Is the web UI in scope for this project**, or is M8 a separate repo/app? Doing it in-process
   is far cheaper, but it changes the deployment story (port, auth, one more thing to secure).
3. **Do we keep `/resume` across the two worlds** — i.e. can a terminal `pi` session be adopted
   into Chat afterwards? Durable conversations and coding-agent sessions don't share storage, so
   this would need the importer from (1b).

## M0 results

Run on this machine, 2026-11-01, `@earendil-works/pi-durable@1.4.0` +
`@earendil-works/pi-coding-agent@1.4.0` + `pi-ai@1.4.0` (single copy, verified with `npm ls`).
Scratch scripts: `/tmp/pd/spike*.ts`.

| Check | Result |
|---|---|
| `ModelRuntime.create()` passed as `models` | **works** — deepseek, zai and the local llama.cpp provider all resolve |
| `Harness.open` on `MemoryStorage` / SQLite | works |
| Local model through `ModelRuntime` | `llama-local/lfm3-vl-2b-q8` answered |
| `CodingTools` + `NodeExecutionEnv` | `bash` ran (`date +%Y` → `2026`), output in `entry.model[0].content[].text` |
| Tool status in the view | `pi.live.tools[]` went `pending` → `running` → `done` |
| Live streaming for the Chat placeholder | 28 distinct partial frames over a 3-sentence answer at the default 100 ms cadence |
| `requestId` dedupe, same process | same submission id, duplicate never ran |
| `requestId` dedupe, **across restart** | same submission id — replaces `state.json` outright |
| Image block → vision model | local VL model answered "Red" for a 64×64 PNG |
| Usage / cost readback | `docs["pi.usage"]` has per-model tokens and cost |
| `agent.model` | `{ provider, modelId }` (a `ModelRef`) |

Cost of the whole spike: three short `deepseek-flash` calls plus local inference (free).

Corrections to expectations, now reflected above:

- `pi.live.generation.partial` does not exist; the streamed response is
  `pi.live.generation.message`.
- Tool output is not in `entry.data`.
- `agent.model.id` is `undefined`; use `modelId`.

Two things M0 did **not** cover, deferred to their milestones: a tool call driven by a *local*
model (2B is unreliable at tool use; the deepseek run proves the tool path), and the
`chat-format` / `tool-policy` port to durable extensions (M2).

Conclusion: no blockers. The model-config risk that dominated the plan is gone, and the dedupe,
streaming, tool and image paths are all confirmed against real models.

## Keeping Chat available throughout

Chat is the primary interface, so the migration must not depend on having another one. It doesn't —
but one constraint dominates everything below.

### The bridge is migrating itself

The agent doing this work runs **inside the process being migrated**:

```
PI_SESSION_FILE=/workspace/pi-gchat-bridge/sessions/spaces_sPA7FKAAAAE_threads_BFpkfrGTCJA-84899d68.jsonl
start-bridge.sh -> node dist/index.js (restart loop, 5 s backoff, no systemd)
```

Consequences:

- A restart **kills the in-flight turn**. Nothing is lost: the session JSONL persists, and on restart
  the watchdog truncates an incomplete tail so a half-finished tool call is not re-run. Recovery is
  "send `continue`".
- **The agent must never trigger the restart itself.** The operator restarts between turns.
- `dist/index.js` is the running artifact, so source edits and `npm run build` do not affect the live
  process. Development needs **zero restarts**; only pickups do.

Protocol for every milestone that changes running code:

1. Agent finishes a unit of work, runs `npm test`, and says "ready to pick up".
2. Operator restarts when idle (kill the node process; the loop restarts it in 5 s).
3. Operator sends `continue`; work resumes on the new build.

### Interruption budget

- **M0** — none. Done in `/tmp/pd`, touched nothing.
- **M1** (upgrade) — one restart. See the session-format hazard below.
- **M2–M6** — none. Build and run the durable variant from a **separate checkout** with its own
  `BRIDGE_SESSIONS_DIR` / state file. The live bridge is untouched.
- **M7** (cutover) — one restart, or none at all with the space split below.

### Session-format hazard (the real risk to continuity) — **downgraded by M1**

`pi` can migrate session files automatically on first load, and historically one-way (v1→v2, v2→v3).
M1 checked this directly: a 0.99.2 session file opened under 1.4.0 keeps all 818 entries **and is left
byte-identical** (md5 match before/after). So there is no rewrite on open. A file only changes when new
entries are appended, i.e. per thread, while it is used on 1.4.0 — so a rollback after the canary
affects only the threads touched since, which the backup covers.

Still worth the cheap insurance before M1: `cp -a sessions sessions.pre-1.4.0` (86 MB, seconds).
Done on this machine.

### Zero-downtime path for M7: split by space

Two bridges cannot pull the same subscription, but they *can* pull two different **subscriptions on
the same topic**. Each gets its own copy of every event, and `ALLOWED_SPACES` keeps them from both
answering:

- legacy bridge: `ALLOWED_SPACES=<real spaces>` (unchanged)
- durable bridge: `ALLOWED_SPACES=<one scratch space>`, own `BRIDGE_SESSIONS_DIR`, own SQLite file

Cutover becomes gradual: move one space at a time by editing the two allow-lists, restarting each.
Rollback is the reverse edit. No message is ever dropped or answered twice.

### Avoid mid-turn package installs

`npm i` while a turn is in flight can defeat a lazily-imported provider SDK. Bundle dependency
installs and build into a single idle window, immediately before the restart.

## M1 results

Upgraded in place, `@earendil-works/pi-coding-agent` `0.99.2` → `1.4.0` (exact pin), one
`pi-ai@1.4.0` in the tree. Checked against this repo's real integration points, not the changelog.

| Check | Result |
|---|---|
| `tsc --noEmit` | clean, no code changes needed |
| `npm test` | 88/88 pass |
| Open a 0.99.2 session file | 818 entries, kinds `model_change`/`thinking_level_change`/`message` |
| Is it rewritten on open? | **no** — md5 identical before and after, same byte size |
| `bindExtensions` with the real `~/.pi/agent` extensions | succeeds, no `extension_error` |
| A real turn | streams via `message_update.assistantMessageEvent.delta` (unchanged shape) |
| `appendCustomEntry` + read-back | works (what `notify.ts` needs) |
| Session file written and reopened | works; `getSessionFile()`, `getSessionId()` unchanged |

The upgrade needed **zero source changes**. The one surprise was in the smoke test, not the SDK: the
delta lives at `event.assistantMessageEvent.delta`, which is what `stream.ts` already read — a
reminder to test the real consumer path rather than a convenient one.

Rollback: `git revert` the dependency commit and `npm install`; sessions are untouched by the
upgrade itself (see the hazard note above).

## M2 results

`src/durable/{host,settings,bindings-doc,smoke}.ts` — the harness host and the thread → conversation
join. Development happens **in place on the `durable` branch**, not in a separate checkout: the
running bridge executes `dist/index.js`, so editing `src/` does not touch it, and the only dependency
change is additive (`pi-durable`, `chord`). No restart is needed for M2.

Verified with `npx tsx src/durable/smoke.ts`, twice against one database:

| Check | Result |
|---|---|
| First run creates a conversation | conversation 2, bound to the Chat key, answer "Nile" |
| Second run (new process, same db) | same conversation 2, **no** creation |
| Same prompt twice | same submission id — `requestId` dedupe holds across processes |
| Bindings document round-trips | `{conversationId, model, createdAt}` |

API notes worth carrying forward:

- Doc value types must be **type aliases, not interfaces** — `JsonObject` accepts an implicit index
  signature and interfaces never get one.
- `ConversationId` is a branded number; store it as `number` in JSON and cast at the call site.
- `Settings` requires the full shape, not a partial: `compaction`, `steeringMode`, `followUpMode`,
  `afterFailedRun`, `restartLimit` all need explicit choices. `settings.ts` documents each.
- `conversation.viewState(context)` and `conversation.commit(change, context)` both take a Chord
  context that cannot be omitted; the host exposes its own as `host.context`.
- `conversationFor()` is race-safe for concurrent messages on one thread (an in-flight map), because
  Pub/Sub can deliver two messages for a thread in quick succession.

## M3 results

`src/adapter/{projection,view-sink}.ts` + `ReplyStream.onSnapshot()`. The sink is a translation layer,
not a rewrite: every Chat-API behaviour in `stream.ts` (placeholder delay, in-place PATCH, 4,000-char
chunking, code-fence repair, the notification trade-off in `finish()`) is reused unchanged.

| Check | Result |
|---|---|
| Projection unit tests (hand-written view values) | 7 tests |
| Sink unit tests (fake stream + fake view) | 6 tests, incl. attach-mid-run and detach |
| End-to-end on a real tool turn (deepseek-flash) | status line `bash: date +%Y`, cleared once, final text matches the committed entry |
| Full suite | 101/101 |

Two design decisions the tests forced out:

- **The sink never paints empty text.** `finish()` owns the final state and deletes the placeholder for
  an empty or aborted reply. Painting `""` as the run ends would flash a blank message first.
- **The sink dedupes the tool status itself** rather than leaning on `ReplyStream`'s no-op detection,
  so progress commits for one long-running tool cannot spam PATCHes.

Tool arguments are the one field pi-durable does not put on `pi.live.tools` (it has `callId`, `name`,
`status`, `output`), so they are joined from the newest tool-calling assistant entry. That join is the
fragile part of this milestone and is why the projection is a pure function with its own tests.

## M4 results

`src/adapter/router.ts` — Chat message → durable submission, plus notification writes and interrupt.

| Check | Result |
|---|---|
| Router unit tests (structural fake host) | 9 tests: requestId, content blocks, steer flag, write shape, interrupt |
| Redelivery on a live model | same submission id, no second run |
| Message sent 400 ms into a run | joined the run (`whenBusy: "steer"`); both submissions settled, 2 user + 2 assistant entries |
| Notifications | `{type: "write", entry: {kind: "app.notice", model: [...]}}` — no run |
| Full suite | 110/110 |

Design notes:

- `whenBusy: "steer"` is **unconditional**. pi-durable ignores it when the conversation is idle, so
  there is no "is it busy?" check — and therefore no check-then-submit race, which the old
  `isBusy()`/`steerWaitMs` pair had to manage.
- A notification is a `write`, not an `input`: model content makes it visible to a later reply, and no
  run starts. This deletes `appendNotificationTurns`, `seedNotificationSession` and the custom-entry
  verdict bookkeeping in `notify.ts` — the remaining job there is posting to Chat.
- Commands interrupt (`conversation.abort()`) while plain messages steer, matching `commands.ts`.
- Images are content blocks; a bare string is kept when there are none, so the transcript stays
  readable.

Still outstanding from M4's original scope: the `/notify` *validation* path (run a hidden
conversation, post only on a YES verdict). It maps to a `conversation` that is created but never bound
to a Chat thread; the verdict itself can be a `cron_notify` write. Deferred to the wiring step rather
than guessed at here.

## M5 results (part 2: the command layer) — M5 complete

`src/adapter/queries.ts` — the facts the command cards are fed by, on top of pi-durable. The command
*dispatch* (which card to post for which command) is still to be written; the data behind it is done.

| Check | Result |
|---|---|
| Unit tests (real Harness on MemoryStorage, no model calls) | 9 tests |
| Thinking-level clamping, live | deepseek-flash supports `off`/`high`/`max`, so `minimal` clamps to `off`; llama-local supports `off`/`high`, so `high` survives |
| `switchModel` consistency | agent and binding written in one commit; `/status` and the binding agree afterwards |
| Full suite | 119/119 |

Decisions:

- **Defaults stay in `settings.json`.** `/settings` is shared with the TUI and cron, and pi-durable has
  no notion of a host-wide default model, so moving it would split the two worlds for no gain.
- **Session adoption is not a runtime query.** `/resume` of a pi session file becomes the one-shot M7
  importer instead; durable conversations are listed from the bindings document.
- **Clamping is pi's rule, not ours.** Asking for a level a model lacks clamps down to the nearest
  supported level (and to `off` for a non-reasoning model), so the card never shows a level that
  cannot take effect.

### M5 part 2: the command layer

`src/adapter/commands.ts` (+ `src/card-input.ts` extracted, so the SDK-host and durable paths share
one set of card form readers while both exist).

| Check | Result |
|---|---|
| Dispatch smoke, all commands against a real host with a fake Chat client | `/status`, `/sessions`, `/help`, `/model`, `/session`, `/abort`, `/new`, `/compact` all produce sensible output |
| Unit tests | 124 total; 5 new for pick semantics, rename and rebind |

Commands: `/model`, `/settings`, `/status`, `/session`, `/name`, `/help`, `/sessions|/resume|/list`,
plus **new** `/new` and `/compact`.

Three things worth flagging for review:

- **Read-only commands must never create a conversation.** The first draft of `/compact` created one
  as a side effect on an unbound thread. `/status`, `/abort`, `/compact` and `/name` now check the
  binding first and say so instead.
- **`/name` and `/resume` survive.** The name is an optional field on the binding document (no version
  bump for an optional field), and the picker's value is the conversation id, so `/resume` *rebinds*
  rather than importing a session file.
- **`/status` reports different numbers, deliberately.** Durable keeps per-model token and cost totals
  (`pi.usage`), not a per-session context counter, so the card shows entries + tokens + cost where it
  used to show context occupancy. If occupancy matters, it needs deriving from the last assistant
  message's usage — a small follow-up, not a blocker.

`/model`'s "which thread does this pick belong to?" logic is the one piece carried over with reduced
confidence: the old code had three cases (existing session, card posted in its own new thread, no
thread at all). The durable version keeps the `chatKey`/`actionKey` distinction but is worth a
deliberate test against real Chat before the cutover.
