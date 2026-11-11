# Architecture cleanup: conversation server, web bridge, gchat bridge

From the review of 2026-11: the architecture is sound (one store-owning durable
host, adapters over chord links, a disciplined seam, a minimal `/v1` protocol,
a single-writer painter). What remains is the removal of the scaffolding the
SDK→durable migration left behind, plus a few structural consolidations.

To be done as a series of CLs, in roughly this order. Each CL should build,
typecheck, and pass `npm test` on its own.

## 1. Retire the SDK host and its private code (**done**)

Deleted: `src/index.ts`, `src/commands.ts`, `src/notify.ts`, `src/session-file.ts`,
`src/topic-summary.ts`, `src/agent-sessions.ts` — **2,846 lines**, and three test files with them
(`agent-sessions`, `session-file`, `commands`). `start:sdk` is gone, `dev` watches the durable
entrypoint, and `BRIDGE_ENGINE` is out of the README and `.env.example`.

It took three commits, because "delete it" was not the first step:

1. **The title prompt moved out** (`durable/topic-prompt.ts`). `topic-summary.ts` held two things:
   a prompt contract and a normaliser that every surface needs, and a session-file reader only the
   SDK host needs. The durable side imported six symbols from the first half.
2. **The shared shapes moved out** (`src/settings.ts`, `src/types.ts`). `ConversationSettingsResult`,
   `DefaultSettings`, `DefaultSettingsResult`, `SessionInfo`, `SessionUsage`, `SessionContext`,
   `clampToSupported` and `supportedThinkingLevels` — the *adapter* was importing a 1,123-line class
   module to name these. `PiImage` went to `types.ts` for the same reason.
3. **The helpers the durable notify path used** (`chunkText`, `postText`, `unauthorized`,
   `parseVerdict`) moved into `durable/notify.ts`, their only caller.

Two follow-ons worth knowing: `cards.ts` now takes `ModelInfo` from the seam (one definition, not
two identical ones), and `chat-handler`/`main` take `keyFor` from `session-key` rather than through
`AgentRouter`. Test count went 730 → 696: the deleted tests tested deleted code.

## 2. Pick one web engine and delete the other (**done**)

`BRIDGE_WEB_ENGINE=link|inprocess` duplicated the fork/supervise/link machinery and made `main.ts`
serve `/web` inline. The Chat adapter had already been through the same transition — prove the seam
with a toggle, then delete the toggle — and this was the deletion:

- the in-process `/web` route table left `main.ts` (27 lines), so the host no longer serves a
  surface it does not own;
- the fork became unconditional, and `BRIDGE_WEB_PORT` became required rather than conditional;
- the env var is gone from `src/`, `README.md` and `.env.example`, and the comments that explained
  it now explain the arrangement instead.

One configuration axis fewer, and the host has no browser-facing route left.

## 3. Reorganize `src/` by process, not by migration era (pending)

The layout encodes history, not architecture: `src/durable/` mixes the
store-owning host with Chat-surface code the Chat adapter imports, and
`src/adapter/` mixes web-bridge code with Chat code. Move to:

```
src/host/        # store owner: host, ledger, entries, artifacts, vcs, topic
src/protocol/    # session-host api, link, link-contract, v1-routes, projection
src/chat/        # chat-host, pubsub-receiver, chat-handler, chat-painter, cards
src/web/         # web-host, web-routes, page, artifacts-server
src/shared/      # config, logger, stream, chat-client, secret-store, markdown
```

Mechanical (`git mv` + import rewrite), but it lets "src/chat imports src/host
directly" become a lint error instead of a convention.

## 4. Break up `durable/main.ts` into a route table (**done**)

**Done: the fork boilerplate.** `src/session-host/fork-adapter.ts` owns it: supervise, parse the one
readiness marker, forward the rest of stdout unchanged, accept the link per generation. It went into
`session-host/` rather than `adapter/` because the seam guard is right — adapters may not name chord,
and this file does.

**Done: the route table.** `durable/host-routes.ts` is the four questions a deployment asks of the
process that owns the store — `/v1`, `/healthz` and `/status` (alive, and are the *models* working),
`GET /idle` for the restart gate — plus the `/notify` tombstone. `main()` keeps only the listener and
the bind warning.

It is the first time those routes have been out of a 500-line function, which is also the first time
they could be tested without a bridge. The one test that reads source text for the `/notify` route
followed it to the new file.

The extraction was worth doing twice: the first attempt was scripted and produced code that treated
`return;` inside a nested loop as "handled"; the second was by hand and took ten minutes.

## 5. Audit the `SessionHost` seam for single-consumer methods (**partly done**)

Audited all 37 operations for callers. Three had **none**, and they are gone from the interface, the
in-process implementation, the link contract and the link client — 99 lines:

- `replyToComment` — the agent's "reply into a thread" operation. The *tool* it was written for calls
  `addComment` instead; the operation never had a caller after the comment-tools rewrite.
- `unbind` — no adapter unbinds a name. The host keeps its own `unbind` for the store, which is where
  it was always used.
- `writeNotice` — a failure notice written *as an answer*. Nothing calls it: the Chat handler words
  the notice itself and posts it through the painter, which is the only mouth.

The rest are used, most of them once (which is fine — an adapter calls it once).

**The split is not planned.** The item proposed capability objects (`ConversationReads`,
`CommentSurface`, …). With the dead operations gone, the interface is 34 operations that each have a
caller, and splitting it would reorganise working code to solve a problem that deleting solved.
Prefer deletion over decomposition: an operation with no caller is a liability, an operation with one
caller is the interface.

## 6. Delete migration residue (**done**)

- The "delivery cursor in shadow mode" comment block in `main.ts`, and the orphaned
  `feedViewFrames` doc comment left behind when that function moved.
- Comments referencing `BRIDGE_CHAT_ENGINE=link`/`=process` as a selectable mode — the mode is
  gone, so the comments described a choice that no longer exists. One of them had also been
  mangled by the edit that removed the code, mid-sentence.
- `§17`-style design-doc references: eight of them, in `v1-routes`, `config`, `painter`,
  `steer-watch`, `activity` and `main`. The reasoning is worth keeping; the section number is
  not, because the document it names is not in this repo. Each now states the idea instead
  ("delivery is the reader's state", "one liveness mechanism at a time").

The root-directory state move (`bridge.sqlite*`, `state.json`, `bridge-ledger.json`, the logs →
`data/`) is **not** residue and not safe to do here: it means moving a 54 MB live store, so it
became its own item (#11) with a deploy step. Everything it lists is already in `.gitignore`.

## 7. Consolidate the command layers (pending)

After (1) the SDK-era `src/commands.ts` dies, but the remaining
`adapter/commands.ts` (839 lines), `adapter/command-surface.ts`, `card-input.ts`
and `cards.ts` (785 lines) still make commands the deepest stack in the repo.
Split `adapter/commands.ts` by command family (settings vs. conversation
management vs. secrets) and move Chat card rendering into `src/chat/` (after
(3)) so commands return plain results and each surface renders its own.

## 8. One HTTP request wrapper, three servers (**done**)

`src/shared/serve-routes.ts` is the skeleton all three servers were writing by hand: parse the URL,
resolve identity, warn when an identity header arrived from an untrusted peer, try the route table,
and turn a throw into a JSON 500 — with the headers-sent guard, because a half-written response has no
status left to change.

The host's own server was converted in the same pass as §4's route table (the two are the same
extraction), and both adapters now supply only what is theirs: a route table and the proxy address.

`main.ts`, `chat-host.ts`, and `web-host.ts` each hand-roll the same skeleton:
URL parse, `identify()`/trusted-proxy warning, try/catch with a JSON 500 and a
headers-sent guard. Extract `serveRoutes(routes, { auth, onError })` in
`src/shared/`. ~60 lines per process, and future CORS/auth fixes land once.

## 9. Multi-process testing (partly done)

**Done: the supervision wiring, with a real child.** `test/adapter-supervision.test.ts` forks the
fixture adapter through `forkAdapter`, reads the host's state *through the link*, `SIGKILL`s the child,
and asserts a second generation answers on the same port and reads the same state — plus a narrower
case showing one chord host serves two generations. It runs the code `main.ts` runs (`forkAdapter`,
`acceptAdapterLink`, the supervisor) against a real process, with a fake seam so no store or model is
involved. The fork adapter gained `execArgv` for it: production forks compiled JavaScript, a test forks
TypeScript.

**Still open: the mid-turn cases.** "Kill the adapter while a turn is running and the turn completes"
needs a turn, which needs a model — so it belongs in an e2e that can run one, not here. Same for "host
restart with an open web client: re-link, view replication resumes". Both are worth writing; neither
can be faked cheaply, and a fake would prove the wrong thing.

## 10. Documentation shape (pending)

Move the architecture narrative out of the ~35k README ("four listeners, one of
which writes", session model, painter) into `docs/architecture.md`, keeping the
README to setup + behavior. Prune the inline comments that narrate design
history rather than current code — especially alongside (1)–(3), after which
they would be actively misleading.

## Deletions enabled

- SDK host + `agent-sessions` + legacy commands/notify/session-file: ~2,500 lines
- In-process web engine mode in `main.ts`: ~80 lines + one env var
- Dead comment blocks and shadow-cursor narration: ~50 lines
- Duplicated HTTP wrapper across three processes: ~120 lines

## 11. Move root-directory state into `data/` (pending, needs a deploy)

`bridge.sqlite`, `bridge-ledger.json` and `state.json` sit at the repository root, next to the
source. They are ignored by git, but they are also *inside* the working tree, which is why a
`grep -r` over the repo can hit a 54 MB database and why a stray `git clean -xdf` is a data-loss
event rather than a tidy-up.

The move is one default plus one environment change (`BRIDGE_DB`, `BRIDGE_LEDGER_PATH`,
`BRIDGE_STATE_FILE`, and `start-bridge.sh` if it names any of them), but it is a **live store**:
the file has to move during a bridge restart with nothing running, or the host opens an empty
database and every conversation looks gone. Do it in the deployment, not in a routine CL.
