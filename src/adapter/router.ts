/**
 * Routing: a Chat message becomes a submission on the right conversation.
 *
 * This replaces `AgentRouter.handleMessage()` and, with it, three things the old
 * bridge maintained by hand:
 *
 *   - **Deduplication** (`state.ts`'s `processed` list). Google Chat delivery is
 *     at-least-once — Pub/Sub redelivers, and the bridge used to remember message
 *     names to avoid answering twice. The Chat message resource name is now the
 *     `requestId`, and the host returns the same submission for a repeated one
 *     instead of running again.
 *   - **The steer queue** (`pendingSteers`, `toolsInFlight`, `steerWaitMs`).
 *     `whenBusy: "steer"` places a message after the current tool round and joins
 *     the running work, which is exactly what the old queue emulated.
 *   - **Busy bookkeeping.** Nothing has to be tracked: a message either starts a
 *     run or steers the one in progress.
 *
 * Deliberately thin, and free of Chat API types and of the harness: the sink
 * paints, `stream.ts` handles Chat's rendering limits, and this file only
 * decides what to submit and under which name.
 */
import type { PiImage } from "../session-file.js";
import type { ContentPart, NamedConversation, SessionHost } from "../session-host/api.js";

/** An image as Google Chat gives it to us: base64 data plus its media type. */
export type IncomingImage = PiImage;

export interface IncomingChatMessage {
  /** `keyFor(space, thread, threadKey)` — the name the host knows it by. */
  chatKey: string;
  /** Google Chat resource name of the message; used as the `requestId`. */
  messageName: string;
  text: string;
  images?: readonly IncomingImage[];
}

/**
 * The message content for the host.
 *
 * A bare string when there are no images keeps the transcript readable in
 * `entries`; with images it becomes content blocks, which is what the model
 * sees. Chat hands the bytes over already base64-encoded, so they travel inline:
 * this is one payload per message, not a repeated frame.
 */
export function buildContent(text: string, images?: readonly IncomingImage[]): ContentPart[] | string {
  if (!images || images.length === 0) return text;
  return [
    ...(text ? [{ type: "text" as const, text }] : []),
    ...images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
  ];
}

/** A notification for the transcript: a notice the model reads later, no run. */
export function noticeEntry(text: string, at: number = Date.now()): {
  kind: string;
  data: unknown;
  model: readonly unknown[];
} {
  return {
    kind: "app.notice",
    data: { text, at },
    model: [{ role: "user", content: `[notification] ${text}`, timestamp: at }],
  };
}

export interface DeliveredTurn {
  conversationId: number;
  submissionId: number;
}

/** The conversation a Chat key talks to, created on first use. */
export interface RouterDefaults {
  model: { provider: string; modelId: string };
  thinkingLevel?: string;
}

export class DurableRouter {
  constructor(
    private readonly seam: SessionHost,
    private readonly defaults: RouterDefaults,
  ) {}

  /** Submit one Chat message, returning what the caller needs to watch it. */
  async deliver(message: IncomingChatMessage): Promise<DeliveredTurn> {
    const conversation = await this.conversationFor(message.chatKey, { create: true });
    const result = await this.seam.submit(conversation.conversationId, {
      requestId: message.messageName,
      origin: "gchat",
      content: buildContent(message.text, message.images),
      // Unconditional on purpose: when the conversation is idle this simply
      // starts a run, so there is no separate "is it busy?" decision to get
      // wrong (and no race between checking and submitting).
      whenBusy: "steer",
    });
    if ("error" in result) throw new Error(result.error);
    return { conversationId: conversation.conversationId, submissionId: result.submissionId };
  }

  /** Append a notification to a conversation without asking the model anything. */
  async notify(chatKey: string, text: string): Promise<void> {
    const conversation = await this.conversationFor(chatKey, { create: true });
    await this.seam.write(conversation.conversationId, noticeEntry(text));
  }

  /** The conversation a key currently points at; `create` starts one if absent. */
  async conversationFor(
    chatKey: string,
    options: { create?: boolean } = {},
  ): Promise<NamedConversation> {
    if (options.create) {
      return this.seam.getOrCreate(chatKey, {
        model: this.defaults.model,
        ...(this.defaults.thinkingLevel === undefined
          ? {}
          : { thinkingLevel: this.defaults.thinkingLevel }),
      });
    }
    const existing = await this.seam.resolve(chatKey);
    if (!existing) throw new Error(`no conversation for ${chatKey}`);
    return existing;
  }
}
