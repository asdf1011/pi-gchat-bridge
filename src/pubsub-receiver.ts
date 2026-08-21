import { ServiceAccountAuth } from "./auth.js";
import type { HandleResult, MessageReceiver } from "./receiver.js";
import type { StateStore } from "./state.js";
import type { ChatAttachment, ChatMessage, ChatSpace, IncomingMessage } from "./types.js";

const PUBSUB_API = "https://pubsub.googleapis.com/v1";
const PUBSUB_SCOPE = "https://www.googleapis.com/auth/pubsub";
/** How long a single blocking pull may wait for messages before re-issuing. */
const PULL_TIMEOUT_MS = 60_000;
/** Brief pause after a pull returns empty (timeout/error) before re-issuing. */
const PULL_RETRY_MS = 1_000;

interface ReceivedMessage {
  ackId: string;
  message?: {
    data?: string; // base64
    messageId?: string;
    publishTime?: string;
  };
}

interface ChatEvent {
  type: string;
  eventTime?: string;
  space?: { name?: string; displayName?: string; type?: string };
  message?: {
    name?: string;
    text?: string;
    argumentText?: string;
    createTime?: string;
    sender?: { name?: string; type?: string };
    thread?: { name?: string; threadKey?: string };
    attachments?: ChatAttachment[];
    /** Singular form used by the Message resource / some event payloads. */
    attachment?: ChatAttachment[];
    slashCommand?: { commandId?: string; commandName?: string };
  };
  appCommandMetadata?: { type?: string; commandId?: string };
  action?: {
    actionMethodName?: string;
    parameters?: { key: string; value: string }[];
    formInputs?: Record<string, { input?: { stringInputs?: { value?: string[] }; selectionInput?: { selectedValues?: string[] } } }>;
  };
  /** Newer CARD_CLICKED payloads carry form values here (button submits). */
  common?: {
    formInputs?: Record<string, { stringInputs?: { value?: string[] }; selectionInput?: { selectedValues?: string[] } }>;
  };
}

/**
 * Pub/Sub receiver: pulls Chat events from a Cloud Pub/Sub pull subscription.
 * No public endpoint required; works for DMs AND spaces (unlike polling).
 *
 * Uses the Pub/Sub REST API with our own service-account JWT — deliberately
 * not @google-cloud/pubsub, which pulls in the same broken node-fetch v2 auth
 * stack we removed from the Chat client.
 */
export class PubSubReceiver implements MessageReceiver {
  readonly name = "pubsub";
  private auth: ServiceAccountAuth;
  private running = false;
  /**
   * Message names currently being handled. Closes the dedupe window: without
   * this, a redelivered copy of a message that is still streaming (not yet
   * marked processed, not yet acked) passes the `processed` check and gets
   * processed twice.
   */
  private processing = new Set<string>();
  /** True while a pull+handle cycle is running; prevents overlapping pulls. */
  private pulling = false;

  constructor(
    serviceAccountPath: string,
    /** Full subscription name: projects/{project}/subscriptions/{subscription} */
    private subscription: string,
    private state: StateStore,
  ) {
    this.auth = new ServiceAccountAuth(serviceAccountPath, [PUBSUB_SCOPE]);
  }

  async start(handler: (message: IncomingMessage) => Promise<HandleResult>): Promise<void> {
    if (!this.subscription) {
      throw new Error("PUBSUB_SUBSCRIPTION is required when RECEIVER=pubsub");
    }
    // Health check: a pull round-trip (GET on the subscription needs the
    // Viewer role in some setups; pull only needs Subscriber's consume).
    // returnImmediately keeps this probe fast — it only checks auth/reachability.
    await this.auth.request(
      "POST",
      `${PUBSUB_API}/${this.subscription}:pull`,
      JSON.stringify({ maxMessages: 1, returnImmediately: true }),
      PULL_TIMEOUT_MS,
    );
    console.log(`[pubsub] connected to ${this.subscription}`);

    this.running = true;
    // Long-lived pull loop: one blocking pull in flight at a time. Pub/Sub
    // holds the request open until a message arrives (returnImmediately is
    // false), so messages are delivered immediately — no polling interval.
    // When a pull returns (messages, or the idle timeout), the next pull is
    // issued right away.
    void this.pullLoop(handler).catch((err) =>
      console.error("[pubsub] pull loop failed:", (err as Error).message),
    );
  }

  /** Blocking pull loop: re-issue the next pull as soon as the previous one returns. */
  private async pullLoop(handler: (message: IncomingMessage) => Promise<HandleResult>): Promise<void> {
    while (this.running) {
      const received = await this.pullOnce(handler);
      if (!this.running) break;
      if (received === 0) {
        // Empty only happens on timeout/error — brief pause so a persistent
        // failure can't spin the loop into a hot retry.
        await new Promise((r) => setTimeout(r, PULL_RETRY_MS));
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false; // pullLoop exits after the current pull returns
    this.state.save();
  }

  private async pullOnce(handler: (message: IncomingMessage) => Promise<HandleResult>): Promise<number> {
    if (!this.running || this.pulling) return 0;
    this.pulling = true;
    let received: ReceivedMessage[] = [];
    try {
      const data = (await this.auth.request(
        "POST",
        `${PUBSUB_API}/${this.subscription}:pull`,
        // returnImmediately=false: block until a message is available, so
        // there's no polling — new messages arrive the moment they're published.
        JSON.stringify({ maxMessages: 10, returnImmediately: false }),
        PULL_TIMEOUT_MS,
      )) as { receivedMessages?: ReceivedMessage[] };
      received = data.receivedMessages ?? [];
    } catch (err) {
      console.error("[pubsub] pull failed:", (err as Error).message);
    } finally {
      // Release immediately: handlers below run CONCURRENTLY, and the next
      // pull may start while they are still streaming. Dedupe claims keep
      // redeliveries safe.
      this.pulling = false;
    }

    // Parallel dispatch: each message is handled independently and acked on
    // its own, so a long reply in one thread never blocks another thread.
    for (const receivedMessage of received) {
      void this.handleOne(receivedMessage, handler);
    }
    return received.length;
  }

  /** Handle one Pub/Sub message: dedupe, claim, run the handler, ack or leave unacked. */
  private async handleOne(
    receivedMessage: ReceivedMessage,
    handler: (message: IncomingMessage) => Promise<HandleResult>,
  ): Promise<void> {
    try {
      const event = JSON.parse(
        Buffer.from(receivedMessage.message?.data ?? "", "base64").toString("utf8"),
      ) as ChatEvent;
      const incoming = this.mapEvent(event);
      if (!incoming) {
        await this.ack([receivedMessage.ackId]);
        return;
      }

      // Dedupe by Pub/Sub messageId when present (unique per publish, so
      // repeated clicks on the same card message each process once); fall
      // back to the Chat message name.
      incoming.message.messageId = receivedMessage.message?.messageId;
      const dedupeKey = incoming.message.messageId ?? incoming.message.name;
      const spaceState = this.state.getSpaceState(incoming.space.name);
      // NOTE: check + claim are synchronous (no await between), so concurrent
      // handleOne calls can't both claim the same message.
      const alreadyHandled =
        spaceState.processed.includes(dedupeKey) || this.processing.has(dedupeKey);
      if (alreadyHandled) {
        await this.ack([receivedMessage.ackId]);
        return;
      }
      this.processing.add(dedupeKey);
      try {
        const result = await handler(incoming);
        if (result === "busy") {
          // Session is busy: leave the message unacked so Pub/Sub redelivers
          // it later (acts as the per-thread queue). Don't mark processed.
          console.log(`[pubsub] ${incoming.space.name}: busy, leaving unacked`);
          return;
        }
        this.state.markProcessed(incoming.space.name, dedupeKey, incoming.message.createTime);
        // Persist before acking so a redelivered message stays deduped even if
        // the ack below fails or the process restarts.
        this.state.save();
        await this.ack([receivedMessage.ackId]);
      } catch (err) {
        // Handler crashed mid-stream: release the claim and stay unacked so
        // Pub/Sub redelivers and we retry.
        console.error("[pubsub] handler failed, leaving unacked for redelivery:", err);
      } finally {
        this.processing.delete(dedupeKey);
      }
    } catch (err) {
      console.error("[pubsub] event failed, leaving unacked for redelivery:", err);
    }
  }

  private async ack(ackIds: string[]): Promise<void> {
    if (ackIds.length === 0) return;
    try {
      await this.auth.request(
        "POST",
        `${PUBSUB_API}/${this.subscription}:acknowledge`,
        JSON.stringify({ ackIds }),
      );
    } catch (err) {
      console.error("[pubsub] ack failed:", (err as Error).message);
    }
  }

  /** Map a ChatEvent payload to an IncomingMessage, or null to ignore. */
  private mapEvent(event: ChatEvent): IncomingMessage | null {
    const space = event.space;
    const message = event.message;
    if (!space?.name || !message?.name) return null;

    if (event.type === "APP_COMMAND") {
      // A registered Chat app command (slash command from the "/" menu).
      // Synthesize the command text so the same bridge command routing applies.
      const slash = message.slashCommand;
      const text =
        message.text ||
        (slash?.commandName
          ? `/${slash.commandName}${message.argumentText ? ` ${message.argumentText}` : ""}`
          : "");
      if (!text) return null;
      return {
        eventType: "APP_COMMAND",
        space: {
          name: space.name,
          displayName: space.displayName ?? undefined,
          type: space.type as ChatSpace["type"],
        },
        message: {
          name: message.name,
          text,
          threadName: message.thread?.name,
          threadKey: message.thread?.threadKey,
          senderType: "HUMAN",
        },
      };
    }

    if (event.type === "CARD_CLICKED") {
      // Debug: dump the raw payload (formInputs shape varies by widget/version).
      console.log(
        `[pubsub] CARD_CLICKED action: ${JSON.stringify(event.action)} common: ${JSON.stringify(event.common)}`,
      );
      // Interactive card event (dropdown/button). No text required. The widget
      // values arrive via common.formInputs (new) or action.formInputs (legacy)
      // — merge both so selectedValue can read either.
      return {
        eventType: "CARD_CLICKED",
        space: {
          name: space.name,
          displayName: space.displayName ?? undefined,
          type: space.type as ChatSpace["type"],
        },
        message: {
          name: message.name,
          threadName: message.thread?.name,
          threadKey: message.thread?.threadKey,
        },
        action: {
          actionMethodName: event.action?.actionMethodName,
          parameters: event.action?.parameters,
          formInputs: {
            ...(event.common?.formInputs ?? {}),
            ...(event.action?.formInputs ?? {}),
          },
        },
      };
    }

    if (event.type !== "MESSAGE") return null; // ignore ADDED_TO_SPACE / REMOVED / etc.
    if (!message.name) return null;
    if (message.sender?.type === "BOT") return null; // never echo the bot's own messages
    // Keep ALL attachments — the event payload carries only partial metadata
    // (its shape differs by source), so image detection happens at download
    // time (contentType / extension / Attachment-resource fetch), not here.
    const attachments = message.attachments ?? [];
    // Image-only messages (pasted screenshot, no text) are valid input — don't
    // drop them just because `text` is empty.
    if (!message.text && attachments.length === 0) return null;
    if (attachments.length > 0) {
      // Debug: learn the exact attachment shape Google sends in events.
      console.log(`[pubsub] ${space.name}: message ${message.name} has ${attachments.length} attachment(s): ${JSON.stringify(attachments)}`);
    }

    const chatMessage: ChatMessage = {
      name: message.name,
      text: message.text ?? "",
      attachments,
      createTime: message.createTime,
      senderName: message.sender?.name,
      senderType: message.sender?.type as ChatMessage["senderType"],
      threadName: message.thread?.name,
      threadKey: message.thread?.threadKey,
    };
    const chatSpace: ChatSpace = {
      name: space.name,
      displayName: space.displayName ?? undefined,
      type: space.type as ChatSpace["type"],
    };
    return { eventType: "MESSAGE", space: chatSpace, message: chatMessage };
  }
}
