import type { AgentRouter, ConversationSettingsResult, DefaultSettingsResult } from "./agent-sessions.js";
import {
  confirmCard,
  errorCard,
  escapeHtml,
  helpCard,
  modelConfirmCard,
  modelPickerCard,
  pickerCard,
  sessionStatsCard,
  settingsCard,
  settingsConfirmCard,
  statusCard,
} from "./cards.js";
import type { ChatClient } from "./chat-client.js";
import {
  BUSY,
  MODEL_ACTION,
  RESUME_ACTION,
  SET_DEFAULT_MODEL_ACTION,
  SETTINGS_ACTION,
  THINKING_LEVELS_ACTION,
} from "./constants.js";
import { logger } from "./logger.js";
import type { HandleResult } from "./receiver.js";
import type { StateStore } from "./state.js";
import type { IncomingMessage } from "./types.js";

/** Everything a bridge command/card handler needs from the message handler. */
export interface CommandContext {
  client: ChatClient;
  router: AgentRouter;
  /** Durable state; used to remember the /model card for a later topic title. */
  state: StateStore;
  incoming: IncomingMessage;
  sessionKey: string;
  actionKey: string;
  spaceName: string;
  threadName: string | undefined;
  display: string;
  text: string;
}

/** Read one widget's value from a CARD_CLICKED event's form inputs, by the
 *  widget's `name`. Needed now that cards carry several dropdowns (model +
 *  thinking level) — reading "the first value" would pick the wrong one.
 *  Selection values only arrive when a BUTTON submits the form — a dropdown's
 *  onChangeAction fires an event with no value. Widget values appear either as
 *  `input.selectionInput.selectedValues[]` / `input.stringInputs.value[]`
 *  (action.formInputs, legacy) or flattened under common.formInputs (new). */
function formValue(incoming: IncomingMessage, name: string): string | undefined {
  const formInputs = incoming.action?.formInputs;
  if (!formInputs) return undefined;
  const widget = formInputs[name];
  if (!widget) return undefined;
  const input = widget.input ?? widget;
  return input?.selectionInput?.selectedValues?.[0] ?? input?.stringInputs?.value?.[0];
}

/** Fallback for cards posted before multi-dropdown support: any single value. */
function anyFormValue(incoming: IncomingMessage): string | undefined {
  const formInputs = incoming.action?.formInputs;
  if (!formInputs) return undefined;
  for (const key of Object.keys(formInputs)) {
    const widget = formInputs[key];
    const input = widget?.input ?? widget;
    const value = input?.selectionInput?.selectedValues?.[0] ?? input?.stringInputs?.value?.[0];
    if (value) return value;
  }
  return undefined;
}

/** Read one of a card action's static `parameters` (e.g. which selection's key). */
function actionParam(incoming: IncomingMessage, key: string): string | undefined {
  return incoming.action?.parameters?.find((p) => p.key === key)?.value;
}

/** A built-in slash command handled by the bridge (not sent to pi). */
interface SlashCommand {
  pattern: RegExp;
  /** Whether to interrupt a running reply before handling (commands are
   *  explicit user control; read-only ones like /status opt out). */
  interrupt?: boolean;
  run: (ctx: CommandContext) => Promise<HandleResult>;
}

/** Built-in command dispatch, tried in order against the trimmed text. */
const SLASH_COMMANDS: SlashCommand[] = [
  {
    pattern: /^\/model\b/,
    interrupt: true,
    run: async ({ client, router, sessionKey, spaceName, threadName, display }) => {
      const models = await router.listModels();
      if (models.length === 0) {
        await client.sendMessage(spaceName, "No models configured.", threadName);
        return "ok";
      }
      // With a conversation, /model switches THIS conversation's model and
      // thinking level. With no conversation yet, the pick STARTS this
      // conversation on that model (switchModel creates the session there and
      // restores the global default, so picking here never changes what other
      // conversations get). Changing the defaults is /settings.
      const starting = !router.hasSession(sessionKey);
      const current = starting ? undefined : await router.currentModel(sessionKey);
      const currentValue = starting ? undefined : await router.currentModelValue(sessionKey);
      const thinkingLevel = starting ? undefined : await router.currentThinkingLevel(sessionKey);
      const [curProvider = "", curModelId = ""] = (currentValue ?? "").split("|");
      const supportedLevels = currentValue
        ? router.thinkingLevelsForModel(curProvider, curModelId)
        : undefined;
      await client.createCardMessage(
        spaceName,
        modelPickerCard(models, sessionKey, current, {
          newConversation: starting,
          thinkingLevel,
          supportedLevels,
          currentValue,
        }),
        starting ? "Choose the model for this new conversation." : "Choose the model and thinking level.",
        threadName,
      );
      logger.info(
        `[chat] ${display}: posted model picker (${models.length} models, thinking=${thinkingLevel ?? "?"}${starting ? ", starts this conversation" : ""})`,
      );
      return "ok";
    },
  },
  {
    // /settings replaces the old /defaultmodel: one card, both defaults (model
    // + thinking level). /defaultmodel stays as an alias so muscle memory (and
    // any pinned bookmark of the help card) keeps working.
    pattern: /^\/(settings|defaultmodel)\b/,
    interrupt: true,
    run: async ({ client, router, spaceName, display }) => {
      const models = await router.listModels();
      if (models.length === 0) {
        await client.sendMessage(spaceName, "No models configured.");
        return "ok";
      }
      // Posted at the TOP LEVEL (no threadName) on purpose: the defaults are a
      // space-wide setting, not part of any conversation — nesting the card in
      // the command's own thread just buries it in a 1-reply sub-thread.
      const defaults = router.defaultSettings();
      const supportedLevels = defaults.provider && defaults.modelId
        ? router.thinkingLevelsForModel(defaults.provider, defaults.modelId)
        : undefined;
      await client.createCardMessage(
        spaceName,
        settingsCard(models, defaults, { supportedLevels }),
        "Settings for new conversations.",
      );
      logger.info(`[chat] ${display}: posted settings card (${models.length} models)`);
      return "ok";
    },
  },
  {
    pattern: /^\/status\b/,
    // Read-only: no interrupt (doesn't disturb an in-flight reply). Model,
    // context occupancy, and token totals come from pi's own accounting
    // (getSessionStats / getContextUsage), which opens the session if it
    // hasn't been opened yet.
    run: async ({ client, router, sessionKey, spaceName, threadName, display }) => {
      const model = await router.currentModel(sessionKey);
      const thinkingLevel = model ? await router.currentThinkingLevel(sessionKey) : undefined;
      const context = await router.sessionContextUsage(sessionKey);
      const usage = await router.sessionUsage(sessionKey);
      const defaults = router.defaultSettings();
      await client.createCardMessage(
        spaceName,
        statusCard({
          model,
          thinkingLevel,
          defaultModel: defaults.modelLabel,
          defaultThinkingLevel: defaults.thinkingLevel,
          context,
          usage,
        }),
        "Status.",
        threadName,
      );
      logger.info(`[chat] ${display}: posted status card`);
      return "ok";
    },
  },
  {
    pattern: /^\/session\b/,
    interrupt: true,
    run: async ({ client, router, sessionKey, spaceName, threadName, display }) => {
      const stats = router.sessionStats(sessionKey);
      if (!stats) {
        await client.sendMessage(spaceName, "No session for this conversation yet — send a message first.", threadName);
        return "ok";
      }
      const name = await router.getSessionName(sessionKey);
      await client.createCardMessage(spaceName, sessionStatsCard(stats, name), "Session stats.", threadName);
      logger.info(`[chat] ${display}: posted session stats (${stats.totalMessages} messages, $${stats.cost.toFixed(4)})`);
      return "ok";
    },
  },
  {
    pattern: /^\/name\b/,
    interrupt: true,
    run: async ({ client, router, sessionKey, spaceName, threadName, display, text }) => {
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
    },
  },
  {
    pattern: /^\/help\b/,
    interrupt: true,
    run: async ({ client, spaceName, threadName, display }) => {
      await client.createCardMessage(spaceName, helpCard(), "Available commands: /model, /settings, /resume, /sessions, /list, /help.", threadName);
      logger.info(`[chat] ${display}: posted help card`);
      return "ok";
    },
  },
  {
    pattern: /^\/(resume|sessions|list)\b/,
    interrupt: true,
    run: async ({ client, router, sessionKey, spaceName, threadName, display }) => {
      const sessions = await router.listSessions();
      if (sessions.length === 0) {
        await client.sendMessage(spaceName, "No sessions found yet.", threadName);
        return "ok";
      }
      await client.createCardMessage(spaceName, pickerCard(sessions, sessionKey), "Choose a session to resume.", threadName);
      logger.info(`[chat] ${display}: posted session picker (${sessions.length} sessions)`);
      return "ok";
    },
  },
];

/**
 * Handle a card action or a built-in slash command. Returns a HandleResult when
 * the message was a bridge command (already handled), or null when it isn't —
 * so the caller falls through to a normal pi prompt.
 */
export async function runCommand(ctx: CommandContext): Promise<HandleResult | null> {
  const { client, router, state, incoming, sessionKey, actionKey, spaceName, threadName, display, text } = ctx;

  // --- Interactive card events (dropdown selection, buttons) ---
  if (incoming.eventType === "CARD_CLICKED") {
    if (incoming.action?.actionMethodName === THINKING_LEVELS_ACTION) {
      // A model dropdown changed: Chat submits the form, so we know which model
      // is now selected and can re-render the SAME card with that model's
      // thinking levels (they're per-model, so a static card can't show them).
      const mode = actionParam(incoming, "mode") === "settings" ? "settings" : "model";
      const picked = formValue(incoming, mode === "settings" ? "default_model_picker" : "model_picker");
      if (!picked) {
        // No value in the payload (older client): leave the card untouched
        // rather than re-rendering it into a possibly-wrong state. Apply still
        // works — pi clamps whatever level was picked.
        logger.info(`[chat] ${display}: ${THINKING_LEVELS_ACTION} without a selected value — card left as-is`);
        return "ok";
      }
      const [provider = "", modelId = ""] = picked.split("|");
      const supportedLevels = router.thinkingLevelsForModel(provider, modelId);
      const models = await router.listModels();
      const label = models.find((m) => m.provider === provider && m.id === modelId)?.label ?? modelId;
      if (mode === "settings") {
        await client
          .updateMessageCards(
            incoming.message.name,
            settingsCard(models, router.defaultSettings(), { currentValue: picked, supportedLevels }),
            `Defaults — ${label}: thinking levels ${supportedLevels?.join(", ") ?? "(unknown)"}`,
          )
          .catch((err) => logger.error("[chat] card update failed:", (err as Error).message));
        logger.info(`[chat] ${display}: settings card re-rendered for ${picked} (levels ${supportedLevels?.join(",") ?? "?"})`);
        return "ok";
      }
      // Same conversation-key rule as a model switch, minus session creation: a
      // re-render must never start a conversation.
      const targetKey = router.hasSession(actionKey)
        ? actionKey
        : sessionKey !== spaceName
          ? sessionKey
          : actionKey;
      const starting = !router.hasSession(targetKey);
      const thinkingLevel = starting ? undefined : await router.currentThinkingLevel(targetKey);
      await client
        .updateMessageCards(
          incoming.message.name,
          modelPickerCard(models, targetKey, starting ? undefined : await router.currentModel(targetKey), {
            newConversation: starting,
            thinkingLevel,
            supportedLevels,
            currentValue: picked,
          }),
          `${label}: thinking levels ${supportedLevels?.join(", ") ?? "(unknown)"}`,
        )
        .catch((err) => logger.error("[chat] card update failed:", (err as Error).message));
      logger.info(
        `[chat] ${display}: model picker re-rendered for ${picked} (levels ${supportedLevels?.join(",") ?? "?"}, key ${targetKey})`,
      );
      return "ok";
    }
    if (incoming.action?.actionMethodName === MODEL_ACTION) {
      const picked = formValue(incoming, "model_picker") ?? anyFormValue(incoming);
      if (!picked) {
        await client
          .updateMessageCards(
            incoming.message.name,
            modelConfirmCard({ ok: false, modelLabel: "", error: "No model was selected." }),
            "No model selected.",
          )
          .catch((err) => logger.error("[chat] card update failed:", (err as Error).message));
        return "ok";
      }
      const [provider, modelId] = picked.split("|");
      // Absent on pre-/thinking cards; "keep" is the dropdown's explicit no-op.
      const thinkingLevel = formValue(incoming, "thinking_picker");
      // Which conversation does this pick belong to?
      //  - The card's `session` parameter names the thread /model was typed in.
      //    That's the right key whenever a session already exists there.
      //  - With no session yet the pick STARTS a conversation, and the thread
      //    it must start in is the thread the CARD lives in (`sessionKey`, from
      //    the event's thread). Chat can post the picker as a new top-level
      //    message, giving it a thread of its own — that new thread is where the
      //    user's next messages arrive, so keying the session by the original
      //    thread would strand it (the follow-up would open a fresh
      //    default-model session instead).
      //  - `sessionKey === spaceName` means the event carried no thread at all;
      //    fall back to the parameter rather than hijacking the whole space.
      const targetKey = router.hasSession(actionKey)
        ? actionKey
        : sessionKey !== spaceName
          ? sessionKey
          : actionKey;
      const result: ConversationSettingsResult = await router.applyConversationSettings(targetKey, {
        provider: provider ?? "",
        modelId: modelId ?? "",
        thinkingLevel,
      });
      if (result.error === BUSY) {
        logger.info(`[chat] ${display}: busy, deferring model switch`);
        return "busy"; // leave unacked; retried once the session frees up
      }
      const summary = result.ok
        ? `-> ${result.modelLabel} · thinking ${result.thinkingLevel ?? "?"}`
        : `failed: ${result.error}`;
      await client
        .updateMessageCards(incoming.message.name, modelConfirmCard(result), `Model switch: ${summary}`)
        .catch((err) => logger.error("[chat] card update failed:", (err as Error).message));
      logger.info(`[chat] ${display}: model switch ${summary} (key ${targetKey})`);
      if (result.ok && result.created) {
        // This card usually becomes the thread's top message, i.e. the one line
        // the space's conversation list shows. Remember it so it can be
        // re-titled with the conversation's topic once the first reply lands
        // (index.ts fires the background job).
        state.setTopicCard(targetKey, {
          messageName: incoming.message.name,
          modelLabel: result.modelLabel,
        });
        const note = `Starting a new conversation with model **${escapeHtml(result.modelLabel)}**` +
          (result.thinkingLevel ? ` and thinking level **${escapeHtml(result.thinkingLevel)}**` : "") +
          "…";
        await client
          .sendMessage(spaceName, note, threadName)
          .catch((err) => logger.error("[chat] new-conversation notice failed:", (err as Error).message));
        logger.info(`[chat] ${display}: started a new conversation on ${result.modelLabel}`);
      }
      return "ok";
    }
    if (
      incoming.action?.actionMethodName === SETTINGS_ACTION ||
      // Cards posted by the pre-/settings bridge still send the old action id.
      incoming.action?.actionMethodName === SET_DEFAULT_MODEL_ACTION
    ) {
      const picked =
        formValue(incoming, "default_model_picker") ??
        formValue(incoming, "model_picker") ??
        anyFormValue(incoming);
      if (!picked) {
        await client
          .updateMessageCards(
            incoming.message.name,
            settingsConfirmCard({ ok: false, modelLabel: "", error: "No model was selected." }),
            "No model selected.",
          )
          .catch((err) => logger.error("[chat] card update failed:", (err as Error).message));
        return "ok";
      }
      const [provider, modelId] = picked.split("|");
      const thinkingLevel = formValue(incoming, "default_thinking_picker");
      const result: DefaultSettingsResult = await router.setDefaults({
        provider: provider ?? "",
        modelId: modelId ?? "",
        thinkingLevel,
      });
      const summary = result.ok
        ? `-> ${result.modelLabel} · thinking ${result.thinkingLevel ?? "(unset)"}`
        : `failed: ${result.error}`;
      await client
        .updateMessageCards(incoming.message.name, settingsConfirmCard(result), `Defaults: ${summary}`)
        .catch((err) => logger.error("[chat] card update failed:", (err as Error).message));
      logger.info(`[chat] ${display}: defaults ${summary}`);
      return "ok";
    }
    if (incoming.action?.actionMethodName === RESUME_ACTION) {
      const picked = formValue(incoming, "session_picker") ?? anyFormValue(incoming);
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
  const trimmed = text.trim();
  for (const command of SLASH_COMMANDS) {
    if (!command.pattern.test(trimmed)) continue;
    if (command.interrupt && router.isBusy(sessionKey)) await router.interrupt(sessionKey);
    return command.run(ctx);
  }

  return null;
}
