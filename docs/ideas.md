# Ideas

Things worth doing that are not yet a plan. Each one states the problem it solves, the
mechanism, and what it costs — because the cost is usually the reason it is still here.

Status: **proposal**. Nothing below is implemented.

---

## 1. Work trees, so two instances do not clobber each other

### The problem

One checkout serves every agent that touches it. `PI_CWD` is `/workspace`, and the
bridge's own tree is `/workspace/pi-chat-bridge`; one conversation builds it, another edits
it, a third runs `npm run deploy` in it, and they all write to the same files. jj makes
this worse rather than better at the git layer: **there is one working copy per repo**, so
two agents editing the same repo are two writers on one `@`. The last snapshot wins, and
`jj undo` in one conversation reverses the other's work.

Today the collisions are invisible — they look like "my edit disappeared" or "the build
picked up a change I did not make", which is expensive to diagnose and cannot be reproduced
after the fact.

### The mechanism

A **work tree per instance** (a per-conversation or per-agent checkout), created off the
same repository so history is still shared and nothing has to be merged by hand.

- **git** — `git worktree add <dir> <branch>`. Cheap, but it is a second checkout and jj
  would then be operating on a plain git worktree with no `.jj` of its own, so `jj st` in
  that directory is a different repo's problem, not this one's. That defeats the point of
  using jj here.
- **jj** — the equivalent, and prefer it since local VCS is jj:
  - `jj workspace add <dir>` — a second working copy against the **same repo store**. Same
    `jj log`, same change ids, same op log, but `@` is independent. This is the one to
    build on.
  - `jj workspace list` / `jj workspace forget <name>` — enumerate, and retire one when
    the instance is done. `forget` drops the working copy without touching its commits.
  - `--revision` picks the parent the new workspace starts from, so an instance can be
    handed a specific change instead of whatever `@` happens to be.

### Where the bridge has to change for this to be true

A work tree on its own does not stop two instances from colliding. Everything that is
"the one instance's state" has to move with it, and each of these is already an env var —
which is the good news: the change is wiring, not architecture.

- **Ports.** `PORT`, `BRIDGE_WEB_PORT`, `BRIDGE_CHAT_PORT`, `BRIDGE_ARTIFACTS_PORT` are all
  fixed (`8081`/`8083`/`8084`/`8082`). A second instance cannot bind, or worse, takes the
  first one's port after it restarts. A per-instance base port (`PORT_BASE + 10n`) is the
  smallest change that works.
- **The store is claimed by pid file, not by tree.** `bridge.sqlite.lock` is a pid file, so
  two instances *do* refuse to share a database — but only after they have pointed at it.
  The lock has to live beside the instance's own store (`BRIDGE_DB` per work tree), not
  beside the work tree, or `jj workspace add` copies loose state and forks the truth.
- **The delivery cursor.** `bridge-ledger.json` is per-bridge, and a second instance reading
  the same Pub/Sub subscription means each message is delivered to whichever instance pulls
  it — the same failure the `start-bridge.sh` comment warns about between `sdk` and
  `durable`. A second instance needs its **own subscription** (or no Chat at all: a web-only
  instance is the boring, safe case).
- **Untracked, ignored runtime state.** `node_modules/`, `dist/`, `data/`, `*.log`, the
  `bridge-ledger.json`, the pid file. A new workspace starts with **none** of it. `.jj` is
  shared per repo, but ignored files are per working copy, so every workspace pays a fresh
  `npm ci` — which is exactly the problem idea 2 is about.
- **The agents' own config.** `~/.pi/agent` is symlinked into `/workspace/pi-agent` (see
  `pi-agent/README.md`). Two instances sharing one agent config will fight over
  `settings.json` — model switches and version bumps are runtime writes. Either the config
  dir is per workspace too, or the "authoritative here, symlinked there" arrangement grows a
  per-instance layer.
- **The deploy path.** `npm run deploy` builds in its own tree and then restarts whatever is
  listening — it cannot tell whose instance that is. Either deploys name a target
  (`--instance web-2`) or only the instance that owns the port may deploy.
- **`jj workspace add` is not free of foot guns.** Snapshots are per workspace, but
  `jj op log` is shared, so `jj undo` in workspace A can move `@` in workspace B. Documentation
  for agents has to say: `undo` is a repo-wide operation, `restore` is a workspace-local one.
  That is a rule for `AGENTS.md`, not a code change.

### What it buys, and what it costs

- **Buys:** two agents working in the same repo without touching each other's files; a long
  build in one tree while another is edited; a clean "what did *this* instance change"
  (`jj diff` in that workspace is only that workspace's work).
- **Costs:** per-workspace `npm ci` (idea 2 is the answer), per-workspace ports and state
  files, and a lifecycle nobody owns yet — who runs `jj workspace forget`? A workspace that
  is never forgotten still holds its commits as normal changes, so the leak is disk, not
  history.
- **Do not share a store between workspaces just because it is technically possible.** One
  instance writing `bridge.sqlite` while another reads it is the clobbering we are trying to
  remove, one layer down.

---

## 2. Bazel, so builds across work trees are fast

### The problem

Idea 1 makes a work tree cheap to *create* and expensive to *use*: `node_modules` is 233 MB
and `npm ci` is minutes; `dist/` rebuilds from scratch; e2e and eval runs pull Playwright
browsers and fixture state. Ten work trees today means ten copies of all of that and ten
builds, most of whose inputs are identical.

The cache we actually want is **shared and content-addressed**: work tree B should reuse
work tree A's compile output when the inputs match, without either knowing the other exists.

### The mechanism

Bazel with a remote/disk cache pointed at one directory outside every work tree.

- **A shared cache directory** (`--disk_cache=/var/cache/bazel` — or `--remote_cache` if it
  ever needs to leave the machine). An action's key is its inputs, so a second workspace
  rebuilding the same TypeScript gets the outputs as a cache hit rather than a rebuild.
  That is the whole reason to consider Bazel here; everything else is arithmetic.
- **A shared output base**, or at least a shared repository cache
  (`--repository_cache`), so a clean checkout does not re-download dependencies.
- **Hermetic `tsc`.** `npm run build` is one `tsc` invocation over `src/`. Bazel wants that
  per-target with declared inputs and outputs; the win is real (incremental type-checking
  scoped to what changed) but it means authoring `BUILD` files, which is a genuine
  maintenance cost for a repo this size.
- **Tests.** `node --test` per file as a Bazel test target gives per-test caching and
  parallelism; `scripts/changed-tests.mjs` already does the "only run what changed" part by
  name, which is what Bazel would do by content.
- **`node_modules` still exists.** Bazel does not solve npm's install graph unless
  dependencies are also modelled as rules (`rules_js` / `aspect_rules_js`). Adding that is
  the point where this stops being an afternoon.

### What it buys, and what it costs

- **Buys:** a warm build in a fresh work tree is seconds, not minutes; build outputs are
  reproducible across trees and across machines if the cache is shared; a cache hit is
  evidence the inputs did not change.
- **Costs:** `BUILD` files that must be kept in step with the source layout; a new tool to
  install (`bazelisk`, pinned via `.bazelversion`); and a second build system beside
  `package.json` unless npm is retired as the build entry point — which `npm run deploy`
  and the Dockerfile both assume today.
- **The honest comparison first.** Stage 1 is the cheap version of this idea: `npm ci` from
  a shared cache, `tsc --build` with project references into a shared `outDir`, and
  `--cache-dir` shared between work trees. Measure how much of the pain that removes. If a
  warm work tree is already under a minute, Bazel is buying very little for a lot of `BUILD`.
- **The one case where it pays immediately:** e2e and evals. Playwright runs and eval suites
  are the expensive, rarely-changed part, and caching them by input is exactly Bazel's
  strength.

---

## Ordering

Both ideas are worth doing only if agents actually run side by side here. So:

1. Ports and per-instance state (the `config.ts` env vars already exist) — this is what
   makes a second instance possible at all, and it is worth doing whether or not work trees
   follow.
2. `jj workspace add` as the per-instance tree, plus the `AGENTS.md` line about `undo`
   being repo-wide.
3. Measure `npm ci` + `tsc` in a fresh workspace. Only then decide on Bazel, and start with
   the shared cache and the evals before touching `src/`.
