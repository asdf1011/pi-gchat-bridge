# Architecture cleanup: conversation server, web bridge, gchat bridge

From the review of 2026-11: the architecture is sound (one store-owning durable
host, adapters over chord links, a disciplined seam, a minimal `/v1` protocol,
a single-writer painter). What remains is the removal of the scaffolding the
SDK→durable migration left behind, plus a few structural consolidations.

To be done as a series of CLs, in roughly this order. Each CL should build,
typecheck, and pass `npm test` on its own.

## 1. Retire the SDK host and its private code (pending)

Delete the legacy engine and everything only it imports:

- `src/index.ts`, `src/commands.ts`, `src/notify.ts`, `src/session-file.ts`,
  `src/topic-summary.ts`, and most of `src/agent-sessions.ts` — kept only for
  `npm run start:sdk`, which exists for rollback the cutover no longer needs.
- Move `AgentRouter.keyFor(...)` (the one static the durable side uses) into
  `session-key.ts`, then delete the rest of `agent-sessions.ts` (~1,123 lines).
- Drop `start:sdk`, the `dev` script's watch of `src/index.ts`, the
  `sessions/`, `sessions.pre-1.4.0/`, `state.json`/`bridge-ledger.json` legacy
  paths, and the restart scripts that still reason about the old process model.
- Rollback story, if still wanted, is a git tag, not a second engine in every
  build.

~2,500 lines.

## 2. Pick one web engine and delete the other (pending)

`BRIDGE_WEB_ENGINE=link|inprocess` duplicates the fork/supervise/link/forward
machinery and makes `main.ts` serve `/web` inline. The Chat adapter already
went through this transition: prove the seam with a toggle, then delete the
toggle. Make `link` unconditional, delete the in-process `/web` serving, and
remove the env var from README and `.env.example`. Halves the configuration
matrix.

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

## 4. Break up `durable/main.ts` into a route table (pending)

`main()` is a single ~500-line function with an inline HTTP server (`/v1`,
`/healthz`, `/idle`, `/status`, the `/notify` tombstone, conditional `/web`)
plus fork supervision, artifact repo setup, and shutdown logic. Extract a
`hostRoutes.ts` with the shape `web-routes.ts`/`v1-routes.ts` already model,
and a `forkAdapter.ts` owning the supervisor + stdout-marker + link-accept
boilerplate duplicated verbatim for the Chat and web children.

## 5. Audit the `SessionHost` seam for single-consumer methods (pending)

The interface has grown to 40+ operations (conversations, transcripts, images,
projections, artifacts, comments, secrets, models, quotas, settings, failures)
despite its "small by construction" rule, and `notImplemented` stubs in
`link.ts` suggest declared-ahead-of-need. Split into capability objects —
`ConversationReads`, `ConversationWrites`, `ArtifactSurface`,
`CommentSurface`, `AdminSurface` — composing into `SessionHost`. The chord
objects can stay; this is about the type each adapter receives.

## 6. Delete migration residue (pending)

One sweep:

- The "delivery cursor in shadow mode" comment block in `main.ts` with no code
  following it, and the orphaned `feedViewFrames` doc comment.
- Comments referencing `BRIDGE_CHAT_ENGINE=link` as a selectable mode.
- `§17`-style design-doc references that point at nothing in the repo.
- Root-directory state: `bridge.sqlite*`, `state.json`, `bridge-ledger.json`,
  the `.log` files, `sessions*/`, `backups/` → a `data/` dir (one env default
  change) and tighter `.gitignore`.

## 7. Consolidate the command layers (pending)

After (1) the SDK-era `src/commands.ts` dies, but the remaining
`adapter/commands.ts` (839 lines), `adapter/command-surface.ts`, `card-input.ts`
and `cards.ts` (785 lines) still make commands the deepest stack in the repo.
Split `adapter/commands.ts` by command family (settings vs. conversation
management vs. secrets) and move Chat card rendering into `src/chat/` (after
(3)) so commands return plain results and each surface renders its own.

## 8. One HTTP request wrapper, three servers (pending)

`main.ts`, `chat-host.ts`, and `web-host.ts` each hand-roll the same skeleton:
URL parse, `identify()`/trusted-proxy warning, try/catch with a JSON 500 and a
headers-sent guard. Extract `serveRoutes(routes, { auth, onError })` in
`src/shared/`. ~60 lines per process, and future CORS/auth fixes land once.

## 9. Multi-process testing (pending)

Unit coverage is excellent (60 test files, seam guard, idempotency,
submit-over-link), but the fork + `ipcLink` + chord-accept wiring in `main.ts`
is only exercised in production. Add an e2e case that runs the real children
and exercises: chat adapter restart mid-turn (turn survives), host restart with
an open web client (re-link, view replication resumes), and a generation-2
child getting a fresh link after a crash. One Playwright case that kills the
web adapter mid-turn and asserts the turn completes would pay for itself the
first time a deploy regresses it.

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
