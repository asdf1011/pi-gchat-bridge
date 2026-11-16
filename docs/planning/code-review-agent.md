# Requirements: the code review agent

A subagent that reviews a pending change on request and reports its findings as review
comments rather than as prose.

Status: **proposal**. A first, deliberately incomplete implementation exists
(`src/durable/extensions/review-agent.ts`, `test/review-agent.test.ts`); §9 is the
requirement it does *not* yet meet, and §9.2 says exactly which parts. Treat the rest of
this document as requirements, not as a description of the current code — including §2's
note that *an extension is one of three ways to invoke a review, not the requirement.*

Companions: `docs/planning/change-review.md` (the `/review/<change id>/` diff surface and
the draft/send batching) and the anchor model it references. Those decide *where a person
sees a change* and *what a comment on a change is*; this one decides *what a reviewer with
its own context does with it, and what it is allowed to write*.

---

## 1. The job

Someone is working on a pending change and wants it assessed by something other than
themselves: what is wrong, what is missing, what will break. Typically that is whoever
wrote the code — a person, or an agent that wrote it in an earlier turn of the same
conversation — and asking for a review is the step after making the change, not a
separate job. The output they want is **notes attached to the lines they are about**.

So, four requirements that follow from the job rather than from any implementation:

1. **The reviewer must not consume the asking conversation's context.** A review reads
   more of the repository than the change (callers, tests, neighbouring code) and that
   material has no place in a thread about something else.
2. **A finding must land where it is read.** A note is about a file and a line; it should
   appear there, in the review pane, next to the code, and be replyable in its own thread.
3. **The asking conversation must be told the findings exist, without being interrupted.**
   The reviewer works while the asking conversation may be doing something else. A review
   is not a steering comment: injecting "here are four notes" into the middle of unrelated
   work makes it worse, not better. So the notification waits for an idle moment.
4. **An interrupted review must not be lost work.** The bridge restarts. A review that
   died half-way through reading must resume, not be silently abandoned or charged for
   twice.

## 2. Shape: a child conversation

The review runs in a **conversation of its own, owned by the task of the tool call that
started it**.

What that gives us, and why each is a requirement rather than an implementation detail:

- **Isolation.** A task-owned conversation starts as a copy of its owner's agent — model,
  extensions, enabled tools, cwd — and sees none of the owner's transcript. The copy is
  what makes "same tools, new context" true without re-plumbing anything per call.
- **Cross-repository work is possible.** `bash`, `read`, `edit` and `write` are installed
  for every conversation, so the reviewer reads the repository the same way the asking
  conversation would. Nothing about *finding* the change is a new capability.
- **Durability.** Ownership is what makes the child resumable after a restart and what
  shows it in `inspect()` and the task graph while it runs.
- **Attribution.** `details.conversationId` on the tool result lets a UI attach to the
  review in progress, and lets a later reader see which conversation produced which
  comments.

### Requirements

- R2.1 The review conversation is created **inside a commit** with
  `ownership: { kind: "task", taskId: api.taskId }`, so creation and ownership are one
  durable fact.
- R2.2 The child is configured with **only the differences** from the inherited agent
  (`configure()` in the same commit). Restating model, cwd or tools would freeze them
  against a parent that may change.
- R2.3 The child's conversation id is published as the call's `details` before the review
  starts, so a UI can attach while it runs.
- R2.4 Nothing in the design assumes *how* the review is invoked. Every requirement in this
  document is about a child conversation: who owns it, what it is told, where its comments
  go, and how the asking conversation hears about them. Those hold whether the reviewer is
  started by a tool, by a skill, or by something added later.

### How it is invoked — three options, not a decision

Whether the invocation is a tool, a skill, or something added later is an implementation
choice, not a requirement. What the flow actually needs is small:

- something that can **create and configure a child conversation** with a task owner;
- something that can read and write **review comments** in the reviewed conversation;
- something that can **notify** a conversation at a boundary (§8a).

Those three are capabilities of the host, not of any particular agent-side mechanism.
Three ways to expose them, with what each costs:

- **An extension with a tool** (`review_change`). Richest: typed arguments, `details` for a
  UI to attach to, replay policy, a prompt section that can be conditional, and the tool
  task itself is the owner the child needs. Cost: host code, and the tool exists in every
  conversation that selects the extension.
- **A skill** (`SKILL.md` plus something runnable). The bridge already advertises skills
  through `extensions/skills.ts`, and the model may read one to learn the procedure. The
  reviewer would need *commands* rather than prose — a CLI the conversation shells out to
  with `bash` — so the real cost is a command surface that can create a child
  conversation, write comments and send the notification. That is the same host work as
  the tool, minus the agent-side ergonomics, plus a shell-parsing surface and no typed
  `details`.
- **Both**: a skill that explains *when* and *how* to review, over capabilities exposed as
  tools. This is how the rest of the bridge already behaves — skills carry the procedure,
  tools carry the capability — and it is the option least likely to need revisiting.

The requirements are written to be indifferent, with two exceptions that are genuinely
agent-side and stay regardless of the choice: the reviewer is **told** to stay read-only
(R4.1), and it **reports** findings as comments rather than prose (R4.2).

### Delegation from a reviewer

A reviewer may start a review of its own. A reviewer that has found what it is out of its
depth on should be able to hand it to something better placed: a security-focused reviewer,
a reviewer with a bigger model, one scoped to another directory. Requiring a return to the
asking conversation first would make the reviewer pretend to have finished, which is worse.

Delegation stays a **tree**, not a web:

- **R2.5 A reviewer starts a review under itself.** The new child is owned by the same task
  chain, so aborting the outer review aborts what it started, and the task graph shows the
  shape. Nothing delegates to a conversation outside its own subtree.
- **R2.6 Nesting is bounded and visible.** There is a depth limit (the abort path and the
  budget both depend on it terminating), and each level is attributed, so a review's
  comments say which reviewer produced them (R9.1). A chain nobody can read is the failure
  mode to design against; a chain that is bounded and attributed is not.
- **R2.7 A delegated review reports to the same place.** Its comments go to the conversation
  the *root* review was asked from (§9.1 R9.3), not to its parent reviewer's conversation,
  which nobody is reading. The parent's summary says that it delegated.

Settling this is landing step 0 — before the comment plumbing, because it decides whether
the bridge needs a tool, a command surface, or neither.

## 3. Input: the brief

The child cannot see the thread that asked for the review, so the call must say what to
review in words the reviewer can act on.

- R3.1 Starting a review requires a `brief`: which change (a jj revision, a file, a
  directory), what it is for, and what to look hardest at. How it is spelled depends on
  §2's invocation; that it is required does not.
- R3.2 An **empty or whitespace-only brief is refused** before a conversation exists. A
  review that knows nothing about its subject spends a whole child conversation on
  nothing.
- R3.3 A brief is a *pointer*, not a payload: it names the change, it does not carry the
  diff. A brief large enough to be a paste is refused with a message saying so. (The bound
  is a constant in the implementation, like every tool's argument size.)
- R3.4 The brief reaches the child as `instructions` on the child's agent (the scoped
  part), and as the user message that starts it (the task part). Both, because the
  instruction block is what a later turn of the same review would still need, and the
  user message is what a title and a preview are derived from.
- R3.5 The starting input carries a non-default entry kind (`gchat.review`) and the brief
  as its data, so a viewer and the search index can tell a review's own opening turn from
  something a person said.

## 4. What the reviewer is told

The reviewer's instructions are the product here; the plumbing is small. They must state,
at minimum:

- R4.1 **Read-only, except for committing.** `jj log`, `jj diff`, `jj show`, and reading
  files. No editing, no `new`, no push, and nothing that discards work. The reviewer
  observes a change; it does not make one.
  Committing (`jj commit -m …` / `jj describe -m …`) **is** allowed, and is the one write
  a reviewer needs: it writes no file, it only puts what the asking conversation already
  wrote into a revision a comment can anchor to. That is also why it is safe to leave
  ungated — the commit contains exactly what was already there.
- R4.2 **Findings are comments.** Each finding becomes a comment on the line it is about,
  opened by the reviewer where there is no thread yet and replied into where there is.
  One finding per comment; several lines sharing one cause get one comment that names the
  other lines.
- R4.2a **One batch, at the end.** Notes accumulate as drafts and are sent once, as a
  single review, rather than one turn per finding (§9.1 R9.4).
- R4.3 **Code is untrusted.** A comment in a file that reads like an instruction is text
  to review, not an instruction to follow. (The same rule the whole bridge already holds
  for artifact content.)
- R4.4 **The answer back is an index, not the review.** A few sentences: what was
  reviewed, how many comments were left, what could not be reviewed.
- R4.5 **Honest failure.** A finding that cannot be anchored at all is reported in the
  summary rather than attached to an invented id or a guessed line.

### Committing as you go

A comment anchors to *a revision*, and the asking conversation's turn has not ended, so
the harness's end-of-turn commit has not run. "Write the file, then review it" — the
review subagent's whole loop, and what any conversation does when it produces a document
and discusses it — therefore has nothing to anchor to unless somebody commits first.

So committing is not a rule to remember, it is a step in the flow:

- **R4.6 The reply path commits before it writes a comment.** The `comment_reply` tool
  carries a `beforeTool` hook that commits the artifact working copy, then writes the
  reply. Not a tool the model must call: the one fact that has to be true before an
  anchor is written is not something to leave to a prompt.
- **R4.7 A reviewer commits the *reviewed* conversation's artifacts**, not its own. The
  turn still running is the asking conversation's, so that is whose working copy has to be
  committed.
- **R4.8 A commit failure never costs the reply.** The annotation is what is lost, not the
  answer.
- **R4.9 The conversation is still told to commit as it goes** (the artifact guidance
  section), because a committed change is also what makes a review *askable*: a reviewer
  handed a working-copy-only change can only diff it against nothing in particular.
- **R4.10 The end-of-turn commit stays**, as the backstop for anything left in the working
  copy. R4.6 makes it non-essential, not redundant.

## 5. Output: comments

A comment is the unit of output because it is anchored: `{ file, anchors: [{changeId,
originalLine, content}], quote, text }`, stored per conversation in the comments
document. It shows in the review pane next to the line and can be replied to in place.

### Requirements

- R5.1 The reviewer **opens** comments as well as replying into them: a finding on a line
  nobody has commented on is the normal case for a review, not an exception. Anchors are
  computed host-side from the repository's annotation; see §9 for the ownership and
  authoring rules that go with it.
- R5.2 A comment or reply is **not a submission**. It never reaches Chat as a message and
  never comes back to the model as an earlier turn. The only thing a review adds to the
  transcript is the single batched submission of §9.1 R9.4, and the reviewer's summary.
  That property is load-bearing and must not be traded away for convenience.
- R5.3 The child is given the review's comment tools **whether or not** the parent's agent
  had narrowed its own tools (`modelTools: { add: [...] }`), because a review with no way
  to report is not a review.
- R5.4 Comments and replies are **attributed**: an explicit free-form author, never
  defaulted (R9.1), so a reader can tell a finding from a decision from a question.
- R5.5 The text is plain: no markdown decorations that would not render in a comment
  thread.

## 6. What comes back to the asking conversation

- R6.1 What comes back is an **index, not the review**: the reviewer's own last answer.
  The findings are in the comments, and pasting them into the parent's transcript is the
  thing §2 exists to prevent.
- R6.2 Reading the child's answer uses the child's **own transcript**, newest message
  first, taking the first assistant message with text. An assistant turn holding only
  thinking, or only a tool call, is not an answer.
- R6.3 The result's `details` carry the child's conversation id and the summary, so a UI
  can link to the review.
- R6.4 A review that ends **without answering** is reported as an error, not as an empty
  summary. "Nothing came back" is a different fact from "the reviewer had nothing to
  say", and the asking conversation must be able to tell them apart.
- R6.5 The result carries the child's conversation id, so a UI can link to the review.

### Sizing, not a requirement

R6.1 says *what* comes back; how many bytes of it is an implementation choice, not a
requirement. The answer is indexed by the reviewer's instructions (R4.4) and bounded by
the tool's own output limit, which every tool already has. If the bound ever needs to be
tuned — a stricter one, or none — that is a constant, not a change to this document.
- R6.5 The summary is what the *caller* of the tool sees. The conversation as a whole is
  told separately, at a boundary and without steering (§8a) — the call returning does not
  itself put anything into the transcript beyond this result.

## 7. Durability and replay

- R7.1 The tool is `replay: "safe"`. A crash mid-review must reattach to the same child,
  because the child is owned by the call's task.
- R7.2 The child's creation is read-then-create inside one commit: scan conversations
  owned by this task, reuse the first, create only if there is none.
- R7.3 The starting input carries a **fixed request id** (`review:<taskId>`), so a rerun
  cannot send the same brief to the child twice.
- R7.4 A second review of the same change, asked for deliberately in a later turn, is a
  *new* tool call and so a new child. Deduplication is per call, not per change.

## 8. Prompt budget

These apply to whichever invocation §2 settles on; where the text lives (an extension's
section, or a skill's description) follows from that choice, the rule does not.

- R8.1 The reviewer's entry point is advertised **only where it exists**. Explaining a
  capability the model was not given is prompt spent on nothing.
- R8.2 Whatever advertises it says *when to prefer* a review (an assessment, rather than
  help editing) and *not to repeat* the findings, because the summary already carries the
  index.

## 8a. Telling the asking conversation the findings exist

A review finishes when nobody is waiting for it. The asking conversation may be mid-turn
on something unrelated, idle, or dealing with a person; the reviewer has no idea which.
So the notification is a separate requirement from the comment, and it needs rules.

### What already exists

Artifact comments take the loudest option available: the browser submits `modelText(...)`
as a turn with `whenBusy: "steer"` and `requestId: comment:<id>`, so the comment's words
become a user message, joining the running turn if there is one. That is right for a
person's note — they typed it *to* the agent, and they are watching the reply appear.

A review is not that. It is a second opinion on work already done, produced by a machine
somebody asked to look. The person reading the conversation did not just write anything.

### Requirements

- **R8a.1 The notification never steers and never races.** It is delivered at a boundary,
  not injected mid-turn: `whenBusy: "followUp"` (queue behind the current turn) rather
  than `"steer"`. If the turn is already over, it starts one. This is the same machinery
  Chat messages already get, not a new mechanism.
- **R8a.2 The notification is an index, not the notes.** The message says that a review of
  the named change has completed, how many comments it left and where
  (`4 comments on 2 files in <change>`), and leaves the text in the comments. It must not
  paste the findings: they are already anchored to their lines, and a conversation that
  has read them inline has no reason to open the pane.
- **R8a.3 But it must be enough to act on without the pane.** The asking agent is a model
  in a conversation that may have no view of the review pane at all. So the notification
  has to carry what a decision needs: the count, the files, and the addresses, or a way to
  fetch the comments (`comment_thread` / a list operation) rather than a bare "see the
  review pane". A notification that cannot be acted on is noise.
- **R8a.4 Addressing is per comment, even though delivery is one message.** The message
  names each comment's short id (the batched form in §9.1 R9.5), so a reply can be aimed
  at one of twelve rather than at the review as a whole.
- **R8a.5 Exactly once.** One review, one notification, however many comments it left and
  however the bridge restarts in between. The request id is per review, as the batch's is
  (R9.4), so a resume does not re-deliver it.
- **R8a.6 It is attributable and distinguishable.** The notification is a machine's
  message about the reviewer's own findings: it carries its own entry kind and origin, and
  is not written to look like something the person said. A reader of the transcript can
  tell "the reviewer finished" from "someone spoke".
- **R8a.7 Silence is a valid outcome.** A review that finds nothing leaves no notification
  beyond the reviewer's summary in the tool result (R6.1). "No findings" is worth one
  sentence, not an idle turn. This is a decision to make explicit, because the batched
  path would otherwise happily send an empty review.
- **R8a.8 The reviewer does not wait for an answer.** The tool call returns when the
  review is done; addressing the comments is a later turn, triggered by the notification
  or by the person, not a conversation the reviewer hangs on. Otherwise a review that
  nobody reads holds the reviewer's task open forever.

### Open question

Whether the notification should also post into Chat, as a turn's answer does, or stay in
the transcript and the pane. The review's own summary already reaches Chat through the
tool result being part of the answering turn (when the review was requested by a person);
when it was requested by the asking agent mid-work, the notification is the only thing
that would surface. Leaning towards one short Chat line ("reviewed `abc123`: 4 notes"),
for the same reason the notification exists at all — but it is a surface question, not a
requirement, and it should be settled with the person who asked for it.

## 9. Who owns the comments, and how they are sent

This section is the requirement that settles the hardest question in the plan. The first
draft of this document left it as an open gap; a review of that draft answered it, and the
answer is worth stating in full because every other part of the flow follows from it.

**A review's comments belong to the conversation that asked for the review — not to the
reviewer's own conversation — and the reviewer is their author.** The reviewer is a child
of that conversation and is working on its behalf; a note in a pane nobody is looking at
is not a review.

Four participants, three of whom write comments:

- **The person** — the one who asked, or who is answering the agent.
- **The asking agent** — the conversation that started the review (§2), or that is
  responding to the review's findings.
- **The reviewer** — the child conversation, reading its own way through the change.

The author field stays a **free-form string**; it does not become an enumeration. A
closed set would have to grow the first time another identity appears, and it would force
a migration over comments already stored. What the field does have to be is **always
present and always explicit**: a write names its author, no writer falls back to a
default, and the two tools always set one (the reviewer's is a constant). That is enough
for the pane to say who wrote a note, which is the whole requirement.

The one thing worth fixing in the current shape is the default: `StoredReply.author`
silently becomes `"agent"`, which cannot tell the asking agent from the reviewer.

### 9.1 Requirements

- **R9.1 Who wrote it is always stated.** Every comment and every reply carries an
  explicit, free-form author set by its writer — no default, no empty field, no
  "unknown". The reviewer writes under one fixed tag, distinct from the asking agent's.
  The pane shows the author on every note and reply, because a finding, a decision and a
  question are different kinds of statement and the reader needs to know which they are
  reading.
- **R9.2 The reviewer can open comments.** `comment_add` must exist for the reviewer: file,
  line range, text. The anchors are computed **host-side** from the artifact repository's
  own annotation, exactly as the interactive commenter does it (`CommentInput` in
  `src/session-host/api.ts`). A tool is never trusted to supply its own anchors — that is
  why the operation is a seam method, not a caller-supplied coordinate.
- **R9.3 Comments are written into the asking conversation's comment list**, whatever
  conversation the writer runs in. The owning conversation is an explicit parameter of the
  write, not "wherever the author happens to be".
- **R9.4 A review produces many comments and sends them as one batch.** A review is a
  sitting: the reviewer reads ten files, writes notes as it goes, and sends once. The
  batch is one submission to the asking conversation, one `requestId`, one turn — not
  twelve. This reuses the draft / `reviewId` / `sendReview` design already specified in
  `docs/planning/change-review.md`; there must not be a second mechanism for the agent
  that exists for the person.
- **R9.5 The batch is addressed by comment id.** Each note in the batched message keeps
  its own id (short form), so any participant can reply to one of twelve. Quotes stay
  individually fenced and sanitised: ten untrusted file quotes concatenated is a larger
  injection surface than one, not a smaller one.
- **R9.6 The asking conversation may answer the review in one call.** Whatever it decides
  about the findings — accept, reject, ask — its replies are written as drafts and sent
  together, by the same batching path as R9.4. It must not need a tool call per note.
- **R9.7 The reviewer resolves the comments it raised.** Resolving is otherwise a human
  action and there is deliberately no `comment_resolve` in the interactive tool set (a
  reply says nothing actionable; closing someone's note is not the agent's business).
  That rule is unchanged for the asking agent and gains one exception: the reviewer may
  resolve a comment **it wrote**, and only that. A reviewer resolving a person's comment,
  or one the asking agent raised, is out of scope.
- **R9.8 Resolving is still a mutation on the chat API.** It stays off the artifact
  origin alongside every other write; nothing about R9.7 moves a decided flag onto a
  GET-only surface.

### 9.2 What this means for the implementation as it stands

The current code satisfies none of R9.2–R9.7 and only partly R9.1. Specifically:

- `comment_reply` is the only writing tool, and it appends to a thread in **the writer's
  own conversation** (`host.addCommentReply(api.conversationId, ...)` in
  `extensions/comment-tools.ts`). For the reviewer that is the child, so its replies are
  invisible in the review pane. This is the bug that makes the present implementation
  unusable in practice.
- There is no comment-creation operation anywhere, so findings on uncommented lines
  cannot be recorded at all.
- No batching exists in either direction.
- The author field exists but is defaulted: `StoredReply.author` becomes `"agent"` when
  nothing says otherwise, so the asking agent and the reviewer are indistinguishable.
- There is no resolve operation exposed to any tool.

Each of those is a requirement above, and none of them can be worked around where the
reviewer lives, whatever that turns out to be (§2): every one is a change to the seam, the
comments document, and the comment tools. That is the useful part of the finding — the
missing capability is host-side, not agent-side.

## 9a. Remaining gaps (not blocking the flow above)

- **G9a.1 "Pending change" is not a defined address.** The brief names a change in words.
  There is no requirement yet on *what* a pending change is (`@`? the working copy against
  trunk? a named revision?) and no tool that resolves one. `change-review.md` has the
  resolution rules for a change id; the reviewer needs the same, not a paraphrase.
- **G9a.2 No way to stop or follow a review in progress.** Cancelling the tool call aborts
  the child (ownership cascades), but there is no surface that lists running reviews or
  shows one's progress. `taskGraph()` already carries what a panel would need.
- **G9a.3 Selection is not a permission boundary.** The child gets `edit` and `write`
  because it inherits the parent's tools, and is told to be read-only in prose. A review
  that could not modify the repository *by construction* would be stronger; the
  mechanism is a per-conversation tool allowlist (`configure({ tools })`), not a promise
  in a prompt.
- **G9a.4 Model choice is inherited.** A review is a different job from the conversation
  that asked for it, and a cheaper or stronger model may be right. Nothing sets the
  child's model today.

## 10. Tests

What is covered now (`test/review-agent.test.ts`, a real harness on in-memory storage):

- The child's last answer is read from the child's own transcript, skipping thinking-only
  and tool-call-only turns, and a later empty turn does not erase an earlier answer.
- A task-owned child inherits its owner's model and extensions, and starts with no
  entries.
- An empty brief is refused and no reply writer is called.

What must be covered once §9 is built, in the same shape:

- The reviewer opens a comment on a line with no existing comment; the anchors come from
  the host's annotation and survive a reload (R9.2).
- A comment the reviewer wrote appears in the **asking** conversation's comment list and
  not the child's (R9.3), carrying the reviewer's author tag (R9.1).
- No write path produces a comment or reply with an empty author, and none is filled in by
  a default.
- One review produces exactly one submission to the asking conversation, whatever number
  of comments it opened, and one `requestId` (R9.4).
- The batched message carries each comment's id, and its quotes stay individually fenced
  so one note cannot open a heading in the next (R9.5).
- The asking conversation answers several notes in one call, and its replies arrive as one
  batch too (R9.6).
- A review that finishes while the asking conversation is mid-turn does not steer it: the
  notification is placed at the boundary, after the running turn's work (R8a.1).
- The notification names the review and its comment count but does not paste the findings,
  and names each comment's short id (R8a.2, R8a.4).
- A bridge restart between the review finishing and the notification being delivered
  produces exactly one notification, not zero and not two (R8a.5).
- A review that finds nothing notifies nobody (R8a.7), and the tool result says so.
- The reviewer's task is terminal once the tool returns, even if nobody reads the
  findings (R8a.8).
- The reviewer resolves a comment it wrote and cannot resolve one it did not (R9.7).
- A review that is interrupted (harness closed mid-run) resumes after reopen and does not
  create a second child (R7.1–R7.3).
- A review whose brief names an unresolvable change fails with a usable message and no
  child left behind.
- The full review is not in the parent's entries: what the asking conversation keeps is
  the reviewer's summary, whatever the size bound happens to be (R6.1).
- A reviewer delegates to a second reviewer: the grandchild is owned within the same task
  chain, its comments land in the root asking conversation, and aborting the outer review
  aborts both (R2.5–R2.7).
- Delegation past the depth limit is refused rather than run (R2.6).

## 11. Landing order

0. **Settle §2's "how it is invoked"** — tool, skill-over-commands, or both. Everything
   after this is host work that is identical either way, so this can slip; what cannot
   slip is writing the tool *and* the surface for a decision nobody made.

1. **Comments belong to the asking conversation.** Make the owner of a comment an
   explicit parameter of every write, and change `comment_reply` to take it, so a review's
   replies land where they are read (R9.3). This is the bug that makes the current code
   unusable, and it is worth fixing before anything is built on it.
2. **Author is explicit everywhere**: every comment and reply write names its author, the
   `"agent"` default goes, and the reviewer writes under its own fixed tag (R9.1).
3. **Open a comment from the host side**: one seam operation that anchors a file and line
   range from the repository's annotation and stores it in the reviewed conversation
   (R9.2). Nothing else is worth building on a reviewer that cannot leave a note.
4. **Batching**, reusing the draft / `reviewId` / `sendReview` design in
   `change-review.md`, in both directions: the reviewer's findings in one submission
   (R9.4–R9.5), and the asking agent's answers in one submission (R9.6).
5. **The notification** that lands after the batch: boundary delivery, an index rather
   than the notes, once per review (§8a). It shares the batch's request id, so it is
   built with it rather than after it.
6. **Resolve, scoped to the reviewer's own comments** (R9.7–R9.8).
7. Then, and only then, the remaining gaps of §9a — starting with §9a.1 (resolve "the
   pending change" host-side and pass the revision, not a description of it) and §9a.3
   (a tool allowlist instead of a promise in a prompt).
