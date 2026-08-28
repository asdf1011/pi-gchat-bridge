import type { AgentRouter } from "./agent-sessions.js";
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
import type { ChatClient } from "./chat-client.js";
import { MODEL_ACTION, RESUME_ACTION, SET_DEFAULT_MODEL_ACTION, BUSY } from "./constants.js";
import { logger } from "./logger.js";
import type { HandleResult } from "./receiver.js";
import type { IncomingMessage } from "./types.js";

/** Everything a bridge command/card handler needs from the message handler. */
export interface CommandContext {
  client: ChatClient;
  router: AgentRouter;
  incoming: IncomingMessage;
  sessionKey: string;
  actionKey: string;
  spaceName: string;
  threadName: string | undefined;
  display: string;
  text: string;
}

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

/**
 * Handle a card action or a built-in slash command. Returns a HandleResult when
 * the message was a bridge command (already handled), or null when it isn't —
 * so the caller falls through to a normal pi prompt.
 */
export async function runCommand(ctx: CommandContext): Promise<HandleResult | null> {
  const { client, router, incoming, sessionKey, actionKey, spaceName, threadName, display, text } = ctx;

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
      if (result.error === BUSY) {
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
    // context occupancy, and token totals come from pi's own accounting
    // (getSessionStats / getContextUsage), which opens the session if it
    // hasn't been opened yet.
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

  return null;
}
