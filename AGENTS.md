
## Conversation artifacts are tracked in jj

When `BRIDGE_ARTIFACTS_DIR` is set, each conversation owns
`<dir>/conversation/<id>/`, and that directory is a jj repository. The harness
commits it once per turn that changed anything, described `turn <submissionId>`.

- **Unset means off.** Without the variable nothing is created and the mtime walk
  in `observed-files.ts` is the only witness — the status quo.
- **One repo per conversation**, never shared. A shared working copy would
  serialise concurrent turns from different conversations, and `jj log` would
  interleave unrelated histories.
- **`change_id` is the anchor, never `commit_id`.** Review comments name
  `(change id, line, content)`; `commit_id` churns under describe/rebase.
- **Content, not just position.** A comment is only `visible` when its change id,
  line number *and* line text all still match. Change id plus line number alone
  reports false positives: delete line 2 and the old line 3 slides up, still
  attributed to the same revision.
- **Annotate is a display witness, never the source of truth.** It cannot prove a
  comment is dead — a deleted or moved line annotates to something else — so a
  miss means `orphaned` (still open, no longer visible). Only an explicit action
  resolves a comment.
- **Never push, never rewrite.** Only `init`, `describe`, `new`, and reads. The
  harness is not a place to publish.
- **Reads pass `--ignore-working-copy`** so a display request cannot snapshot a
  half-written file mid-turn.
- **Bookkeeping never fails a turn.** Both the walk and the commit are wrapped
  separately; a broken repo costs the revision, not the answer.
- **Teardown is `rm -rf`** the conversation directory. That is the whole cleanup
  story, and it only stays this cheap because the repos are not shared.
