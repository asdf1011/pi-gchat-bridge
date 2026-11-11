/**
 * The Chat adapter's message path: one Chat message, one durable submission, one reply.
 *
 * Moved out of `main.ts` unchanged. What it needs is the adapter's own — a client, a router, a name,
 * the seam — and nothing from the store, the artifact origin or `/v1`. That is the test of whether
 * this is really an adapter: it has to work against a *linked* seam, and it does (the deployment has
 * run that way since the settings operations were published).
 */
import { collectImageAttachments } from "../chat-client.js";
import { logger } from "../logger.js";
import { keyFor } from "../session-key.js";
import { runDurableCommand } from "../adapter/commands.js";
import { applyDurableTopicSummary } from "./topic.js";
import { classifyModelFailure, describeModelFailure } from "./model-failure.js";
import type { ChatClient } from "../chat-client.js";
import type { Config } from "../config.js";
import type { DurableRouter } from "../adapter/router.js";
import type { HandleResult } from "../receiver.js";
import type { IncomingMessage } from "../types.js";
import type { SessionHost } from "../session-host/api.js";
import type { StateStore } from "../state.js";
import type { SecretStore } from "../secret-store.js";

/** What the handler needs; all of it the adapter's, none of it the store's. */
export interface ChatHandlerOptions {
  /** The adapter's seam: a link, once the adapter is a separate process. */
  seam: SessionHost;
  config: Config;
  client: ChatClient;
  router: DurableRouter;
  state: StateStore;
  secrets: SecretStore;
}

export type ChatHandler = (incoming: IncomingMessage) => Promise<HandleResult>;

/**
 * One Chat message → one durable submission → one Chat reply.
 *
 * Moved out of `main.ts` unchanged. What it needs is the adapter's own: a options.client, a options.router, a name,
 * and the seam. What it does *not* need is the store, the artifact origin or `/v1` — which is the
 * real test of whether this is an adapter: it has to work against a linked seam.
 */
export function chatHandler(options: ChatHandlerOptions): ChatHandler {
  return async (incoming: IncomingMessage): Promise<HandleResult> => {
    const spaceName = incoming.space.name ?? "";
    const display = incoming.space.displayName ?? spaceName;
    const text = incoming.message.text ?? "";
    const threadName = incoming.message.threadName;
    const threadKey = incoming.message.threadKey;
    // keyFor() is unchanged from the SDK host: threadKey wins, then the thread
    // name, then the space — so a thread stays one conversation across engines.
    const chatKey = keyFor(spaceName, threadName, threadKey);
    const actionKey = incoming.action?.parameters?.find((p) => p.key === "session")?.value ?? chatKey;

    logger.info(
      `[chat] ${display} [${incoming.message.name ?? "?"}]: ${incoming.eventType === "CARD_CLICKED" ? `card:${incoming.action?.actionMethodName}` : text.slice(0, 120)}`,
    );
    // Keying is logged for EVERY event, not just card clicks: in a space the
    // difference between a top-level message (keyed by the space) and a reply in
    // a thread (keyed by the thread) is the intended model, but it is also the
    // one thing that looks like "the bot answered in the wrong conversation".
    // Having both keys in the log turns that from a guess into a lookup.
    logger.info(
      `[chat] ${display}: keying ${incoming.eventType ?? "MESSAGE"} thread=${threadName ?? "(none)"} threadKey=${threadKey ?? "(none)"} chatKey=${chatKey} actionKey=${actionKey}${actionKey === chatKey ? "" : " (differ)"}`,
    );

    const handled = await runDurableCommand({
      client: options.client,
      seam: options.seam,
      router: options.router,
      state: options.state,
      secrets: options.secrets,
      // Falls back to ALLOWED_USERS when SECRET_USERS is unset, so a single-user
      // deployment needs no extra configuration.
      secretUsers: options.config.secretUsers.length > 0 ? options.config.secretUsers : options.config.allowedUsers,
      incoming,
      chatKey,
      actionKey,
      spaceName,
      threadName,
      display,
      text,
    });
    if (handled !== null) return handled;

    const { images, hadAttachments } = await collectImageAttachments(options.client, incoming);
    if (images.length === 0 && !text.trim()) {
      await options.client
        .sendMessage(spaceName, "I got your message but couldn't read the attachment — only images are supported.", threadName)
        .catch((error: unknown) => logger.error("[chat] attachment notice failed:", (error as Error).message));
      return "ok";
    }
    if (images.length) {
      logger.info(`[chat] ${display}: ${images.length} image(s) attached${text ? ` with text "${text.slice(0, 60)}"` : ""}`);
    } else if (hadAttachments) {
      logger.info(`[chat] ${display}: attachments present but no image could be downloaded`);
    }

    // The painter is the mouth for every Chat conversation, so this handler's job is
    // narrower than it was: submit, wait (waiting is what stamps the answer's origin),
    // poke the painter, and say why a turn produced nothing. It never posts an answer,
    // which is why the claim machinery that arbitrated between two posters is gone
    // rather than merely idle.
    try {
      // The delivery is idempotent on the Chat message name, so a Pub/Sub
      // redelivery after a crash finds the same submission instead of asking the
      // model again.
      const delivered = await options.router.deliver({
        chatKey,
        messageName: incoming.message.name,
        text,
        images,
      });
      // No wake: activity carries this now, and the painter hears it from the server like any
      // other subscriber.

      const turnStarted = Date.now();
      const settled = await options.seam.awaitSubmission(delivered.submissionId);
      const turnMs = Date.now() - turnStarted;

      if (settled.status !== "done" || settled.text === "") {
        // A failure here used to log only the status, so "unanswered after 9s"
        // and "unanswered after 154s" were indistinguishable, and the reason
        // pi-durable records (aborted / provider error / ...) was thrown away.
        // Diagnosing a real failure from that took twenty minutes of log
        // archaeology; these four facts make it a single line.
        const reason = settled.status === "unanswered" ? settled.reason : undefined;
        const detail = settled.status === "unanswered" ? settled.detail : undefined;
        // A provider failure gets its own summary in the line, because the raw
        // detail is a JSON envelope and the useful part of it is one field: "402:
        // {\"message\":\"Insufficient Balance\"...}" is a billing problem, and the log
        // should say so rather than leave a reader to parse a payload.
        const failure = classifyModelFailure(reason, detail);
        logger.info(
          `[chat] ${display}: no answer text status=${settled.status}` +
            `${reason ? ` reason=${reason}` : ""}` +
            ` after ${turnMs}ms conversation=${delivered.conversationId}` +
            (failure ? ` failure=${JSON.stringify(describeModelFailure(failure))}` : "") +
            (detail === undefined ? "" : ` detail=${JSON.stringify(detail).slice(0, 300)}`),
        );
        // The notice is written by the host, in `observeFiles`, as an entry stamped
        // with this surface — so it arrives the way an answer does, quoting the prompt,
        // and the same code covers the web page. Posting it here as well would put two
        // notices in the thread for one failed turn.
        return "ok";
      }

      // Detached: a CPU titler can take minutes, and the reply is already
      // delivered. Only fires when /model left a pending card for this thread,
      // so it is free to call on every turn.
      if (options.config.topicSummary) {
        void applyDurableTopicSummary({
          state: options.state,
          seam: options.seam,
          client: options.client,
          chatKey,
          display,
          config: {
            baseUrl: options.config.topicSummaryBaseUrl,
            model: options.config.topicSummaryModel,
            timeoutMs: options.config.topicSummaryTimeoutMs,
            ...(options.config.topicSummaryApiKey ? { apiKey: options.config.topicSummaryApiKey } : {}),
          },
        });
      }
      return "ok";
    } catch (error) {
      const aborted = (error as Error)?.name === "AbortError";
      logger.error(`[chat] ${display}: handler ${aborted ? "interrupted" : "error"}:`, (error as Error).message);
      // Nothing to clean up here any more: the placeholder belongs to the painter, which
      // abandons it when it sees a settled turn with no answer entry.
      return "ok";
    }
    };
}
