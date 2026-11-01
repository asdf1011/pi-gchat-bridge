/**
 * Routing: a Chat message becomes a submission on the right conversation.
 *
 * This replaces `AgentRouter.handleMessage()` and, with it, three things the old
 * bridge maintained by hand:
 *
 *   - **Deduplication** (`state.ts`'s `processed` list). Google Chat delivery is
 *     at-least-once — Pub/Sub redelivers, and the bridge used to remember message
 *     names to avoid answering twice. The Chat message resource name is now the
 *     `requestId`, and pi-durable makes a repeated `requestId` return the same
 *     submission instead of running again.
 *   - **The steer queue** (`pendingSteers`, `toolsInFlight`, `steerWaitMs`).
 *     `whenBusy: "steer"` places a message after the current tool round and joins
 *     the running work, which is exactly what the old queue emulated, including
 *     when idle: pi-durable ignores `whenBusy` unless a run is in progress.
 *   - **Busy bookkeeping.** Nothing has to be tracked: a message either starts a
 *     run or steers the one in progress.
 *
 * Deliberately thin, and free of Chat API types: the sink paints, `stream.ts`
 * handles Chat's rendering limits, and this file only decides what to submit.
 */
import type { Context } from "@earendil-works/chord";
import type {
  AgentState,
  Conversation,
  ConversationId,
  Submission,
  SubmissionDraft,
  UserInput,
} from "@earendil-works/pi-durable";

import type { PiImage } from "../session-file.js";
import type { BoundConversation, BridgeHost } from "../durable/host.js";

/** An image as Google Chat gives it to us: base64 data plus its media type. */
export type IncomingImage = PiImage;

export interface IncomingChatMessage {
  /** `keyFor(space, thread, threadKey)` — the bindings document's key. */
  chatKey: string;
  /** Google Chat resource name of the message; used as the `requestId`. */
  messageName: string;
  text: string;
  images?: readonly IncomingImage[];
}

/**
 * The message content for pi-durable.
 *
 * A bare string when there are no images keeps the transcript readable in
 * `entries` (and matches what the model has always seen); with images it becomes
 * pi-ai content blocks, which is what `UserInput` is.
 */
export function buildContent(text: string, images?: readonly IncomingImage[]): UserInput {
  if (!images || images.length === 0) return text;
  return [
    ...(text ? [{ type: "text" as const, text }] : []),
    ...images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
  ];
}

/**
 * The submission for one Chat message.
 *
 * `whenBusy: "steer"` is unconditional on purpose — when the conversation is idle
 * it simply starts a run, so there is no separate "is it busy?" decision to get
 * wrong (and no race between checking and submitting).
 */
export function messageSubmission(message: IncomingChatMessage): SubmissionDraft {
  return {
    type: "input",
    content: buildContent(message.text, message.images),
    requestId: message.messageName,
    whenBusy: "steer",
  };
}

/**
 * A notification for the transcript: a notice the model reads later, without
 * answering now.
 *
 * `cron` posts into Chat through `/notify`, and the old bridge also seeded the
 * message into the session so that a later reply continued with context. A
 * pi-durable *write* with model content is the same thing: appended at the next
 * boundary, visible to the model, never a run of its own.
 */
export function noticeSubmission(text: string, at: number = Date.now()): SubmissionDraft {
  return {
    type: "write",
    entry: {
      kind: "app.notice",
      data: { text, at },
      model: [{ role: "user", content: `[notification] ${text}`, timestamp: at }],
    },
  } as SubmissionDraft;
}

export interface SubmitResult {
  bound: BoundConversation;
  submission: Submission;
}

export class DurableRouter {
  constructor(
    private readonly host: BridgeHost,
    private readonly defaults: {
      model: { provider: string; modelId: string };
      thinkingLevel?: AgentState["thinkingLevel"];
    },
  ) {}

  /** Submit one Chat message and return the submission the caller can wait on. */
  async deliver(message: IncomingChatMessage): Promise<SubmitResult> {
    const bound = await this.host.conversationFor(message.chatKey, {
      model: this.defaults.model,
      ...(this.defaults.thinkingLevel ? { thinkingLevel: this.defaults.thinkingLevel } : {}),
    });
    const submission = await bound.conversation.submit(messageSubmission(message), this.context());
    return { bound, submission };
  }

  /** Append a notification to a conversation without asking the model anything. */
  async notify(chatKey: string, text: string): Promise<void> {
    const bound = await this.host.conversationFor(chatKey, {
      model: this.defaults.model,
      ...(this.defaults.thinkingLevel ? { thinkingLevel: this.defaults.thinkingLevel } : {}),
    });
    await bound.conversation.submit(noticeSubmission(text), this.context());
  }

  /**
   * Stop whatever the conversation is doing — the `/model`, `/settings` and
   * `/resume` commands interrupt rather than steer, which is the old bridge's
   * behaviour too (`commands.ts` interrupts, plain messages steer).
   */
  async interrupt(chatKey: string): Promise<boolean> {
    const binding = await this.host.bindingFor(chatKey);
    if (!binding) return false;
    const conversation = await this.host.harness.conversation(
      binding.conversationId as ConversationId,
      this.context(),
    );
    if (!conversation) return false;
    await conversation.abort(this.context());
    return true;
  }

  /** The conversation a key currently points at, if any (no creation). */
  async conversationFor(chatKey: string): Promise<Conversation | undefined> {
    const binding = await this.host.bindingFor(chatKey);
    if (!binding) return undefined;
    return this.host.harness.conversation(binding.conversationId as ConversationId, this.context());
  }

  private context(): Context {
    return this.host.context;
  }
}
