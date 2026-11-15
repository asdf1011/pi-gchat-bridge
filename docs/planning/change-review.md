# Change review — a `/review/<change id>/` surface

Status: `pending`. Plan only; no code written.

Companion to `jj-review-comments.md` (the anchor model). That note decides *what a
comment on a change is*; this one decides *where a person looks at one*.

The feature: a URL that shows the current diff of one jj change, laid out for the
screen it is on, with review comments anchored into both sides of it.

```
/review/<change id>/          the change's diff against its parent
/review/<change id>/#L20      a line, linked from a Chat comment
```

## What exists to build on

- `revisionDiff(dir, from, to)` already returns `{files, renames}` of parsed `Hunk`s
  from `jj diff --git --context 0`. `Hunk` carries `oldStart`/`oldCount`/`newStart`/
  `newCount`/`removed[]`/`added[]`, which is everything a unified or split view needs.
- `annotate()`, `showFile()`, `revisionLog()` are read-only and `--ignore-working-copy`.
- The artifact origin (`src/web/artifacts-server.ts`) is a separate GET-only listener
  bound to loopback, already carrying: nonce-CSP scripted documents, the comment
  painting script, the selection → `postMessage` protocol, and `redact` on the way out.
- `currentAddress`/`parseAnchor` for `#L20`-`#L24` addresses; `classifyComments` for
  state.

So this is mostly a new *renderer* plus one route, not a new subsystem.

## Route and where it lives

**On the artifact origin, not the chat origin.** It is a GET-only, untrusted-content
document, and it must not be able to submit a message. The chat UI frames it, exactly
as it frames an artifact, and the existing `indexPage`/`sourceView` sharing applies.

Path shape, matching the existing `/c/<id>/<key>` style:

```
/review/<change id>[/...]
```

`<change id>` is a jj change id, resolved **server-side**, because it is a mutable
name: a change id can point at a different commit after an amend. That is the point —
the URL is "this change, whatever it currently says", which is what a review of a
change means.

Also accept the spelling the bridge already uses inside a repo:

- `/review/<change id>` — the change's diff vs its parent (`<change id>-)…<change id>`)
- `/review/<change id>?from=<revset>` — explicit base, for a stacked review
- `/review/@` — the working copy, for reviewing someone else's in-progress edit

Reject anything that is not a resolvable, non-empty change id with a plain 404 and a
one-line explanation; never a stack trace and never a guess.

**Where the repo comes from.** `?repo=` is *not* accepted — a review URL must not be a
filesystem browser. The repo is resolved from a configured review root list
(`BRIDGE_REVIEW_ROOTS`, colon-separated, defaulting to none) matched against the
change id by asking each root in turn. A deployment with no review roots answers 404
with "review is not configured".

## Data the route needs

One new read on the seam, so the adapter stays a renderer:

```ts
reviewChange(repo: string, changeId: string): Promise<ReviewChange | undefined>

interface ReviewChange {
  changeId: string;
  commitId: string;          // the git export, for display and links
  description: string;
  author?: string;
  at: number;
  base: string;              // parent change id
  files: ReviewFile[];
  comments: CommentView[];   // already classified, by the existing path
}

interface ReviewFile {
  path: string;
  renamedFrom?: string;      // from parseRevisionDiff's renames map
  binary?: boolean;          // no hunks, no annotation
  hunks: Hunk[];
  // Per-file annotation at head, so a line knows its change id without a second call
  annotated?: AnnotatedLine[];
}
```

`hunks` is `revisionDiff` verbatim. `annotated` is the load-bearing addition: it lets
the renderer stamp each `+` line with the change id a comment on it would anchor to,
without the browser guessing.

**Deleted lines need the base annotation**, not the head one. `jj file annotate -r
<base>` gives the change id for a `-` line, so the route annotates the base once per
file too (only for files with `removed[]` non-empty, which is most of the cost
avoided). Both annotate calls are already cached per (revision, file) in
`reanchorAll`; this reuses the same shape.

Cost: one `jj diff`, one `jj show` for metadata, and up to two annotates per changed
file. A twenty-file change is ~40 jj invocations; acceptable but worth measuring, and
the natural follow-up is a single `jj diff --git -T` template that returns annotation
inline.

## Desktop: two-column split

Wide viewports get the conventional side-by-side:

```
 ┌ old (base) ─────────────┐ ┌ new (head) ─────────────┐
 │ 41  const a = 1         │ │ 41  const a = 1         │
 │ 42 -const b = 2         │ │ 42 +const b = 3         │
 │ 43  return a           │ │ 43  return a            │
 └─────────────────────────┘ └─────────────────────────┘
```

- Aligned by hunk: within a hunk, `removed`/`added` are padded so rows correspond;
  unchanged context lines appear on both sides at the same row.
- Old-side lines carry the base change id, new-side the head change id. Comment
  markers are painted per side, independently — the same *text* removed and re-added
  is two commentable lines, and the anchor model already keeps them apart.
- Line numbers are `oldStart`-relative and `newStart`-relative respectively; they are
  *diff* line numbers, which is what `#L20` addresses in a diff view. See "Addresses"
  below, because this is where the existing format needs a decision.

Breakpoint: `min-width: 60rem` (or a container query on the frame width, which is
better since the frame is not the viewport). Below it, one column.

## Mobile: single pane, inline, deleted hidden by default

The usual unified style: context and additions in flow, removals inline.

- **Added lines**: green background, `+` gutter, always shown.
- **Removed lines**: red background, `-` gutter — **collapsed by default**. A single
  inline row stands in their place, showing a count:

```
  41  const a = 1
 +42  const b = 3          ← green
 −2   removed lines        ← a marker row, tap to expand
  43  return a
```

Expanding shows the removed lines in place, in red, with the `-` gutter. Collapsing
again returns the marker row. State is per hunk, held in the DOM (`<details>` is the
obvious primitive: no script needed, and it is keyboard- and screen-reader-correct by
default). A "Show all removals" control at the top sets every hunk open.

Why hide by default: on a phone a rewritten region is mostly deletions, and the
mobile review question is "what does it say now" rather than "what did it say".
Removals are still one tap away and still individually commentable when expanded.

**Why not a tooltip.** The existing artifact comment UI uses a popover *anchored to a
selection*, which is a different interaction: it appears after a deliberate drag and
disappears on tap-away. A tooltip on hover is unusable on touch — there is no hover —
and a tooltip containing multi-line red code is not a tooltip, it is a panel. So the
removal marker row uses the same *visual* affordance as the comment marker (small,
inline, neutral) but is a `<details>` disclosure, not a hover target. If the comment
popover is ever reused here it should be for the *comment thread*, not for revealing
deleted code.

## Addresses: the one real gap

`foo.md#L20` is unambiguous in a single-revision document. In a diff it is not — line
20 exists on both sides, meaning different text. Three options, and the plan is to
pick one now:

1. **Side-suffixed**: `#L20` = new side (the common case), `#L20o` = old side.
   Cheap, backwards-compatible with every existing address, but `o` is a new syntax in
   a format deliberately copied from GitHub.
2. **Diff-position**: number every rendered row in the unified view and address that.
   Simple to render, but the numbers change when the view changes shape (collapse,
   breakpoint), so a link is not stable across devices.
3. **Two anchors, no new syntax**: a comment on a removed line carries the *base* change
   id, so `parseAnchor` plus the comment's `range` disambiguates. Addresses stay
   `#L20` and the *comment* says which side. Links from Chat then need the range in the
   URL (`/review/<id>?from=<base>`), which they have anyway.

Recommendation: **3**, falling back to **1** for links that must point at a side
without a comment beside them. It costs no new grammar, and the anchor model already
carries the information. This is the item to settle before the renderer is written,
because it decides what `currentAddress()` emits for a diff comment.

## Comment integration

The pieces from `jj-review-comments.md` are what this view consumes:

- A marker on a `+` line anchors to `(head change id, originalLine in head, content,
  head's git commit id)`.
- A marker on a `-` line anchors to `(base change id, originalLine in base, content,
  base's git commit id)`.
- Both ids are stored on every anchor, and **neither is optional**. The change id is the
  identity and resolves across amends; the git commit id is the **offset authority** —
  the exact tree the stored line number is a number into. Matching uses the change id
  triple; the commit id is what measures the shift when it no longer matches.
- A repository that cannot export a git commit id cannot have review comments. That is a
  refusal, not a degraded mode: every jj change reports one, colocated or not, so there
  is no legitimate case for an anchor without one (see `jj-review-comments.md`).
- `commitId` is shown in the file header ("at git 3ad1829") as secondary information,
  never as the primary identity and never in the match predicate.
- State: `visible` when the anchor resolves at its own revision; the diff-mapped
  successor when the change was amended; `orphaned` only when the line genuinely went
  away in both.
- The composer, thread and resolve button stay in the chat UI, as they do for
  artifacts — the framed document can only `postMessage` a selection. This is already
  the design and needs no change.

## Anchoring requires a snapshot

A git commit id is only a stable anchor if it was written from a snapshot. Reading the
working copy with `--ignore-working-copy` is right for *display* and wrong for
*anchoring*: it reports `@`'s previous commit id while the file on disk already says
something else, so the recorded offsets match neither.

Measured (`jj 0.47.1`) on a colocated repo:

- Edit a file, then `jj log -r @` with `--ignore-working-copy` → still `4759f90`, the
  pre-edit export.
- `jj st` snapshots → `@` becomes `bdff394`, and that commit is really in the git
  object store (`git cat-file -t` → `commit`) with the new tree.
- Amend the change afterwards and `bdff394` is still readable (`git show bdff394:f.txt`)
  because jj keeps every export alive under `refs/jj/keep/<sha>`.

So the review path is **write-on-snapshot, never write-to-history**:

- Before anchoring, run `jj st` (which snapshots) and read `@`'s commit id. Once per
  review session, not per comment — the id cannot change while the working copy is
  untouched, and a changed id is precisely the signal that a draft's offsets need
  re-deriving before send.
- No `describe`, no `new`, no `commit`. Snapshotting exports the working copy into a
  commit jj already tracks; it does not create a revision. Those three remain
  scratch-repo-only, called from `commitTurn`.
- A commit id is then an immutable handle, so an anchor can never point at content
  that gets collected out from under it — `refs/jj/keep/` guarantees it.

The cost is one snapshot on the first read of a session. The benefit is that every
stored offset is valid against a named tree rather than against "whatever the file
said at 14:02".

## Draft comments, sent as one batch

A review is a sitting, not a message: you read ten files, write notes as they occur to
you, and send once. So a comment has a **draft** state that the current model does not
have, and this is the largest change in the plan.

### What has to split

Today `addComment` is the send. `POST /api/c/<id>/comment` does both halves in one
handler (`src/web/routes.ts:902-940`): it stores the comment, then immediately submits
`modelText(...)` with `requestId: comment:<id>`, then records the submission id. There
is no state in which a comment exists but no turn has started.

Three separable operations replace it:

- `addDraftComment` — anchor and store, no submission. Returns the stored comment.
- `updateDraftComment` / `deleteDraftComment` — edit or discard before sending. This is
  the reason drafts must be stored rather than held in the browser: a reload, a second
  device, or a closed tab must not lose a morning's review.
- `sendReview` — one call, one turn: takes every draft for a review and emits a single
  submission.

### The anchor is fixed at draft time, not at send time

Drafts still go through `annotate` when written, because that is the only moment the
viewer and the source are known to agree (the existing comment on a *rendered*
document has the same property). But between drafting and sending, the change may be
amended — someone pushes a fix while the review is open. So at send time, each draft's
anchor is **re-resolved and re-anchored** against the current revision first, and a
draft whose lines no longer exist is reported rather than silently dropped or silently
sent against text that has moved. That is exactly the `reanchor`/`mapRange` path, run
one step earlier than usual, and the preview before sending is where a moved note is
shown to the reviewer.

Both ids earn their place here, and this section is where the distinction stops being
academic:

- The **change id** is what makes a draft written twenty minutes ago still land on the
  right logical line after an amend.
- The **git commit id** is what makes the stored `originalLine` a *number into a known
  tree*. Without it, the offset is only valid against "the file at the moment I
  clicked", and any modification between drafting and sending invalidates it silently.
  With it, the shift is computable: diff the anchor's commit against the current one,
  and `mapRange` gives the new offset — or says plainly that the line is gone.

So a draft is re-anchored at send time using the pair, not the change id alone: the
change id chooses which revision to look at, the commit id says exactly which tree the
old offset was measured in.

### What the batch looks like to the model and to Chat

One submission, many notes. So the message is not `modelText` per comment but a review
document: a header naming the change and the range, then each note as its own section
with its address, its quoted line fenced as a blockquote, and its id tag for
`comment_reply`:

```
A review of abc123 de0f456 (12 notes)

## conversation/…/foo.ts#L20-L24 [comment a123dcee]
> const x = 1

This loses the null check.

## …/bar.ts#L7C12-L7C19o [comment b456dcee]
> return null;

Why not throw?
```

Rules that must not be lost in the batching:

- **Each comment keeps its own id.** `comment_reply(commentId, text)` addresses a single
  note, so the ids must survive into the batched message or the agent cannot reply to
  one of twelve.
- **Quotes stay fenced and sanitised.** Ten untrusted file quotes concatenated is a
  larger injection surface than one, not a smaller one — `quoteBlock`'s rules apply per
  note, and one note's quote must not be able to open a heading that reads as part of
  the next.
- **`requestId` is per review, not per comment.** `review:<reviewId>` keeps the
  double-submit guard that `comment:<id>` gives today; a per-comment id would allow the
  same review to be sent twice.
- **One submission id recorded against all the drafts**, so `awaitSubmission` recovers
  the answer for the whole review and the drawer can attach it to the batch.

### Chat gets one message, not twelve

This settles the volume question above, and by construction rather than by config: a
batch is one turn, so the painter posts one message. The **summary** should carry the
shape ("reviewed `abc123`, 12 notes, 3 on `foo.ts`") with a link to the review URL,
not twelve quoted addresses — twelve address lines would be the flood the single
message was meant to avoid.

Individual replies remain replies: `comment_reply` writes a `replies[]` entry, which
never reaches Chat as a submission. So a review is one thread message plus the agent's
answers wherever it chooses to reply.

### Store shape

Minimal addition to `StoredComment`:

```ts
draft?: boolean;               // set until sent; absent on sent comments
reviewId?: string;             // groups the drafts of one sitting
submissions?: number[];        // becomes exactly one entry once sent
```

`draft: true` comments are **excluded from `classifyComments` output to the model** but
must still classify for the drawer — a draft whose line has moved needs to show as
moved before it is sent. And the `MAX_COMMENTS_PER_CONVERSATION` trimmer must never
drop a draft, for the same reason it never drops an open comment: losing a review
sitting is worse than a long list.

### Interaction with resolve

The existing rule — only a human resolves, the agent has no tool for it — is
unchanged. A draft is *not* resolved and *not* orphaned; it is simply unsent.

## Rendering rules

## Rendering rules

Borrowed unchanged from `artifacts-server.ts`, because artifact content is untrusted:

- `text/html` only with the sandboxing CSP; `script-src` by per-response nonce.
- Every byte of file content escaped into the document as text. Diff syntax colouring
  is done with CSS on escaped text, never by emitting markup.
- `default-src 'none'`, `connect-src` absent, `img-src data:` — a rendered diff cannot
  fetch anything.
- `redact` applied on the way out, per request. A diff of a real repo is the most
  likely place for a secret to surface, so this is not optional here.
- GET/HEAD only. **Resolve is a mutation**, so it cannot live on this origin: it stays
  on the chat API, as it does now.

## Not in this plan

- Commenting on a *stack* (`from..to` spanning several changes) — a range renders, but
  each anchor still resolves to one change, so it works; the UI for choosing a range
  does not exist.
- Inline suggestions / apply-the-patch. The anchor model has no "replacement text"
  field and adding one is a separate design.
- A revision picker or history of the change (`revisionLog` can list it; no UI here).
- Git-hosted interop (push a review to a forge). `commitId` makes it possible later,
  which is why it is stored.
- Word-level intradiff highlighting. Line-level first; `mapRange` is line-granular and
  char offsets only exist within one line.

## Landing order

1. `parseAnchor` side handling + `currentAddress` for diffs — decides addresses.
2. Snapshot-before-anchor: `jj st` once per session, read `@`'s commit id, thread it
   through `annotate` and into every anchor. Tests assert the id is a real git commit
   and survives an amend.
3. `reviewChange()` on the seam, with tests over a fixture repo: rename, binary file,
   empty hunk, change amended between two reads.
4. Static renderer, both layouts, no comments — one HTML document, container queries.
5. Comment markers on both sides, reusing `COMMENT_SCRIPT`'s marker/superscript pieces.
6. Selection → `postMessage` → composer in the chat UI (already written for artifacts),
   writing a **draft**: `addDraftComment`, edit and delete, no submission.
7. The draft tray: every draft in the review, grouped by file, with a pre-send preview
   that shows any note whose line moved while it sat in the tray.
8. `sendReview`: re-resolve every draft, build the batched message, one submission,
   one `requestId`, one submission id recorded against the batch.
9. Collapsed-removals default and the show-all control.

## Tests worth writing

- A one-line change renders one `-` and one `+`, and on mobile the `-` is inside a
  closed `<details>`.
- A `-` line's marker anchors to the base change id; a `+` line's to head.
- Amending the change keeps both comments visible after a reload.
- An anchor's `commitId` is a real git commit (`git cat-file -t` → `commit`), not a
  jj-only id from an unsnapshotted working copy.
- Rewriting a draft's line between snapshot and send re-derives `originalLine` from the
  old commit id rather than carrying the stale offset forward.
- A rename renders as one file with a `renamedFrom`, and comments follow the new path.
- A binary file renders as a summary row with no hunks and no markers.
- A change id that does not exist, or a repo outside the configured roots, is a 404
  with no filesystem path in the response body.
- A draft survives a reload: stored, anchored, and not submitted.
- Editing and deleting a draft never submits and never creates a turn.
- Amending the change between drafting and sending re-anchors the draft, and a note
  whose line was rewritten shows as moved in the pre-send preview.
- Sending 12 drafts produces exactly one submission and one `requestId`.
- Sending the same review twice is refused by the idempotency key, not duplicated.
- The batched message carries each comment's id, each quote fenced, and no quote can
  open a heading in the next note.
- The comment trimmer drops resolved sent comments before it drops any draft.
