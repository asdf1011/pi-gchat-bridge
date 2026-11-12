# Plan: agentic search

Searching past conversations from a conversation, with results that link back to the
exact place they came from.

Status: **proposal**. The CLI is built; everything below is not.

---

## The shape, after two revisions

The first draft of this plan described **two tools** — `agentic_search` and a second,
terminating `agentic_search_deliver` that took an array of markdown results. Both were
cut, and the reasons are worth keeping:

- **The deliver tool was solving a messaging problem.** "Hand back citations as
  markdown" is what a conversation already is. A second tool that *ends the turn* was
  inventing a terminus the agent loop already has.
- **The search tool was too small to be a tool.** Everything it did — run the CLI,
  look at a hit, ask for more — is what an agent does across several turns.

So the design is now:

**Agentic search is a conversation.** A new conversation, created with a prompt that
tells the agent to search the archive and report what it found. It calls the
`transcript` CLI as many times as it needs, quoting entries and linking to them.
The results *are* the conversation, rendered by the pane that already exists.

That means no extension, no new tool schema, and no `terminate` semantics. What it
needs instead is for the CLI's output to be good enough that an agent can judge a hit
without immediately asking again, and for a link to land on the right turn.

---

## What already exists (and constrains the design)

Checked against the tree, not assumed:

- **`src/scripts/transcript.ts`** — built. `search()`, `countByConversation()`,
  `runCli()`. Hits carry `entryId`, `conversationId`, `kind`, `at`, `snippet`.
  `entryId` is the anchor data, so this is mostly a linking problem.
- **`gchat.origins`** — a session-scoped document mapping `"<conversationId>:<entryId>"`
  to `{origin, submission, at}`, where origin is `gchat`, `webui`, `cron`, … Its own
  header calls it "routing metadata for messages that are recent", and it is **capped and
  pruned**. Origin is therefore **best-effort**: available for recent entries, gone for
  old ones. This plan takes that as given — see "Origin" below.
- **`src/durable/entries.ts`** — messages already carry `origin` where known.
- **`src/web/routes.ts`** — the pane is served at `/<id>/` (`/^\/\d+\/?$/`).
- **`src/web/page.html`** — `messageRow(role, html, at, live, images)` builds each row as
  `div.msg`; it **receives no entry id**, so there is nothing to anchor to today.
- **The public hostname is `pi.hl.id.au`** (cloudflared ingress). Links must be built
  from config, not hardcoded.

---

## Two gaps in the CLI

### A hit is a fragment of the wrong text

The snippet is a window into the **flattened** text — text blocks, tool names and JSON
arguments joined together. So a search for `ofxsync` shows:

```
bash {"command":"cd /workspace/.../ledger-sync && cat > [ofxsync]/__main…
```

That is the *query that matched*, not *what the conversation said*. Measured on the real
store: that entry's total indexed text was **244 characters**, so there is very little
behind the window anyway.

Two fixes, both small:

- **`display_text`** — a second column holding prose only: text blocks from user and
  assistant entries, with no tool-call JSON and **no thinking**. `snippet()` is drawn
  from it. The searchable `text` stays as it is, so hits are still found by command
  arguments; only what is *shown* changes.
- **`role`, `origin` and `hasThinking`** on `Hit`. `kind` alone cannot distinguish what
  the model said from a tool call it made; origin is recorded for later; `hasThinking`
  lets a reader say "there is more here" without showing it.

Schema bump: one column, one rebuild of the index.

### Reading a conversation, not a window

A general "expand around a hit" was considered and dropped: measured on one real
conversation, it holds **298 tool results and 291 assistant turns against 9 user
messages**, so expanding every hit would deliver ~98% noise.

What is needed instead is the other primitive — **read more of a conversation**:

```
transcript-read <conversationId> [--from <entryId>] [--limit <n>] [--with-tools] [--with-thinking]
```

- **Default is prose only**: `pi.user` and the text of `pi.assistant`. No
  `pi.tool-result`, no thinking.
- **`--with-tools`** adds tool results — for when the answer is known to be in a
  command's output.
- **`--with-thinking`** adds thinking blocks. These are a block type *inside* assistant
  entries (1,892 of 11,327 in the sample), not a kind, so this is stripped at read time
  from the record — no index change needed for it.
- **`--from <entryId>`** starts mid-conversation, which is how an agent reads the turns
  around a hit without re-reading the thread.

This is why `display_text` (step 4) is worth its schema bump: it serves **both** the
snippet a search returns and the prose a reader prints. One column, two callers.

## Origin

**Logged, not acted on.** The index records the origin an entry came from so it is
available when display and filtering are decided later. Nothing in this plan filters by
it, and the UI is untouched.

Two things worth recording now so they are not surprises later:

- The source is `gchat.origins`, a **capped, pruned** session document whose own header
  calls it "routing metadata for messages that are recent". Old entries will therefore
  carry **no origin at all**.
- That makes any future filter *best-effort*: "known to be `gchat`", never "not known to
  be something else". Making it reliable would mean changing that document's contract
  from capped routing metadata into an append-only record, which its rationale argues
  against.

Logging it costs one unindexed column and one lookup at import time. Deciding what it
means is deferred.

---

## The CLI surface (settle before anything depends on it)

The CLI is the contract a skill, an agent prompt and the rest of this plan will all
describe in prose. Every step below quotes it, so it is fixed first — a wrong verb is a
paragraph to rewrite everywhere, not a line to change.

### Two primitives, and one is a narrowing of the other

- **Reading** takes a conversation id and returns whole entries, from the **store**. It
  needs no index; it would work on a machine that had never searched.
- **Searching** returns matches, from the **index**. It is a derived, disposable
  structure that exists only to find things.

So `read` is the base capability and `search` is built on it. That ordering — not
history — decides the shape: an index exists to *find*, and finding is a special case of
reading.

### The commands

```
transcript read --conversation <id> [--from <entryId>] [--limit <n>]
                                   [--with-tools] [--with-thinking]
transcript search <query> [--conversation <id>] [--by-conv]
                          [--kind <kind> …] [--all] [--limit <n>] [--max-stale <s>]
transcript reindex
```

- **`read` is explicit.** No bare `transcript 27202` default: a leading number is exactly
  the kind of implicit argument that reads as "the 27202nd something" to the next person.
- **`--conversation <id>` is required for `read`**, and is a named flag rather than a
  positional for the same reason. In `search` it stays optional, because searching is
  global by default and narrowing to one thread is a filter.
- **`--conv` is gone**, replaced by `--conversation` everywhere. One flag, one meaning,
  no abbreviation to explain.
- **`reindex` is a verb, not a flag**, because it is an operation rather than an option
  on a read. `--reindex` disappears.

### Why verbs rather than more flags

`--by-conv`, `--reindex` and `--with-thinking` are three different kinds of thing
wearing the same syntax: a mode, an operation, and a detail level. As verbs and
qualifiers the surface stays explainable:

- **mode of search** — `--by-conv`
- **what `read` includes** — `--with-tools`, `--with-thinking`
- **not a read at all** — `transcript reindex`

Naming the third one `transcript read --reindex` would have been a lie, and that is the
general test for what becomes a verb.

### Rename

The file becomes `src/scripts/transcript.ts` and the npm alias becomes `transcript`.
`search` survives as a verb, so `npm run transcript -- search ledger` is the shape
every document quotes from here on.

---

## The anchor problem

This is the substantive part of the work, and the part that could be skipped by
accident and produce links that look right but go nowhere.

Today a link like `/155/` opens a conversation at the bottom. To cite *"the turn where
we decided X"* the URL has to carry an entry id and the page has to honour it.

### No new route

**`/<conversationId>/#e<entryId>`.** The path stays the one the pane already serves
(`/^\/\d+\/?$/` in `src/web/routes.ts`); the entry lives in the fragment. No route is
added, nothing in `routes.ts` changes, and `webPath()`'s mount-prefix handling is
untouched — the link builder only has to know the host and the mount root.

### The page already does this

Reading the fragment at load is the established pattern in `page.html`, not a new idea:

```js
void restoreArtifact(artifactKeyFromHash());     // at load
window.addEventListener('hashchange', ...)        // and on change
```

Load → read fragment → fetch the named thing → show it. Entry anchors copy that shape.

### The fragment is occupied — and it fails *silently*

`#<encoded-key>` names an **artifact** document (`artifactKeyFromHash`, `showArtifact`,
`restoreArtifact`). `#e27239` decodes to `"e27239"`, `restoreArtifact` looks for a list
row with `data-key === "e27239"`, finds none, and then:

```js
history.replaceState({}, '', location.pathname);
```

**The fragment is erased on load.** Not a crash — worse, because the link appears to work
while quietly losing the one thing it was carrying. Fix is one guard, early in
`artifactKeyFromHash`:

```js
if (/^e\d+$/.test(raw)) return '';   // an entry anchor, not a document
```

### Paging is the real work

`loadHistory()` fetches the **newest** page and says so —

```js
rel('api/c/' + id + '/history?limit=' + HISTORY_PAGE + '&before=0')
// "No anchor: the newest page."
```

— so an entry from three weeks ago is **not in the DOM** when the page loads. Scrolling
to it cannot work; the page has to *fetch its way back* to it:

```
await loadHistory()                      // newest page
while (target not in transcript && !historyComplete)
    await loadEarlier()                  // the existing button's handler
scroll to it, highlight briefly
```

`loadEarlier()` exists, is guarded by `loadingEarlier`, and `historyComplete` is already
maintained by both the initial read and every subsequent page. So the loop is short —
but it does not exist today, and skipping it is precisely how a citation link ends up
silently landing at the bottom of the thread.

Two failure modes to handle honestly:

- **An entry that is not in this conversation.** Must say so, not scroll to the top.
- **An entry dropped by compaction.** The id may no longer be reachable. Same answer.

### Highlighting

A link that lands on a message with no visual acknowledgement reads as "the page
scrolled at random". Brief highlight, cleared on scroll or after a few seconds.

## Commit steps

Each step leaves the tree green (`npm run typecheck`, `npm test`) and has a reason to
exist on its own. Step 0 is the CLI rename, 1–3 are UI, 4–5 are CLI features, 6 is documentation.

### Step 0 — Name the CLI properly — **done**

`src/scripts/transcript.ts`, npm alias `transcript`, verbs `read` / `search` / `reindex`.
`--conv` became `--conversation`, `--reindex` became a verb, and `read` requires
`--conversation` rather than accepting a bare number.

*Landing this first meant steps 4–6 and the skill could quote one surface. Doing it later
would have meant rewriting them twice.*

### Step 1 — Entry ids reach the DOM

`messageRow` gains an entry id and writes `data-entry` on the row; every caller passes
`message.entryId`, which both history and live paths already have.

*Only plumbing; nothing renders differently. Testable as: DOM built from a fixture
contains `[data-entry="4"]`.*

### Step 2 — Anchor navigation

Read `#e<entryId>` at load and on `hashchange`: page back with `loadEarlier()` until the
entry is in the transcript (bounded by `historyComplete`), scroll it into view, highlight
it. Add the `artifactKeyFromHash` guard so an entry anchor is not erased by the artifact
restorer. Report an unreachable entry honestly.

*Visible behaviour: `/<id>/#e1234` lands on the right turn. Playwright, because the
failure mode is silent.*

### Step 3 — The link builder

`entryLink(conversationId, entryId) → string`, plus the page root from config. The URL
shape is decided (`/<id>/#e<entryId>`), so this is only host + mount + the no-entry
fallback.

*Test: a table of ids in, strings out; a hit with no entry id yields the plain
conversation link rather than `/undefined/#eundefined`.*

### Step 4 — Hits an agent can judge

Add `display_text` (prose only — text blocks, no tool-call JSON, no thinking) and draw
`snippet()` from it; add `role` and `origin` to `Hit`. Origin comes from the
`gchat.origins` document at import time and is `undefined` when it was pruned.

Index schema bump, so existing indexes rebuild on open.

*Test: a hit for a term that appears only in a tool call's arguments still matches, but
its snippet shows prose rather than the command. An entry with no recorded origin reads
as `undefined`, not as a guess.*

### Step 5 — `read`

Add the `read` verb: whole entries for a conversation, prose by default,
`--with-tools` / `--with-thinking` to widen, `--from <entryId>` to start mid-thread.
Reads the store directly — no index, no lock, nothing to catch up.

*Test: default output omits tool results and thinking; `--with-thinking` includes them;
`--from` starts at the named entry; `read` without `--conversation` exits 2 with the
usage rather than guessing.*

### Step 6 — The skill

`skills/transcript-search/SKILL.md` gains the CLI contract and the expectations for an
agent using it: search first and read narrowly, quote entries rather than paraphrasing,
link every claim to `/N/#eN`, and only widen with `--with-tools` when the answer is
known to be in a command's output.

*Docs only. Note the open question below about whether the bridge's sessions see skills
at all — if they do not, the same text belongs in `AGENTS.md`.*

---

## Deliberately out of scope

- **A UI search box.** This is an agent feature; the pane's job is to render the answer.
- **Reliable origin, and any display of it.** Logged only; see "Origin".
- **General context expansion around a hit.** Replaced by reading a conversation.
- **Search across conversations from the Chat surface.** Different surface, different
  ergonomics.
- **Ranking and relevance tuning.** bm25 plus `--by-conv` is what there is; nothing here
  needs it to change.

---

## Open questions

1. **Does the bridge's sessions see skills at all?** Earlier finding: `pi-durable`'s host
   does not run `DefaultResourceLoader`, and there is no `skills` reference in `src/`.
   If so, a skill reaches the TUI and not Chat, and the expectations in step 6 must also
   live in `AGENTS.md`.
2. **What does the conversation look like when it quotes an entry** — fenced block with
   the entry id, or a short quote plus a link? Affects how it reads in Chat, which has no
   tables and truncates wide output.
3. **Should `read` take several conversations** (`--conversation 1 --conversation 2`), or
   is one at a time right? One is simpler; several is what "show me what these two threads
   said about X" would want.
