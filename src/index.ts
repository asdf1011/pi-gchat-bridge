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
import { ChatClient, MAX_MESSAGE_CHARS } from "./chat-client.js";
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
import type { IncomingMessage } from "./types.js";
import { logger } from "./logger.js";

/**
 * Live streaming markers per conversation: the running turn's handler registers
 * its placeholder here so a steering message (a separate handler invocation)
 * can relocate the placeholder BELOW the steering message. Google Chat orders
 * thread messages by creation time, so without relocation the reply — which
 * now covers the steer — would render above the steering text. A placeholder
 * that already shows streamed text is kept in place (frozen) as a record of
 * what was being said; only the continued stream moves below the steer.
 * Entries are removed when the owning handler finishes.
 */
const markers = new Map<string, { owner: object; relocate: () => Promise<void> }>();

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

/** Dropdown + submit button card listing sessions; the button's click carries
 *  the dropdown value in formInputs (dropdown onChangeAction events carry none)
 *  and the session key it was created for (card events omit thread info). */

/** One-line status shown under the stream while a tool is running (e.g. the command).
 *  The placeholder is PATCHed, so it renders legacy Chat syntax only — backtick
 *  monospace is the closest to a code block; the final answer renders real
 *  Markdown. Inner backticks are stripped so the wrap can't break. */
function toolStatusLine(toolName: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const command = typeof a.command === "string" ? a.command.trim().replace(/\s+/g, " ") : "";
  const path = typeof a.path === "string" ? a.path.trim() : "";
  const detail = (command || path).replace(/`/g, "").slice(0, 140);
  // Legacy Chat syntax: "Running" is _italic_ (underscores), the command stays
  // in `monospace` backticks.
  const label = command ? "Running" : `Running ${toolName}`;
  return detail ? `_${label}:_ \`${detail}\`` : `_${label}_…`;
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

    let markerName: string | undefined;
    let markerTimer: NodeJS.Timeout | undefined;
    let streamed = "";
    let patchTimer: NodeJS.Timeout | undefined;
    /** Transient status line (e.g. the command pi is running), shown under the stream. */
    let statusText: string | undefined;
    /** Delays showing the status line so fast tools don't flicker. */
    let toolTimer: NodeJS.Timeout | undefined;
    /** Serialized placeholder updates: only one PATCH in flight at a time, applied in
     *  order, so a stale snapshot can never land after the final text (an out-of-order
     *  PATCH race could otherwise permanently truncate the stored message). */
    let patchChain: Promise<void> = Promise.resolve();
    /** Serialized placeholder relocations (a steer moves the streaming reply
     *  below the steering message; see `relocateMarker`). */
    let relocateChain: Promise<void> = Promise.resolve();
    /** Identity token so a stale handler can't unregister a newer one's marker. */
    const owner = {};

    /** Text to show in the placeholder: the stream plus any transient status line. */
    const displayText = (): string => {
      if (!statusText) return streamed.slice(0, MAX_MESSAGE_CHARS);
      const status = statusText.slice(0, 200);
      const base = streamed.slice(0, Math.max(0, MAX_MESSAGE_CHARS - status.length - 2));
      return base ? `${base}\n\n${status}` : status;
    };

    /**
     * Move the streaming placeholder below a steering message. Google Chat
     * orders thread messages by creation time, so a placeholder created before
     * the steer would render ABOVE the steering text once the reply covers it.
     * The old placeholder is kept where it is when it already carries real
     * text — a frozen record of what was being said when the user steered, so
     * the thread history still shows what the answer was a response to — and
     * a fresh one is created below the steer for the continued stream. Only a
     * bare "Thinking…" placeholder (nothing streamed yet) is deleted.
     */
    const relocateMarker = (): Promise<void> => {
      relocateChain = relocateChain.then(async () => {
        await patchChain; // settle queued patches before freezing the old marker
        const old = markerName;
        if (!old) return; // no placeholder yet — the one created later lands after the steer anyway
        markerName = undefined; // meanwhile patchNow() becomes a no-op
        if (streamed.trim()) {
          // Keep the partial reply where it is (above the steer) as a record
          // of what was being said; only a bare "Thinking…" placeholder is
          // deleted. The below-steer marker carries just the continued stream.
          logger.info(`[chat] steer: kept ${streamed.length} chars of partial reply above the steer`);
        } else {
          await client.deleteMessage(old).catch(() => {});
        }
        // Reset the accumulator so the fresh marker only ever shows text
        // streamed AFTER the steer — the frozen message above already holds
        // the rest, so the live view doesn't duplicate the draft. The final
        // answer posted at the end is the complete text regardless.
        streamed = "";
        // Same silent policy as the initial placeholder: no notification for
        // intermediate "Thinking…" markers, only for the final answer.
        const silent = !threadName ? { silent: true } : undefined;
        markerName = await client.createMessage(spaceName, THINKING_TEXT, threadName, silent);
        const capped = displayText();
        if (capped) {
          try {
            await client.updateMessage(markerName, capped);
          } catch (err) {
            logger.error("[chat] relocate carry-over failed:", (err as Error).message);
          }
        }
      });
      return relocateChain;
    };
    // Register so a steering message (a separate handler) can relocate this marker.
    markers.set(sessionKey, { owner, relocate: relocateMarker });

    /** Create the placeholder on demand (called by the delay timer). It is
     *  silent where the API allows (top-level only): the user gets one
     *  notification per reply — the final answer — not a "Thinking…" ping up
     *  front. NOTE (verified Aug 2026): silent + threaded replies 403s, so
     *  threaded placeholders still notify. */
    const ensureMarker = async (): Promise<void> => {
      if (markerName) return;
      const silent = !threadName ? { silent: true } : undefined;
      markerName = await client.createMessage(spaceName, THINKING_TEXT, threadName, silent);
      // A tool is already running — show its status right away.
      if (statusText) await patchNow();
    };

    const patchNow = (): Promise<void> => {
      patchChain = patchChain.then(async () => {
        patchTimer = undefined;
        // Read the LATEST text when the queued task runs, so intermediate
        // snapshots coalesce and the final patch always carries the final text.
        const capped = displayText();
        if (capped && markerName) {
          try {
            await client.updateMessage(markerName, capped);
          } catch (err) {
            logger.error("[chat] patch failed:", (err as Error).message);
          }
        }
      });
      return patchChain;
    };

    /** Show the tool status after a short delay (fast tools shouldn't flicker). */
    const showTool = (toolName: string, args: unknown): void => {
      if (toolTimer) clearTimeout(toolTimer);
      const line = toolStatusLine(toolName, args);
      toolTimer = setTimeout(() => {
        toolTimer = undefined;
        statusText = line;
        void patchNow();
      }, TOOL_STATUS_DELAY_MS);
    };
    /** Clear the tool status line when the tool finishes. */
    const clearTool = (): void => {
      if (toolTimer) clearTimeout(toolTimer);
      toolTimer = undefined;
      if (statusText) {
        statusText = undefined;
        void patchNow();
      }
    };

    try {
      // Only show a placeholder if the reply is taking a while — feels like a
      // typing indicator for fast answers (no API exists for the real one).
      markerTimer = setTimeout(() => {
        ensureMarker().catch((err) => logger.error("[chat] marker failed:", (err as Error).message));
      }, MARKER_DELAY_MS);

      const reply = await router.handleMessage(
        sessionKey,
        spaceName,
        text,
        images,
        (delta) => {
          streamed += delta;
          if (streamed.length > MAX_MESSAGE_CHARS) return; // stop patching past the cap
          if (!patchTimer) patchTimer = setTimeout(() => void patchNow(), PATCH_DEBOUNCE_MS);
        },
        showTool,
        clearTool,
      );

      if (patchTimer) clearTimeout(patchTimer);
      if (markerTimer) clearTimeout(markerTimer);
      if (toolTimer) clearTimeout(toolTimer);
      statusText = undefined;

      if (reply === null) {
        // Session became busy between the check and the prompt — drop the marker.
        if (markerName) await client.deleteMessage(markerName).catch(() => {});
        logger.info(`[chat] ${display}: busy, deferred`);
        return "busy";
      }

      const final = reply.trim();
      if (!final) {
        if (markerName) await client.deleteMessage(markerName).catch(() => {});
        logger.info(`[chat] ${display}: empty reply, marker removed`);
        return "ok";
      }

      // Show the final text (in the placeholder if one exists), then post overflow.
      streamed = final;
      // Replace the streamed placeholder with a fresh message: `markupSyntax`
      // is create-only (any text PATCH resets the message to legacy CHAT
      // syntax — verified Aug 2026), so the placeholder can't render Markdown.
      // The placeholder is silent where the API allows, so this final create
      // is the single notification that the answer is ready.
      if (markerName) {
        await patchNow();
        await client.deleteMessage(markerName).catch(() => {});
      }
      // The first chunk IS the answer (it notifies). Overflow chunks would
      // ideally be silent so long replies don't re-notify per 4000-char spill,
      // but NOTIFICATION_TYPE_SILENT 403s when combined with messageReplyOption
      // (threaded replies — verified Aug 2026); silent only works for top-level
      // creates, so threaded overflow posts normally.
      let rest = final;
      let first = true;
      while (rest.length > 0) {
        const silent = !first && !threadName ? { silent: true } : undefined;
        await client.sendMessage(spaceName, rest.slice(0, MAX_MESSAGE_CHARS), threadName, silent);
        rest = rest.slice(MAX_MESSAGE_CHARS);
        first = false;
      }
      logger.info(`[chat] ${display}: replied (${final.length} chars)`);
      return "ok";
    } catch (err) {
      const aborted = (err as Error)?.name === "AbortError";
      logger.error(`[chat] ${display}: handler ${aborted ? "interrupted (implicit stop)" : "error"}:`, (err as Error).message);
      if (markerTimer) clearTimeout(markerTimer);
      if (toolTimer) clearTimeout(toolTimer);
      if (aborted && streamed.trim()) {
        // Implicit stop: keep the partial reply visible, but replace the
        // streamed placeholder with a fresh message so it renders as Markdown.
        const partial = streamed.trim().slice(0, MAX_MESSAGE_CHARS);
        if (markerName) {
          await client.deleteMessage(markerName).catch(() => {});
          markerName = undefined;
        }
        if (partial) {
          await client.sendMessage(spaceName, partial, threadName).catch((e) =>
            logger.error("[chat] final partial post failed:", (e as Error).message),
          );
        }
      } else if (markerName) {
        await client.deleteMessage(markerName).catch(() => {});
      }
      return "ok"; // ack so a poison message doesn't redeliver forever
    } finally {
      // Only the handler that owns the current marker may unregister it.
      if (markers.get(sessionKey)?.owner === owner) markers.delete(sessionKey);
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
