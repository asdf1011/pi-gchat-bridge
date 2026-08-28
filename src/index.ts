import http from "node:http";

import { AgentRouter, type ModelInfo, type SessionInfo, type SwitchModelResult } from "./agent-sessions.js";
import {
  confirmCard,
  defaultModelCard,
  defaultModelConfirmCard,
  errorCard,
  escapeHtml,
  helpCard,
  modelConfirmCard,
  modelPickerCard,
  pickerCard,
  sessionStatsCard,
  statusCard,
} from "./cards.js";
import { ChatClient } from "./chat-client.js";
import { loadConfig } from "./config.js";
import {
  MARKER_DELAY_MS,
  MODEL_ACTION,
  PATCH_DEBOUNCE_MS,
  RESUME_ACTION,
  SET_DEFAULT_MODEL_ACTION,
  THINKING_TEXT,
  TOOL_STATUS_DELAY_MS,
} from "./constants.js";
import { PubSubReceiver } from "./pubsub-receiver.js";
import type { HandleResult, MessageReceiver } from "./receiver.js";
import { StateStore } from "./state.js";
import { markers, ReplyStream } from "./stream.js";
import type { IncomingMessage } from "./types.js";
import { logger } from "./logger.js";

/** Extract the picked value from a CARD_CLICKED event's form inputs.
 *  Selection values only arrive when a BUTTON submits the form — a dropdown's
 *  onChangeAction fires an event with no value. Widget values appear either as
 *  `input.selectionInput.selectedValues[]` / `input.stringInputs.value[]`
 *  (action.formInputs, legacy) or flattened under common.formInputs (new). */
function selectedValue(incoming: IncomingMessage): string | undefined {
  const formInputs = incoming.action?.formInputs;
  if (formInputs) {
    for (const key of Object.keys(formInputs)) {
      const widget = formInputs[key];
      const input = widget?.input ?? widget;
      const value =
        input?.selectionInput?.selectedValues?.[0] ??
        input?.stringInputs?.value?.[0];
      if (value) return value;
    }
  }
  return undefined;
}

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

    // --- Interactive card events (dropdown selection, buttons) ---
    if (incoming.eventType === "CARD_CLICKED") {
      if (incoming.action?.actionMethodName === MODEL_ACTION) {
        const picked = selectedValue(incoming);
        if (!picked) {
          await client
            .updateMessageCards(incoming.message.name, modelConfirmCard({ ok: false, label: "", error: "No model was selected." }), "No model selected.")
            .catch((err) => logger.error("[chat] card update failed:", (err as Error).message));
          return "ok";
        }
        const [provider, modelId] = picked.split("|");
        // /model only switches an EXISTING conversation's model (with no
        // conversation it changes the default instead), so no new-conversation
        // notice is posted here — the card is the confirmation.
        const result = await router.switchModel(actionKey, provider ?? "", modelId ?? "");
        if (result.error === "busy") {
          logger.info(`[chat] ${display}: busy, deferring model switch`);
          return "busy"; // leave unacked; retried once the session frees up
        }
        await client
          .updateMessageCards(incoming.message.name, modelConfirmCard(result), `Model switch: ${result.ok ? result.label : result.error}`)
          .catch((err) => logger.error("[chat] card update failed:", (err as Error).message));
        logger.info(`[chat] ${display}: model switch ${result.ok ? "-> " + result.label : "failed: " + result.error}`);
        return "ok";
      }
      if (incoming.action?.actionMethodName === SET_DEFAULT_MODEL_ACTION) {
        const picked = selectedValue(incoming);
        if (!picked) {
          await client
            .updateMessageCards(incoming.message.name, defaultModelConfirmCard({ ok: false, label: "", error: "No model was selected." }), "No model selected.")
            .catch((err) => logger.error("[chat] card update failed:", (err as Error).message));
          return "ok";
        }
        const [provider, modelId] = picked.split("|");
        const result = await router.setDefaultModel(provider ?? "", modelId ?? "");
        await client
          .updateMessageCards(incoming.message.name, defaultModelConfirmCard(result), `Default model: ${result.ok ? result.label : result.error}`)
          .catch((err) => logger.error("[chat] card update failed:", (err as Error).message));
        logger.info(`[chat] ${display}: default model ${result.ok ? "-> " + result.label : "failed: " + result.error}`);
        return "ok";
      }
      if (incoming.action?.actionMethodName === RESUME_ACTION) {
        const picked = selectedValue(incoming);
        if (!picked) {
          await client
            .updateMessageCards(incoming.message.name, errorCard("No session was selected."), "No session selected.")
            .catch((err) => logger.error("[chat] card update failed:", (err as Error).message));
          return "ok";
        }
        const label = await router.switchSession(actionKey, picked);
        if (label === null) {
          logger.info(`[chat] ${display}: busy, deferring session switch`);
          return "busy"; // leave unacked; redelivered once the session frees up
        }
        await client
          .updateMessageCards(incoming.message.name, confirmCard(label), `Resumed session ${label}.`)
          .catch((err) => logger.error("[chat] card update failed:", (err as Error).message));
        logger.info(`[chat] ${display}: resumed session ${label}`);
        return "ok";
      }
      logger.info(`[chat] ${display}: unhandled card action`);
      return "ok";
    }

    // --- Built-in commands (handled by the bridge, not sent to pi) ---
    // Commands are explicit control: they interrupt any running reply first.
    if (/^\/model\b/.test(text.trim())) {
      if (router.isBusy(sessionKey)) await router.interrupt(sessionKey);
      const models = await router.listModels();
      if (models.length === 0) {
        await client.sendMessage(spaceName, "No models configured.", threadName);
        return "ok";
      }
      // With a conversation, /model switches THIS conversation's model. With no
      // conversation yet, it just changes the global default for NEW
      // conversations — starting one here strands the pick on a thread nobody
      // replies in (and a reply there opens a fresh default-model session).
      if (router.hasSession(sessionKey)) {
        const current = await router.currentModel(sessionKey);
        await client.createCardMessage(spaceName, modelPickerCard(models, sessionKey, current), "Choose a backend model.", threadName);
        logger.info(`[chat] ${display}: posted model picker (${models.length} models)`);
      } else {
        await client.createCardMessage(spaceName, defaultModelCard(models, router.defaultModel()), "Change the default model for new conversations.", threadName);
        logger.info(`[chat] ${display}: no conversation — posted default-model picker (${models.length} models)`);
      }
      return "ok";
    }
    if (/^\/status\b/.test(text.trim())) {
      // Read-only: no interrupt (doesn't disturb an in-flight reply). Model,
      // context occupancy, and token totals are all read from the session file
      // (or the in-memory session when open), so no session needs opening.
      const model = await router.currentModel(sessionKey);
      const context = await router.sessionContextUsage(sessionKey);
      const usage = await router.sessionUsage(sessionKey);
      await client.createCardMessage(
        spaceName,
        statusCard({
          model,
          defaultModel: router.defaultModel(),
          context,
          usage,
        }),
        "Status.",
        threadName,
      );
      logger.info(`[chat] ${display}: posted status card`);
      return "ok";
    }
    if (/^\/session\b/.test(text.trim())) {
      if (router.isBusy(sessionKey)) await router.interrupt(sessionKey);
      const stats = router.sessionStats(sessionKey);
      if (!stats) {
        await client.sendMessage(spaceName, "No session for this conversation yet — send a message first.", threadName);
        return "ok";
      }
      const name = await router.getSessionName(sessionKey);
      await client.createCardMessage(spaceName, sessionStatsCard(stats, name), "Session stats.", threadName);
      logger.info(`[chat] ${display}: posted session stats (${stats.totalMessages} messages, $${stats.cost.toFixed(4)})`);
      return "ok";
    }
    if (/^\/name\b/.test(text.trim())) {
      if (router.isBusy(sessionKey)) await router.interrupt(sessionKey);
      const arg = text.trim().replace(/^\/name\s*/, "").trim();
      if (!arg) {
        const current = await router.getSessionName(sessionKey);
        await client.sendMessage(
          spaceName,
          current
            ? `This conversation's session is named: **${escapeHtml(current)}**`
            : "This conversation has no session name yet. Use **/name &lt;name&gt;** to set one.",
          threadName,
        );
        logger.info(`[chat] ${display}: queried session name (${current ?? "none"})`);
        return "ok";
      }
      const set = router.setSessionName(sessionKey, arg);
      if (set === null) {
        await client.sendMessage(
          spaceName,
          "No session for this conversation yet — send a message first, then use /name.",
          threadName,
        );
        return "ok";
      }
      await client.sendMessage(spaceName, `Session named: **${escapeHtml(arg)}**`, threadName);
      logger.info(`[chat] ${display}: named session -> ${arg}`);
      return "ok";
    }
    if (/^\/help\b/.test(text.trim())) {
      if (router.isBusy(sessionKey)) await router.interrupt(sessionKey);
      await client.createCardMessage(spaceName, helpCard(), "Available commands: /resume, /sessions, /list, /help.", threadName);
      logger.info(`[chat] ${display}: posted help card`);
      return "ok";
    }
    if (/^\/(resume|sessions|list)\b/.test(text.trim())) {
      if (router.isBusy(sessionKey)) await router.interrupt(sessionKey);
      const sessions = await router.listSessions();
      if (sessions.length === 0) {
        await client.sendMessage(spaceName, "No sessions found yet.", threadName);
        return "ok";
      }
      await client.createCardMessage(spaceName, pickerCard(sessions, sessionKey), "Choose a session to resume.", threadName);
      logger.info(`[chat] ${display}: posted session picker (${sessions.length} sessions)`);
      return "ok";
    }

    // --- Image attachments: download pasted images so they reach the LLM as
    // multimodal input (pi's `images` content blocks, base64). Failures are
    // non-fatal — the text still goes through. ---
    let images: { type: "image"; data: string; mimeType: string }[] | undefined;
    let hadAttachments = (incoming.message.attachments?.length ?? 0) > 0;
    const tryAttachments = async (atts: import("./types.js").ChatAttachment[]): Promise<void> => {
      for (const att of atts) {
        const img = await client.downloadAttachment(att);
        if (img) (images ??= []).push({ type: "image", data: img.data, mimeType: img.mimeType });
      }
    };
    if (incoming.message.attachments?.length) {
      await tryAttachments(incoming.message.attachments);
    }
    // Event carried no attachment data — fetch the Message resource and retry
    // (the event payload's attachment shape differs by source; messages.get is
    // the authoritative one).
    if (!images?.length && incoming.message.name) {
      const fetched = await client.fetchMessageAttachments(incoming.message.name);
      if (fetched.length > 0) {
        hadAttachments = true;
        await tryAttachments(fetched);
      }
    }
    if (images?.length) {
      logger.info(`[chat] ${display}: ${images.length} image(s) attached${text ? ` with text "${text.slice(0, 60)}"` : ""}`);
    } else if (hadAttachments) {
      logger.info(`[chat] ${display}: attachments present but no image could be downloaded`);
    }
    // Nothing usable (no text, no image): tell the user instead of prompting
    // the LLM with an empty message.
    if (!text.trim() && !images?.length) {
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
        images,
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
