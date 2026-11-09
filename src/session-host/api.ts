/**
 * The seam between the conversation host and its adapters.
 *
 * This file is the contract: the only operations an adapter may use, and the only
 * shapes that cross the boundary. It imports **nothing** from pi-durable or chord
 * on purpose — an adapter that can name a library type can reach past the seam,
 * and then the seam is a suggestion. `test/session-host.test.ts` enforces it.
 *
 * Two rules decide what belongs here, both learned from shipping the artifact
 * origin first (see docs/session-host-api.md):
 *
 *   1. **Plain data only.** Ids are `number`, cancellation is an `AbortSignal`,
 *      and nothing is a class instance, a branded type, or a live handle.
 *   2. **Small by construction.** What crosses must be bounded regardless of how
 *      long the conversation is — a projection, a derived list, an id. The
 *      transcript itself never travels: `snapshot()` is a projection, not
 *      entries, and artifacts are derived host-side rather than walked by each
 *      adapter. Measured: the largest conversation here is 2.8 MB of entries and
 *      ~28 ms to marshal, per attach, per client. That is what this rule avoids.
 *
 * Deliberately absent for now, because no adapter needs them yet: turn awaiting,
 * model settings, adapter-scoped documents, titles and secrets. They are
 * specified in the doc and land with the adapters that use them.
 */
import type { ProjectedView } from "./projection.js";
import type { ArtifactFile } from "../durable/artifacts.js";

/** A model as a picker lists it. Plain data, so it can cross the seam. */
export interface ModelInfo {
  provider: string;
  id: string;
  label: string;
  /** Levels this model supports, `["off"]` for a non-reasoning model. */
  thinkingLevels?: string[];
}

/**
 * One provider's quota, as a `/quota` card or command shows it.
 *
 * Defined here rather than in `quota.ts` because it crosses the seam: the probe reads `models.json`
 * and the providers' own APIs, which is host work, so an adapter in another process asks for the
 * result rather than running the check. Everything in it is plain data by construction.
 */
export interface ProviderQuota {
  provider: string;
  /** Model ids this provider offers (plus the topic titler's, when it shares this provider). */
  models: string[];
  /** True when any model bills per token, so a top-up link is worth showing. */
  paid: boolean;
  topUpUrl?: string;
  /** True when a quota API was actually queried. */
  queried: boolean;
  /** Provider says the account can make calls (undefined = unknown/not queried). */
  available?: boolean;
  /** Formatted balance / quota line. */
  balance?: string;
  /** Free-local note, "no quota API" note, or error detail. */
  note?: string;
}

/** Token and cost totals, summed over every model one conversation has used. */
export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

/** What a status card needs about one conversation. Bounded by construction. */
export interface ConversationState {
  conversationId: number;
  /** `"provider/modelId"`. */
  model: string;
  provider: string;
  modelId: string;
  thinkingLevel?: string;
  supportedLevels?: string[];
  usage?: UsageTotals;
  /** Entries in the active transcript. A count, not the entries. */
  entries: number;
}

/** One conversation, as an adapter names and displays it. */
export interface NamedConversation {
  conversationId: number;
  /** The adapter's name for it — a Chat thread key, or a web conversation key. */
  name: string;
  /** Human label, when one has been set. */
  label?: string;
  /**
   * Last time something was said in this conversation, epoch ms.
   *
   * `createdAt` orders a list by age; this orders it by *use*, which is what a
   * recent-conversations list means. Maintained by the host on every submission,
   * and equal to `createdAt` until the conversation is used.
   */
  lastActivityAt?: number;
  /** Opening words, shown when no title has been generated yet. */
  preview?: string;
  /** `"provider/modelId"`. */
  model: string;
  thinking?: string;
  createdAt: number;
}

/** What a conversation needs to be created with. */
export interface AgentConfig {
  model: { provider: string; modelId: string };
  thinkingLevel?: string;
  /** Working directory for tools. Defaults to the host's. */
  cwd?: string;
}

/**
 * One line a comment is anchored to.
 *
 * `(changeId, originalLine, content)` is the identity of a line in history: the
 * revision that last touched it, which of that revision's lines it was, and what
 * it said. All three, because any two of them can be satisfied by a different
 * line after an edit.
 */
export interface CommentAnchor {
  changeId: string;
  originalLine: number;
  content: string;
}

/**
 * Where a comment stands against the revision being displayed.
 *
 * `superseded` means the lines it was written on are gone *and* the revision that
 * replaced them is known — the normal, successful outcome of asking for a change,
 * which used to be reported as `orphaned`.
 */
export type CommentState = "visible" | "superseded" | "orphaned" | "resolved";

/**
 * Where a comment's lines went, when the revision that replaced them is known.
 *
 * A location, not a claim of causation: a turn may rewrite a file for reasons the
 * comment had nothing to do with, so this says "the text you commented on now
 * lives here", never "your note caused this".
 */
export interface CommentSuccessor {
  /** Change id of the revision the successor was found in. */
  revision: string;
  /** `moved` kept the text, `replaced` changed it, `removed` deleted it. */
  kind: "unchanged" | "moved" | "replaced" | "removed";
  /** 1-based range in that revision; `end < start` means "the gap it left". */
  start: number;
  end: number;
  /** The text now at that range, for a drawer to show above the note. */
  quote?: string;
}

/**
 * A comment, as a viewer draws it.
 *
 * `positions` are line numbers in the revision the host resolved against — the
 * only field a highlight needs. A comment is *anchored* to history and *drawn*
 * at a position, and keeping both is what lets a line move without losing its
 * review.
 */
export interface CommentView {
  id: string;
  file: string;
  anchors: CommentAnchor[];
  quote?: string;
  charStart?: number;
  charEnd?: number;
  /**
   * Which occurrence of `quote` this comment was written on, 0-based.
   *
   * Only a rendered document needs it: painting a highlight there means finding
   * the text again, and the same phrase can appear many times.
   */
  occurrence?: number;
  text: string;
  at: number;
  author?: string;
  resolved?: boolean;
  state: CommentState;
  positions: number[];
  /** Where it went, when the anchor no longer matches but the diff can say. */
  successor?: CommentSuccessor;
  /** The revision this comment was written against, as a change id. */
  atRevision?: string;
  /** Submissions this comment started, oldest first. Answers are fetched apart. */
  submissions?: number[];
}

/**
 * A selection, as a viewer reports it.
 *
 * A source view knows line numbers; a *rendered* document does not, so it reports
 * the selected text and the host finds where it came from. Either `line` or
 * `quote` must be present.
 */
export interface CommentSelection {
  line?: number;
  endLine?: number;
  charStart?: number;
  charEnd?: number;
  /** The selected text, as the reader sees it. */
  quote?: string;
  /** 0-based occurrence of `quote`, when the same text appears more than once. */
  occurrence?: number;
}

/** What a new comment needs. The anchors are derived host-side, never sent. */
export interface CommentInput {
  /** Path relative to the artifact repository root. */
  file: string;
  selection: CommentSelection;
  text: string;
  author?: string;
}

/**
 * One exchange in a comment's thread.
 *
 * `answer` is a turn the comment started (`submissionId` says which), and `note`
 * is the agent replying through its tool. They are one list because a reviewer
 * reads them in one order; `kind` is what lets a view style them differently.
 */
export interface CommentReply {
  kind: "answer" | "note";
  text: string;
  at?: number;
  submissionId?: number;
  author?: string;
}

/**
 * One part of a message.
 *
 * Images travel **inline**: a Chat attachment arrives as base64, and it is one
 * payload per message rather than a repeated frame — the "bytes by reference"
 * rule is about the 100 ms frame channel, not about a single upload. A
 * file-reference form belongs here the day something actually has a file to
 * point at; until then it would be a shape with no caller.
 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type MessageContent = string | readonly ContentPart[];

export type WhenBusy = "steer" | "followUp" | "reject";

export interface SubmitRequest {
  /**
   * Idempotency key: a redelivered Chat message must not start a second turn.
   * The host dedupes on it, which is why an adapter may retry safely.
   */
  requestId?: string;
  content: MessageContent;
  /** Defaults to `"steer"`: join the running turn rather than queue behind it. */
  whenBusy?: WhenBusy;
  /**
   * The surface this came from: `gchat`, `webui`, `cron`.
   *
   * Recorded against the user entry, and inherited by the turn's answer, so a
   * surface painting the conversation can tell *its own* messages from another
   * surface's. Without it, a bridge that reads the log and posts it back would
   * repeat messages its transport already holds — the bot answering itself.
   *
   * A name, not an enum: the set of surfaces is a deployment fact.
   */
  origin?: string;
}

export type SubmitResult = { submissionId: number } | { error: string };

/** An image attached to a message. The bytes are fetched separately. */
export interface TranscriptImage {
  mimeType: string;
}

/** One message as a viewer shows it: who said it, what, and when. */
export interface TranscriptMessage {
  role: "user" | "assistant";
  text: string;
  /** Epoch ms the message was created, when the host knows it. */
  at?: number;
  /**
   * Entry this message came from, so its images can be addressed.
   *
   * A conversation can have several messages per entry; the pair
   * `(entryId, index)` is what the image route takes.
   */
  entryId?: number;
  /** Images attached to this message, in order. Bytes are not inlined. */
  images?: TranscriptImage[];
  /**
   * Surface that produced the entry, when it was stamped at submit time.
   *
   * Absent means unknown — older than the stamp, or a submission that failed to
   * record one. Readers must treat unknown conservatively (see
   * `durable/delivery-pass.ts`), never as "this surface already has it".
   */
  origin?: string;
}

/**
 * How a submission ended.
 *
 * `done` carries the answer's text, extracted by the host: an adapter should
 * never have to know how an assistant entry is shaped. `answerId` stays because
 * the Chat adapter's "post this answer once" claim is keyed by it.
 */
export type Settled =
  | { status: "done"; answerId: number; text: string }
  | { status: "unanswered"; reason?: string; detail?: unknown };

/**
 * A verdict an adapter records about a conversation — the notification
 * validator's "did this notification deserve to be sent".
 */
export interface AdapterVerdict {
  verdict: "YES" | "NO";
  reason: string;
  notificationPosted?: boolean;
  postFailed?: boolean;
  error?: string;
  at: number;
}

/** An entry an adapter writes for itself: a notice, not a model turn. */
export interface AdapterEntry {
  /** Entry kind, e.g. `app.notice`. Namespaced by convention. */
  kind: string;
  data: unknown;
  /** Messages the model should see for it, if any. */
  model?: readonly unknown[];
}

/** A view attachment. `detach()` is idempotent. */
export interface ViewHandle {
  /** The state at attach time, before any frame arrives. */
  readonly snapshot: ProjectedView;
  detach(): void;
}

export interface HostInfo {
  /** Storage file the host owns. For diagnostics, not for adapters to open. */
  dbPath: string;
  /** Working directory conversations start in. */
  cwd: string;
  startedAt: number;
}

/**
 * The operations an adapter may call.
 *
 * In-process today; the same shapes are what a link would carry, which is why
 * every method is `async` even where the implementation is immediate.
 */
export interface SessionHost {
  /**
   * Where the host is running: storage path, working directory, start time.
   *
   * `async` like everything else here, and it was not: a link cannot answer synchronously, and a
   * contract whose methods are *almost* all async is one an adapter cannot be written against
   * without knowing which side of a process boundary it is on.
   */
  info(options?: { signal?: AbortSignal }): Promise<HostInfo>;

  /**
   * Conversations, most recently used first.
   *
   * `limit`/`offset` exist because the web index pages through them; a caller
   * that omits both gets everything, which is what the Chat commands want.
   */
  list(options?: { limit?: number; offset?: number; signal?: AbortSignal }): Promise<NamedConversation[]>;

  /** One conversation by its adapter-chosen name, if it exists. */
  resolve(name: string, options?: { signal?: AbortSignal }): Promise<NamedConversation | undefined>;

  /**
   * The conversation named `name`, created on first use.
   *
   * Must be safe to call concurrently for one name: two adapters asking at once
   * get one conversation. (The current implementation guards this with a
   * per-process map, which is correct for one process and is decision D1 to fix
   * before this ever runs behind a link.)
   */
  getOrCreate(
    name: string,
    agent: AgentConfig,
    options?: { signal?: AbortSignal },
  ): Promise<NamedConversation>;

  /**
   * A window of the transcript, newest last.
   *
   * Bounded on purpose: the pane needs a screenful, not the conversation. Each
   * message is truncated by the host, so the count is the only knob a caller
   * needs for size.
   *
   * `offset` counts back from the *newest* message, which is the direction a
   * conversation is read in: 0 is the last message, and `offset: limit` asks for
   * the page before it. Paging from the end rather than the start is what makes
   * "show earlier" work without a stable cursor — the store has no ordering the
   * caller could resume from, and the newest message is the only anchor that
   * cannot shift under a turn that is still appending.
   *
   * A window that runs off the front is short rather than an error, so the last
   * page is the one that returns fewer than `limit`: that is how a caller learns
   * it has reached the beginning.
   */
  history(
    conversationId: number,
    options?: { limit?: number; offset?: number; signal?: AbortSignal },
  ): Promise<readonly TranscriptMessage[] | undefined>;

  /**
   * The bytes of one image from a transcript entry, as base64.
   *
   * Separate from `history` because images are megabytes and history is a page
   * of messages: a viewer fetches the ones it is about to show, and nothing else.
   */
  image(
    conversationId: number,
    entryId: number,
    index: number,
    options?: { signal?: AbortSignal },
  ): Promise<{ mimeType: string; data: string } | undefined>;

  /** What this conversation looks like right now. Small and bounded. */
  snapshot(conversationId: number, options?: { signal?: AbortSignal }): Promise<ProjectedView | undefined>;

  /**
   * Snapshot, then frames. Returns `undefined` when the conversation is gone.
   *
   * The **current state arrives as the first frame**, before any commit, so a
   * caller never needs a separate initial paint and cannot paint a stale
   * snapshot over a newer frame.
   *
   * The frame callback is why this operation cannot cross a link unchanged: a
   * function is the one thing a serializing boundary cannot carry. Over a link
   * this becomes "send frames to attachment N" plus a detach call — chord's
   * replicated state is already that shape.
   */
  attach(
    conversationId: number,
    onFrame: (view: ProjectedView) => void,
    options?: { signal?: AbortSignal },
  ): Promise<ViewHandle | undefined>;

  /**
   * The files this conversation wrote or edited.
   *
   * Derived host-side rather than by the adapter from the transcript: 19 records
   * instead of 1,085 entries, and the derivation is the host's business.
   */
  artifacts(
    conversationId: number,
    options?: { signal?: AbortSignal },
  ): Promise<readonly ArtifactFile[] | undefined>;

  /**
   * The review comments on a conversation's artifacts, with their current state.
   *
   * Resolved against the *live* revision of each file. A viewer showing an older
   * revision resolves the same anchors itself, from `anchors` and `positions`
   * being recomputed — the seam carries what is true now, not every view of it.
   */
  comments(
    conversationId: number,
    options?: { signal?: AbortSignal },
  ): Promise<readonly CommentView[] | undefined>;

  /**
   * Add a comment to an artifact.
   *
   * The selection is lines (and optionally characters within one line); the host
   * turns it into anchors from the artifact repository's own annotation, so a
   * stale viewer cannot pin a comment to a line it never saw. Errors are returned
   * rather than thrown: "no jj repository" is an ordinary answer here.
   *
   * Returns the comment as stored, anchors and resolved quote included, so a
   * caller can word the turn and the Chat notice without a second read — and
   * without having to trust the request for either.
   */
  addComment(
    conversationId: number,
    input: CommentInput,
    options?: { signal?: AbortSignal },
  ): Promise<{ comment: CommentView } | { error: string }>;

  /**
   * Reply into one comment's thread as the agent.
   *
   * Deliberately *not* a submission: a review reply is plumbing, so it must not
   * appear in Chat and must not come back to the model as context. Reachable
   * from the agent's own tool; there is no HTTP route, because a person replying
   * to a thread is a turn (`/comments/:id/reply`).
   */
  replyToComment(
    conversationId: number,
    commentId: string,
    text: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ id: string } | { error: string }>;

  /** Resolve, or reopen, one comment. True when something changed. */
  resolveComment(
    conversationId: number,
    commentId: string,
    resolved: boolean,
    options?: { signal?: AbortSignal },
  ): Promise<boolean>;

  /**
   * Note a submission a comment started.
   *
   * Separate from `addComment` because the id only exists once the turn has been
   * submitted, and a comment must be recorded before it is submitted — otherwise a
   * crash between the two loses the reviewer's words. Losing the answer instead is
   * recoverable: the thread still shows what was asked.
   */
  noteCommentSubmission(
    conversationId: number,
    commentId: string,
    submissionId: number,
    options?: { signal?: AbortSignal },
  ): Promise<void>;

  /**
   * The answers a comment's submissions have produced, oldest first.
   *
   * Separate from `comments` because awaiting a submission blocks until its turn
   * settles, and a review pane asks for this when a thread is opened, not when a
   * page is painted.
   */
  commentThread(
    conversationId: number,
    commentId: string,
    options?: { signal?: AbortSignal },
  ): Promise<readonly CommentReply[] | undefined>;

  /**
   * Add a message to a conversation.
   *
   * The returned id is the handle for everything that happens next; awaiting the
   * answer is a separate operation (not yet on the seam) so that this one stays
   * a fast, idempotent write.
   */
  submit(
    conversationId: number,
    request: SubmitRequest,
    options?: { signal?: AbortSignal },
  ): Promise<SubmitResult>;

  // --- Settings and naming -------------------------------------------------
  //
  // Binding-affecting operations are keyed by *name*, not by conversation id:
  // the binding record is the adapter's name → conversation mapping, and a model
  // change has to update it in the same commit as the conversation's agent or a
  // card and the running turn disagree.

  /** Everything a `/status` card needs. `undefined` when the conversation is gone. */
  state(conversationId: number, options?: { signal?: AbortSignal }): Promise<ConversationState | undefined>;

  /** Models a picker may offer, with their supported thinking levels. */
  models(options?: { signal?: AbortSignal }): Promise<readonly ModelInfo[]>;

  /**
   * Change the model (and thinking level) a named conversation runs with.
   *
   * One commit: the conversation's agent and the binding record change together,
   * so the card, the next request and `/status` never disagree.
   */
  setModel(
    name: string,
    change: { provider: string; modelId: string; thinkingLevel?: string },
    options?: { signal?: AbortSignal },
  ): Promise<{ model: string; thinkingLevel?: string }>;

  /** Start `name` on a fresh conversation, leaving the old transcript in storage. */
  create(name: string, agent: AgentConfig, options?: { signal?: AbortSignal }): Promise<NamedConversation>;

  /** Point `name` at an existing conversation, keeping the previous label. */
  bind(name: string, conversationId: number, options?: { signal?: AbortSignal }): Promise<NamedConversation | undefined>;

  /** Forget a name's binding. The transcript stays. */
  unbind(name: string, options?: { signal?: AbortSignal }): Promise<boolean>;

  /** Set a conversation's display label. Adapter-facing text only. */
  label(name: string, label: string, options?: { signal?: AbortSignal }): Promise<boolean>;

  /**
   * Wait for a submission to settle.
   *
   * Durable: the id is enough, so a host that restarted mid-turn can still
   * answer this (the turn resumes). That is why the seam returns an id rather
   * than a handle — a handle would only exist in the process that submitted.
   */
  awaitSubmission(submissionId: number, options?: { signal?: AbortSignal }): Promise<Settled>;

  /** Write an adapter-authored entry into a conversation. Returns its id. */
  write(conversationId: number, entry: AdapterEntry, options?: { signal?: AbortSignal }): Promise<number>;

  // --- Adapter-owned durable state ----------------------------------------
  //
  // D5 in the doc said "one generic primitive, namespaced". These turned out to
  // be two *typed* claims over the documents that already exist, rather than a
  // generic key/value store: a generic store would let an adapter write anything
  // anywhere, and switching to one would have meant migrating live claims — for
  // a claim whose whole job is to survive exactly that kind of change. The names
  // are the semantics, which is the property that matters.

  /** Record an adapter's verdict about a conversation (notification validation). */
  recordVerdict(name: string, verdict: AdapterVerdict, options?: { signal?: AbortSignal }): Promise<void>;

  /** The last verdict recorded for a name. */
  verdict(name: string, options?: { signal?: AbortSignal }): Promise<AdapterVerdict | undefined>;

  /**
   * The first user/assistant exchange of a conversation, for a title.
   *
   * Extracted host-side: a title needs two strings, and the transcript it would
   * otherwise take to get them is the one payload the seam must never carry.
   */
  firstTurn(
    conversationId: number,
    options?: { signal?: AbortSignal },
  ): Promise<{ userText: string; assistantText: string } | undefined>;

  /** Compact the conversation's context now. Instructions are free text. */
  compact(conversationId: number, instructions?: string, options?: { signal?: AbortSignal }): Promise<void>;

  /**
   * Stop whatever the conversation is doing.
   *
   * `false` means the conversation is gone, not "there was nothing to stop": aborting is idempotent
   * and the host has nothing to report about a turn it was not running. Ask the *view* whether
   * something was running (`snapshot().busy`) when the answer needs to say so — which is what the
   * Chat adapter does, and what `/abort` had to be taught.
   */
  abort(conversationId: number, options?: { signal?: AbortSignal }): Promise<boolean>;

  /**
   * The names in the deployment's secret store. Never the values.
   *
   * Host work because the store is a file beside the database, and the same file seeds the redaction
   * registry — so the host is the thing that can read it and the thing that must not leak it.
   */
  secrets(options?: { signal?: AbortSignal }): Promise<readonly { name: string; addedBy?: string }[]>;

  /**
   * Store a secret.
   *
   * The value crosses this boundary once, on the way in, and is never returned by anything: the seam
   * has no read that yields a value, so an adapter cannot leak what it can only write.
   */
  setSecret(
    name: string,
    value: string,
    addedBy: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ ok: true } | { error: string }>;

  /** Delete a secret by name. True when something was removed. */
  removeSecret(name: string, options?: { signal?: AbortSignal }): Promise<boolean>;

  /**
   * Provider quotas, for `/quota`.
   *
   * Host work on purpose: it reads `models.json` (the providers' connection details and keys) and
   * calls each provider's own balance API with a hard timeout. An adapter in another process cannot
   * do either, and a check that failed to reach the network must still be reported per provider —
   * `note` is where that goes.
   */
  quota(options?: { signal?: AbortSignal }): Promise<readonly ProviderQuota[]>;

  /** Store-wide token and cost totals. */
  usage(options?: { signal?: AbortSignal }): Promise<{ models: Record<string, unknown>; tools: Record<string, unknown> }>;
}
