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

## 3. Reorganize `src/` by process, not by migration era (**done**)

The layout encoded history: `src/durable/` held the store-owning host *and* Chat-surface code the
adapter imports, and `src/adapter/` mixed the Chat layer with the web layer — a directory whose
meaning was "everything that isn't the host". With the SDK host gone there is no era left to encode.

```
src/chat/       commands, cards, card-input, queries, router, handler, painter   2,418 lines
src/web/        sink, routes, markdown, artifacts-server, manifest, page.html
src/commands/   command-surface
src/session-host/  the seam: api, link, link-contract, inprocess, v1-routes, poll-client,
                   view-sink, projection, supervisor, fork-adapter
src/durable/    the host: host, ledger, entries, artifacts, comments, topic, notify, activity…
```

`src/adapter/` is gone. The seam guard now scans the three surface directories instead of one — the
rule it enforces ("nothing that talks to a transport may name the store library or chord") is easier to
state after the split, not weaker.

**One deviation from the proposal:** `src/protocol/` was not created. `src/session-host/` already means
"the seam and the shapes that cross it", which is what the proposal wanted the name to say; renaming a
directory that is imported by eighty files to say the same thing is churn. The v1 routes and the poll
client moved in beside it, which is the substance of the change.

Two things this shook out: the asset loader's fallback path (`src/adapter/web/page.html`) and the seam
guard's directory — both found by tests, which is the argument for having them.

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

## 9. Multi-process testing (done, with one case declined)

**Done: the supervision wiring, with a real child.** `test/adapter-supervision.test.ts` forks the
fixture adapter through `forkAdapter`, reads the host's state *through the link*, `SIGKILL`s the child,
and asserts a second generation answers on the same port and reads the same state — plus a narrower
case showing one chord host serves two generations. It runs the code `main.ts` runs (`forkAdapter`,
`acceptAdapterLink`, the supervisor) against a real process, with a fake seam so no store or model is
involved. The fork adapter gained `execArgv` for it: production forks compiled JavaScript, a test forks
TypeScript.

**Declined, by the owner (12 Nov): the mid-turn cases.** "Kill the adapter while a turn is running and
the turn completes" and "host restart with an open web client: re-link, view replication resumes".
They are writable — the local llama.cpp router on `:8090` makes a real turn free and offline, so the
old blocker no longer applies — but the verdict was that the supervision test plus the deployment's own
behaviour cover enough. Recorded rather than left open, because an item that is never going to be done
should not look like one that is waiting.

## 10. Documentation shape (**done**)

**The architecture narrative left the README.** `docs/architecture.md` holds the four listeners, the
store, delivery, the seam and the two-local-model argument — with the reasons, because most were
learned from a failure and the failure is the part worth keeping. The README keeps what a reader needs
to *use* the thing and links out; it went 592 → 554 lines and lost two sections of duplication plus
the anchor the env table pointed at.

**The inline comments were pruned per comment, not swept.** Twelve blocks described how a thing came
to be where the current code only needs what it is:

- `/engine`'s justification ("the SDK host has no such command") — the SDK host is gone;
- the router's three bullets about what the *old* bridge maintained by hand, now two lines about what
  the store owns instead;
- `bindings-doc`'s account of which two pieces it replaced, now a description of the join and the
  atomicity that makes it a document;
- `view-sink`'s "platform behaviour that survived the migration", now "Chat's, not ours to simplify";
- `queries`' "mirrors the old `applyConversationSettings`", `web.ts`'s "the point of the whole
  migration", `chat-host`'s "the same pass the host used to run", `chat-markdown`'s "what the README
  used to promise", `config`'s "(it no longer shares their slots)" — each replaced by the fact.

**Kept, because the history *is* the constraint**: the artifact origin's account of being refused as a
frame (`refused to connect`), and the note in the rendered document that inline code used to be
excluded — which is why a rule that looks arbitrary is not.

## 12. Dead code, second and third passes (**done**)

The first pass (in §5) took the seam operations with no callers at all. The later passes took what the
migration *orphaned* — code whose only caller was itself, or died with the SDK host:

- **Seam**: `usage` joined `replyToComment`, `unbind` and `writeNotice`. Its last caller was a card
  that no longer exists.
- **Functions**: `httpSnapshot` (the one-shot view call, replaced by the observe poll), `storeUsage`,
  `sessionStatsCard`, `NullReceiver` (the `RECEIVER=none` path now means "no receiver", not a Null
  object), `legacySessionFile`/`sessionFileFor` (JSONL paths — `keyFor` and `chatTarget` are all that
  is left of `session-key.ts`).
- **Constants**: `SESSION_ABORT_TIMEOUT_MS`, `REDACTION_FAILED`.
- **Config**: `stallTimeoutMs`, `watchdogIntervalMs`, `sessionIdleMs` (the SDK host's watchdog and
  session cache), and `artifactsBaseUrl` (read by the web adapter from the environment, so the host
  carried an unused copy). Three env vars and their README rows went with them.
- **Docs**: the README's "Stuck turns" described the watchdog in the present tense, including a
  paragraph about aborting and reopening a JSONL session that nothing runs.

Method, since it is repeatable: scan every exported value for references outside its own file (281
exports; 45 with none), then check the short list by hand — most were used inside their own module and
merely over-exported, which is churn to "fix". The same scan over `Config` fields and seam operations
took the rest.

## Deletions enabled

- SDK host + `agent-sessions` + legacy commands/notify/session-file: ~2,850 lines
- In-process web engine mode in `main.ts`: ~80 lines + one env var
- Dead comment blocks and shadow-cursor narration: ~50 lines
- Duplicated HTTP wrapper across three processes: ~120 lines

## 11. Move root-directory state into `data/` (**done**)

The store, the cursor, the adapter's idempotency file and the old backups now live in `data/`:
`bridge.sqlite` (+ WAL), `bridge-ledger.json`, `state.json`, `backups/`. Nothing that matters is inside
the working tree any more — which is the point: `grep -r` no longer walks a 56 MB database, and a stray
`git clean -xdf` is a tidy-up rather than a data-loss event.

**How it was done matters more than that it was.** The bridge cannot be stopped and held stopped — the
supervisor restarts it, and the container may be recreated — so the move had to survive an interruption
at any point:

1. **copy** (originals untouched: a restart during this phase uses the old path, which still exists);
2. **switch `.env.durable` atomically** (from here a restart uses the copy, which is complete);
3. **restart the pid captured before step 1**, wait for health, report.

The first run of that script failed in the instructive way: it captured the pid *after* switching the
env, by which point the lock it looked for was the new path's and did not exist — so it reported success,
restarted nothing, and left a stale copy while the live store kept growing. Reverted within the minute
(the live store was never touched), and the fix is the rule: **every question about the running system
has to be asked before the system is reconfigured.**

Also changed with it: the restart scripts derive the lock from `BRIDGE_DB` instead of hardcoding
`$PROJECT/bridge.sqlite.lock`, because the lock is `<dbPath>.lock` and a hardcoded one reports "no bridge
owns the lock" while one is serving.

**The logs move on the next container restart.** `start-bridge.sh` writes through `$LOG_FILE`, and
bash parses PID 1's script once — so the change is in the file and inert until then. It points at
`data/` now (`BRIDGE_DATA_DIR`), moves any existing log across on the first start after the change so a
restart does not look like the log was wiped, and includes the tunnel's log. The two restart scripts
followed immediately (they are started fresh each time), and so did `CLOUDFLARE.md`'s `tail -f`.
