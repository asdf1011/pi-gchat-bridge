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
}

export type SubmitResult = { submissionId: number } | { error: string };

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
  info(): HostInfo;

  /** Every conversation the host knows about. */
  list(options?: { signal?: AbortSignal }): Promise<NamedConversation[]>;

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

  /**
   * Claim the right to post one answer into one conversation's adapter view.
   *
   * True for exactly one caller per (name, answerId); a later answer takes the
   * slot, an equal or older one is refused. Entry ids come from one global
   * sequence, so "older" is meaningful — and a stale answer can never post after
   * a newer one, which is the ordering the guard exists for.
   */
  claimAnswer(name: string, answerId: number, options?: { signal?: AbortSignal }): Promise<boolean>;

  /** Give a claim back after a delivery that failed outright. */
  releaseAnswer(name: string, answerId: number, options?: { signal?: AbortSignal }): Promise<void>;

  /** The answer last claimed for a name, for diagnostics. */
  lastPostedAnswer(name: string, options?: { signal?: AbortSignal }): Promise<{ answerId: number; at: number } | undefined>;

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

  /** Stop whatever the conversation is doing. True when something was stopped. */
  abort(conversationId: number, options?: { signal?: AbortSignal }): Promise<boolean>;

  /** Store-wide token and cost totals. */
  usage(options?: { signal?: AbortSignal }): Promise<{ models: Record<string, unknown>; tools: Record<string, unknown> }>;
}
