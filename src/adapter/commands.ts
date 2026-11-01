/**
 * Bridge commands on the durable harness: slash commands and card actions.
 *
 * A near 1:1 replacement for `commands.ts`, with the router calls swapped for
 * `queries.ts` and the durable router. The Chat side is unchanged on purpose —
 * the same cards, the same action ids, the same notification behaviour — because
 * what the user sees should not change with the harness underneath.
 *
 * Two commands are new because the harness makes them cheap: `/new` (start a
 * fresh conversation on this thread) and `/compact` (summarise history now,
 * while the conversation keeps working). `/session` reports durable numbers
 * instead of a JSONL file's.
 */
import path from "node:path";

import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

import {
  confirmCard,
  errorCard,
  escapeHtml,
  helpCard,
  modelConfirmCard,
  modelPickerCard,
  pickerCard,
  settingsCard,
  settingsConfirmCard,
  statusCard,
} from "../cards.js";
import { actionParam, anyFormValue, formValue } from "../card-input.js";
import type { ChatClient } from "../chat-client.js";
import {
  BUSY,
  MODEL_ACTION,
  RESUME_ACTION,
  SET_DEFAULT_MODEL_ACTION,
  SETTINGS_ACTION,
  THINKING_KEEP,
  THINKING_LEVELS_ACTION,
} from "../constants.js";
import type { DurableRouter } from "./router.js";
import { logger } from "../logger.js";
import type { HandleResult } from "../receiver.js";
import type { StateStore } from "../state.js";
import type { IncomingMessage } from "../types.js";
import type { BridgeHost } from "../durable/host.js";
import type { ConversationSettingsResult, DefaultSettings, DefaultSettingsResult, SessionInfo } from "../agent-sessions.js";
import {
  applyModelPick,
  conversationStatus,
  listConversations,
  listModels,
  rebind,
  renameConversation,
  startConversation,
  supportedThinkingLevels,
  switchModel,
} from "./queries.js";

export interface DurableCommandContext {
  client: ChatClient;
  host: BridgeHost;
  router: DurableRouter;
  /** Remembered `/model` card for the background topic titler. */
  state: StateStore;
  incoming: IncomingMessage;
  /** Chat conversation key, from `keyFor()`. */
  chatKey: string;
  /** Key named by the command's own action parameters (a thread /model was typed in). */
  actionKey: string;
  spaceName: string;
  threadName: string | undefined;
  display: string;
  text: string;
}

/** The global default model/thinking, from pi's settings.json (shared with the TUI and cron). */
export function defaultSettings(host: BridgeHost, cwd: string): DefaultSettings {
  const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: false });
  const provider = settings.getDefaultProvider();
  const modelId = settings.getDefaultModel();
  const thinkingLevel = settings.getDefaultThinkingLevel();
  const model = provider && modelId ? host.modelRuntime.getModel(provider, modelId) : undefined;
  return {
    provider,
    modelId,
    modelLabel: modelId ? `${model?.name ?? modelId}${provider ? ` (${provider})` : ""}` : undefined,
    thinkingLevel,
  };
}

/** Change the defaults. Affects only conversations created afterwards. */
export function applyDefaultSettings(
  host: BridgeHost,
  cwd: string,
  request: { provider: string; modelId: string; thinkingLevel?: string },
): DefaultSettingsResult {
  const model = host.modelRuntime.getModel(request.provider, request.modelId);
  if (!model) return { ok: false, modelLabel: request.modelId, error: `Unknown model ${request.provider}/${request.modelId}` };
  try {
    const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: false });
    settings.setDefaultModelAndProvider(request.provider, request.modelId);
    const requested =
      request.thinkingLevel && request.thinkingLevel !== THINKING_KEEP ? request.thinkingLevel : undefined;
    if (requested) settings.setDefaultThinkingLevel(requested as never);
    return {
      ok: true,
      modelLabel: `${model.name ?? model.id}${request.provider ? ` (${request.provider})` : ""}`,
      thinkingLevel: settings.getDefaultThinkingLevel(),
    };
  } catch (error) {
    return { ok: false, modelLabel: request.modelId, error: (error as Error).message };
  }
}

interface SlashCommand {
  pattern: RegExp;
  /** Commands interrupt a running reply; read-only ones (`/status`) do not. */
  interrupt?: boolean;
  run: (ctx: DurableCommandContext) => Promise<HandleResult>;
}

const SLASH_COMMANDS: SlashCommand[] = [
  {
    pattern: /^\/new\b/,
    interrupt: true,
    run: async ({ client, host, router, chatKey, spaceName, threadName, display }) => {
      await router.interrupt(chatKey);
      const current = await conversationStatus(host, chatKey);
      const defaults = defaultSettings(host, host.cwdPath);
      if (!current.isNew && current.provider && current.modelId) {
        await startConversation(host, chatKey, {
          model: { provider: current.provider, modelId: current.modelId },
          ...(current.thinkingLevel ? { thinkingLevel: current.thinkingLevel as never } : {}),
        });
      }
      await client.sendMessage(
        spaceName,
        `Started a new conversation on **${escapeHtml(current.model ?? defaults.modelLabel ?? "the default model")}**. The previous one is kept in storage.`,
        threadName,
      );
      logger.info(`[chat] ${display}: started a new conversation on ${current.model ?? "defaults"}`);
      return "ok";
    },
  },
  {
    pattern: /^\/abort\b/,
    interrupt: false,
    run: async ({ client, router, chatKey, spaceName, threadName, display }) => {
      const stopped = await router.interrupt(chatKey);
      await client.sendMessage(
        spaceName,
        stopped ? "Stopped the running reply." : "Nothing to stop in this conversation.",
        threadName,
      );
      logger.info(`[chat] ${display}: abort -> ${stopped ? "aborted" : "idle"}`);
      return "ok";
    },
  },
  {
    pattern: /^\/compact\b/,
    interrupt: false,
    run: async ({ client, host, chatKey, spaceName, threadName, display, text }) => {
      // Read-only first: compacting must not be the thing that creates a thread's
      // conversation (same rule as /abort and /status).
      const binding = await host.bindingFor(chatKey);
      if (!binding) {
        await client.sendMessage(spaceName, "Nothing to compact yet — send a message first.", threadName);
        return "ok";
      }
      const bound = await host.conversationFor(chatKey, { model: defaultModelRef(host) });
      const instructions = text.trim().replace(/^\/compact\s*/, "").trim();
      await bound.conversation.compact(instructions || undefined, host.context);
      await client.sendMessage(
        spaceName,
        "Compacting the older part of this conversation in the background — the answer stays available meanwhile.",
        threadName,
      );
      logger.info(`[chat] ${display}: compact requested`);
      return "ok";
    },
  },
  {
    pattern: /^\/model\b/,
    interrupt: true,
    run: async ({ client, host, chatKey, spaceName, threadName, display }) => {
      const models = await listModels(host);
      if (models.length === 0) {
        await client.sendMessage(spaceName, "No models configured.", threadName);
        return "ok";
      }
      const status = await conversationStatus(host, chatKey);
      await client.createCardMessage(
        spaceName,
        modelPickerCard(models, chatKey, status.model, {
          newConversation: status.isNew,
          thinkingLevel: status.thinkingLevel,
          supportedLevels: status.supportedLevels,
          currentValue: status.model ? status.model.replace("/", "|") : undefined,
        }),
        status.isNew ? "Choose the model for this new conversation." : "Choose the model and thinking level.",
        threadName,
      );
      logger.info(`[chat] ${display}: posted model picker (${models.length} models, thinking=${status.thinkingLevel ?? "?"})`);
      return "ok";
    },
  },
  {
    pattern: /^\/(settings|defaultmodel)\b/,
    interrupt: true,
    run: async ({ client, host, spaceName, display }) => {
      const models = await listModels(host);
      if (models.length === 0) {
        await client.sendMessage(spaceName, "No models configured.");
        return "ok";
      }
      const defaults = defaultSettings(host, host.cwdPath);
      const supportedLevels =
        defaults.provider && defaults.modelId
          ? supportedThinkingLevels(host.modelRuntime, defaults.provider, defaults.modelId)
          : undefined;
      await client.createCardMessage(spaceName, settingsCard(models, defaults, { supportedLevels }), "Settings for new conversations.");
      logger.info(`[chat] ${display}: posted settings card (${models.length} models)`);
      return "ok";
    },
  },
  {
    pattern: /^\/engine\b/,
    // Read-only, and the one command whose answer is unambiguous about which
    // bridge replied: the SDK host has no such command, so a reply that says
    // "engine=durable" cannot have come from it.
    run: async ({ client, host, chatKey, spaceName, threadName, display }) => {
      const binding = await host.bindingFor(chatKey);
      const status = binding ? await conversationStatus(host, chatKey) : undefined;
      const lines = [
        "<b>engine=durable</b>",
        `db: <code>${escapeHtml(host.dbPath)}</code>`,
        `subscription: <code>${escapeHtml(process.env.PUBSUB_SUBSCRIPTION ?? "(unset)")}</code>`,
        `spaces: <code>${escapeHtml(process.env.ALLOWED_SPACES || "(all)")}</code>`,
        `this thread: ${binding ? `conversation ${status?.conversationId} · ${escapeHtml(status?.model ?? "?")}` : "no conversation yet"}`,
      ];
      await client.sendMessage(spaceName, lines.join("\n"), threadName);
      logger.info(`[chat] ${display}: engine report (conversation ${status?.conversationId ?? "none"})`);
      return "ok";
    },
  },
  {
    pattern: /^\/status\b/,
    run: async ({ client, host, chatKey, spaceName, threadName, display }) => {
      const status = await conversationStatus(host, chatKey);
      const defaults = defaultSettings(host, host.cwdPath);
      await client.createCardMessage(
        spaceName,
        statusCard({
          model: status.model,
          thinkingLevel: status.thinkingLevel,
          defaultModel: defaults.modelLabel,
          defaultThinkingLevel: defaults.thinkingLevel,
          // Durable keeps per-model usage rather than a per-session context
          // counter, so the card shows tokens and cost instead of occupancy.
          usage: status.usage
            ? {
                input: status.usage.input,
                output: status.usage.output,
                cost: status.usage.cost,
                cacheRead: 0,
                cacheWrite: 0,
              }
            : undefined,
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
    run: async ({ client, host, chatKey, spaceName, threadName, display }) => {
      const status = await conversationStatus(host, chatKey);
      if (status.isNew) {
        await client.sendMessage(spaceName, "No conversation for this thread yet — send a message first.", threadName);
        return "ok";
      }
      const binding = await host.bindingFor(chatKey);
      const lines = [
        `<b>Conversation ${status.conversationId}</b>${binding?.name ? ` — ${escapeHtml(binding.name)}` : ""}`,
        `Model: <b>${escapeHtml(status.model ?? "?")}</b>${status.thinkingLevel ? ` · thinking ${escapeHtml(status.thinkingLevel)}` : ""}`,
        `Entries: ${status.entries ?? 0}`,
        status.usage
          ? `Tokens: ${status.usage.total.toLocaleString()} (${status.usage.input.toLocaleString()} in · ${status.usage.output.toLocaleString()} out) · $${status.usage.cost.toFixed(4)}`
          : "Tokens: none recorded yet",
      ];
      await client.sendMessage(spaceName, lines.join("\n"), threadName);
      logger.info(`[chat] ${display}: reported conversation ${status.conversationId}`);
      return "ok";
    },
  },
  {
    pattern: /^\/name\b/,
    interrupt: true,
    run: async ({ client, host, chatKey, spaceName, threadName, display, text }) => {
      const arg = text.trim().replace(/^\/name\s*/, "").trim();
      const binding = await host.bindingFor(chatKey);
      if (!arg) {
        await client.sendMessage(
          spaceName,
          binding?.name
            ? `This conversation is named: **${escapeHtml(binding.name)}**`
            : "This conversation has no name yet. Use **/name &lt;name&gt;** to set one.",
          threadName,
        );
        return "ok";
      }
      if (!binding) {
        await client.sendMessage(spaceName, "No conversation for this thread yet — send a message first.", threadName);
        return "ok";
      }
      await renameConversation(host, chatKey, arg);
      await client.sendMessage(spaceName, `Conversation named: **${escapeHtml(arg)}**`, threadName);
      logger.info(`[chat] ${display}: named conversation -> ${arg}`);
      return "ok";
    },
  },
  {
    pattern: /^\/help\b/,
    interrupt: true,
    run: async ({ client, spaceName, threadName, display }) => {
      await client.createCardMessage(
        spaceName,
        helpCard(),
        "Available commands: /model, /settings, /status, /engine, /new, /abort, /compact, /session, /name, /resume, /sessions, /help.",
        threadName,
      );
      logger.info(`[chat] ${display}: posted help card`);
      return "ok";
    },
  },
  {
    pattern: /^\/(resume|sessions|list)\b/,
    interrupt: true,
    run: async ({ client, host, chatKey, spaceName, threadName, display }) => {
      const bound = await listConversations(host);
      if (bound.length === 0) {
        await client.sendMessage(spaceName, "No conversations yet.", threadName);
        return "ok";
      }
      const sessions: SessionInfo[] = bound.map(({ chatKey: key, binding }) => ({
        label: binding.name ?? `${path.basename(key)} · ${binding.model}`,
        // The picker's value is the conversation id; RESUME_ACTION binds to it.
        file: String(binding.conversationId),
        mtimeMs: binding.createdAt,
      }));
      await client.createCardMessage(spaceName, pickerCard(sessions, chatKey), "Choose a conversation to resume.", threadName);
      logger.info(`[chat] ${display}: posted conversation picker (${sessions.length})`);
      return "ok";
    },
  },
];

/** The default model as a ModelRef, for commands that may need to create a conversation. */
function defaultModelRef(host: BridgeHost): { provider: string; modelId: string } {
  const defaults = defaultSettings(host, host.cwdPath);
  if (defaults.provider && defaults.modelId) return { provider: defaults.provider, modelId: defaults.modelId };
  const [first] = host.modelRuntime.getModels();
  if (!first) throw new Error("no model configured");
  return { provider: first.provider, modelId: first.id };
}

export async function runDurableCommand(ctx: DurableCommandContext): Promise<HandleResult | null> {
  const { client, host, router, state, incoming, chatKey, actionKey, spaceName, threadName, display, text } = ctx;

  if (incoming.eventType === "CARD_CLICKED") {
    if (incoming.action?.actionMethodName === THINKING_LEVELS_ACTION) {
      const mode = actionParam(incoming, "mode") === "settings" ? "settings" : "model";
      const picked = formValue(incoming, mode === "settings" ? "default_model_picker" : "model_picker");
      if (!picked) {
        logger.info(`[chat] ${display}: ${THINKING_LEVELS_ACTION} without a selected value — card left as-is`);
        return "ok";
      }
      const [provider = "", modelId = ""] = picked.split("|");
      const supportedLevels = supportedThinkingLevels(host.modelRuntime, provider, modelId);
      const models = await listModels(host);
      const label = models.find((m) => m.provider === provider && m.id === modelId)?.label ?? modelId;

      if (mode === "settings") {
        await client
          .updateMessageCards(
            incoming.message.name,
            settingsCard(models, defaultSettings(host, host.cwdPath), { currentValue: picked, supportedLevels }),
            `Defaults — ${label}: thinking levels ${supportedLevels?.join(", ") ?? "(unknown)"}`,
          )
          .catch((err) => logger.error("[chat] card update failed:", (err as Error).message));
        return "ok";
      }

      const status = await conversationStatus(host, chatKey);
      await client
        .updateMessageCards(
          incoming.message.name,
          modelPickerCard(models, chatKey, status.model, {
            newConversation: status.isNew,
            thinkingLevel: status.thinkingLevel,
            supportedLevels,
            currentValue: picked,
          }),
          `${label}: thinking levels ${supportedLevels?.join(", ") ?? "(unknown)"}`,
        )
        .catch((err) => logger.error("[chat] card update failed:", (err as Error).message));
      return "ok";
    }

    if (incoming.action?.actionMethodName === MODEL_ACTION) {
      const picked = formValue(incoming, "model_picker") ?? anyFormValue(incoming);
      if (!picked) {
        await client
          .updateMessageCards(incoming.message.name, modelConfirmCard({ ok: false, modelLabel: "", error: "No model was selected." }), "No model selected.")
          .catch((err) => logger.error("[chat] card update failed:", (err as Error).message));
        return "ok";
      }
      const [provider, modelId] = picked.split("|");
      const thinkingLevel = formValue(incoming, "thinking_picker");
      // A card posted as a new top-level message owns the thread the user's next
      // message will land in, so a pick that starts a conversation must bind
      // there — not to the thread /model was typed in.
      const status = await conversationStatus(host, chatKey);
      const targetKey = !status.isNew ? actionKey : chatKey !== spaceName ? chatKey : actionKey;

      const result = await applyModelPick(host, targetKey, {
        provider: provider ?? "",
        modelId: modelId ?? "",
        thinkingLevel,
      });
      if (!result.ok && result.error === BUSY) return "busy";
      const summary = result.ok
        ? `-> ${result.modelLabel} · thinking ${result.thinkingLevel ?? "?"}`
        : `failed: ${result.error}`;
      await client
        .updateMessageCards(incoming.message.name, modelConfirmCard(result), `Model switch: ${summary}`)
        .catch((err) => logger.error("[chat] card update failed:", (err as Error).message));
      logger.info(`[chat] ${display}: model switch ${summary} (key ${targetKey})`);
      if (result.ok && result.created) {
        state.setTopicCard(targetKey, { messageName: incoming.message.name, modelLabel: result.modelLabel });
        const note =
          `Starting a new conversation with model **${escapeHtml(result.modelLabel)}**` +
          (result.thinkingLevel ? ` and thinking level **${escapeHtml(result.thinkingLevel)}**` : "") +
          "…";
        await client
          .sendMessage(spaceName, note, threadName)
          .catch((err) => logger.error("[chat] new-conversation notice failed:", (err as Error).message));
      }
      return "ok";
    }

    if (
      incoming.action?.actionMethodName === SETTINGS_ACTION ||
      incoming.action?.actionMethodName === SET_DEFAULT_MODEL_ACTION
    ) {
      const picked =
        formValue(incoming, "default_model_picker") ?? formValue(incoming, "model_picker") ?? anyFormValue(incoming);
      if (!picked) {
        await client
          .updateMessageCards(incoming.message.name, settingsConfirmCard({ ok: false, modelLabel: "", error: "No model was selected." }), "No model selected.")
          .catch((err) => logger.error("[chat] card update failed:", (err as Error).message));
        return "ok";
      }
      const [provider, modelId] = picked.split("|");
      const result = applyDefaultSettings(host, host.cwdPath, {
        provider: provider ?? "",
        modelId: modelId ?? "",
        thinkingLevel: formValue(incoming, "default_thinking_picker"),
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
          .updateMessageCards(incoming.message.name, errorCard("No conversation was selected."), "No conversation selected.")
          .catch((err) => logger.error("[chat] card update failed:", (err as Error).message));
        return "ok";
      }
      const conversationId = Number(picked);
      const bound = Number.isFinite(conversationId) && (await rebind(host, actionKey, conversationId));
      await client
        .updateMessageCards(
          incoming.message.name,
          bound ? confirmCard(`conversation ${conversationId}`) : errorCard("That conversation no longer exists."),
          bound ? `Resumed conversation ${conversationId}.` : "Resume failed.",
        )
        .catch((err) => logger.error("[chat] card update failed:", (err as Error).message));
      logger.info(`[chat] ${display}: resume -> ${bound ? conversationId : "failed"}`);
      return "ok";
    }

    logger.info(`[chat] ${display}: unhandled card action`);
    return "ok";
  }

  const trimmed = text.trim();
  for (const command of SLASH_COMMANDS) {
    if (!command.pattern.test(trimmed)) continue;
    if (command.interrupt && router && (await isBusy(host, chatKey))) await router.interrupt(chatKey);
    return command.run(ctx);
  }
  return null;
}

/** Whether a run currently owns the conversation. */
async function isBusy(host: BridgeHost, chatKey: string): Promise<boolean> {
  // Read-only: a command must never be the thing that creates a conversation.
  const binding = await host.bindingFor(chatKey);
  if (!binding) return false;
  const conversation = await host.harness.conversation(binding.conversationId as never, host.context);
  if (!conversation) return false;
  const view = await conversation.viewState(host.context);
  const live = (view.value as { docs?: Record<string, unknown> }).docs?.["pi.live"] as { run?: unknown } | undefined;
  view.dispose();
  return live?.run !== undefined;
}
