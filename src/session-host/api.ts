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

/** One part of a message. Binary travels by reference, never inline. */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; path: string; mimeType: string };

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
}
