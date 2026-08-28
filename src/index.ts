import http from "node:http";

import { AgentRouter } from "./agent-sessions.js";
import { ChatClient, collectImageAttachments } from "./chat-client.js";
import { runCommand } from "./commands.js";
import { loadConfig } from "./config.js";
import { PubSubReceiver } from "./pubsub-receiver.js";
import type { HandleResult, MessageReceiver } from "./receiver.js";
import { StateStore } from "./state.js";
import { markers, ReplyStream } from "./stream.js";
import type { IncomingMessage } from "./types.js";
import { logger } from "./logger.js";

async function main(): Promise<void> {
  const config = loadConfig();
  logger.info(`[bridge] cwd=${config.cwd}`);

  if (config.healthPort > 0) {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    });
    server.listen(config.healthPort, "0.0.0.0", () => {
      logger.info(`[health] listening on :${config.healthPort}`);
    });
  }

  const client = new ChatClient(config.serviceAccountPath);
  const state = new StateStore(config.stateFile);
  const router = await AgentRouter.create(
    config.cwd,
    config.sessionsDir,
    config.stallTimeoutMs,
    config.watchdogIntervalMs,
    config.steerWaitMs,
    config.sessionIdleMs,
    state,
  );

  /**
   * Handle one incoming Chat message with a live, in-place streaming reply:
   * post a "Thinking…" placeholder, patch it with streamed text as pi speaks,
   * then finalize (replace with the full answer, or delete if empty).
   */
  const handler = async (incoming: IncomingMessage): Promise<HandleResult> => {
    const spaceName = incoming.space.name;
    const display = incoming.space.displayName ?? spaceName;
    const text = incoming.message.text ?? "";
    const threadName = incoming.message.threadName;
    const threadKey = incoming.message.threadKey;
    // Conversations are keyed per thread (app-chosen threadKey wins when
    // present), so parallel threads never block each other (space is the
    // fallback for non-threaded DMs).
    const sessionKey = AgentRouter.keyFor(spaceName, threadName, threadKey);
    // CARD_CLICKED events often omit the message's thread, which would make the
    // computed sessionKey fall back to the space. The picker card's button
    // carries the session key it was created for — prefer it when present.
    const actionKey =
      incoming.action?.parameters?.find((p) => p.key === "session")?.value ?? sessionKey;
    logger.info(
      `[chat] ${display} [${incoming.message.name ?? "?"}]: ${incoming.eventType === "CARD_CLICKED" ? `card:${incoming.action?.actionMethodName}` : text.slice(0, 120)}`,
    );

    // Bridge commands (cards + slash) are handled separately; a non-command
    // falls through to a normal pi prompt below.
    const handled = await runCommand({
      client,
      router,
      incoming,
      sessionKey,
      actionKey,
      spaceName,
      threadName,
      display,
      text,
    });
    if (handled !== null) return handled;

    // --- Image attachments: download pasted images so they reach the LLM as
    // multimodal input (pi's `images` content blocks, base64). Failures are
    // non-fatal — the text still goes through. ---
    const { images, hadAttachments } = await collectImageAttachments(client, incoming);
    if (images.length) {
      logger.info(`[chat] ${display}: ${images.length} image(s) attached${text ? ` with text "${text.slice(0, 60)}"` : ""}`);
    } else if (hadAttachments) {
      logger.info(`[chat] ${display}: attachments present but no image could be downloaded`);
    }
    // Nothing usable (no text, no image): tell the user instead of prompting
    // the LLM with an empty message.
    if (!text.trim() && !images.length) {
      await client
        .sendMessage(spaceName, "I got your message but couldn't read the attachment — only images are supported.", threadName)
        .catch((err) => logger.error("[chat] attachment notice failed:", (err as Error).message));
      return "ok";
    }

    // --- Plain message while the conversation is streaming: steer it into the
    // running turn (interleaved) with a bounded tool wait. If the in-flight
    // tool finishes within steerWaitMs its result lands and the steer is
    // delivered right after; otherwise abort + redirect so the interjection
    // is never stuck behind a long tool call. ---
    if (router.isBusy(sessionKey)) {
      const outcome = await router.redirect(sessionKey, text, images);
      if (outcome === "steered") {
        logger.info(`[chat] ${display}: steered into running turn`);
        // The reply now covers the steer too, so move its placeholder below the
        // steering message — otherwise the response renders above the steer.
        await markers
          .get(sessionKey)
          ?.relocate()
          .catch((err) => logger.error("[chat] marker relocate failed:", (err as Error).message));
        return "ok";
      }
      if (outcome === "redirected") {
        logger.info(`[chat] ${display}: tool overrun — aborted, redirecting`);
        // Fall through: the new message becomes a normal prompt.
      }
      // not-busy: race — fall through to a normal prompt below.
    }
    const stream = new ReplyStream(client, spaceName, threadName, display);
    stream.register(sessionKey);

    try {
      const reply = await router.handleMessage(
        sessionKey,
        spaceName,
        text,
        images.length > 0 ? images : undefined,
        (delta) => stream.onDelta(delta),
        (toolName, args) => stream.showTool(toolName, args),
        () => stream.clearTool(),
      );

      if (reply === null) {
        // Session became busy between the check and the prompt — drop the marker.
        await stream.abandon();
        logger.info(`[chat] ${display}: busy, deferred`);
        return "busy";
      }

      const final = reply.trim();
      if (!final) {
        await stream.abandon();
        logger.info(`[chat] ${display}: empty reply, marker removed`);
        return "ok";
      }

      await stream.finish(final);
      return "ok";
    } catch (err) {
      const aborted = (err as Error)?.name === "AbortError";
      logger.error(`[chat] ${display}: handler ${aborted ? "interrupted (implicit stop)" : "error"}:`, (err as Error).message);
      await stream.onError(aborted);
      return "ok"; // ack so a poison message doesn't redeliver forever
    } finally {
      // Only the handler that owns the current marker may unregister it.
      stream.unregister(sessionKey);
    }
  };

  const receiver: MessageReceiver = new PubSubReceiver(
    config.serviceAccountPath,
    config.pubsubSubscription,
    state,
    config.allowedSpaces,
    config.allowedUsers,
  );

  const shutdown = async (): Promise<void> => {
    logger.info("[bridge] shutting down...");
    await receiver.stop();
    router.dispose();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await receiver.start(handler);
  logger.info("[bridge] running. Ctrl+C to stop.");
}

main().catch((err) => {
  logger.error("[bridge] fatal:", err);
  process.exit(1);
});
