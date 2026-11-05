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
  secretConfirmCard,
  secretPanelCard,
  secretRemoveCard,
  secretValueCard,
  settingsCard,
  settingsConfirmCard,
  statusCard,
} from "../cards.js";
import { actionParam, anyFormValue, formValue } from "../card-input.js";
import { isAllowed } from "../access.js";
import type { ChatClient } from "../chat-client.js";
import {
  BUSY,
  MODEL_ACTION,
  REMOVE_SECRET_ACTION,
  RESUME_ACTION,
  SECRET_ACTION,
  SET_DEFAULT_MODEL_ACTION,
  SET_SECRET_ACTION,
  SETTINGS_ACTION,
  THINKING_KEEP,
  THINKING_LEVELS_ACTION,
} from "../constants.js";
import { isValidSecretName, SecretStore, valueProblem } from "../secret-store.js";
import type { DurableRouter } from "./router.js";
import { logger } from "../logger.js";
import type { HandleResult } from "../receiver.js";
import type { StateStore } from "../state.js";
import type { IncomingMessage } from "../types.js";
import type { SessionHost } from "../session-host/api.js";
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
  /** The conversation host. Adapters see this, never the harness behind it. */
  seam: SessionHost;
  router: DurableRouter;
  /** Remembered `/model` card for the background topic titler. */
  state: StateStore;
  /** Secret store for `/secret`. Built by the host so tests can point it at a temp file. */
  secrets?: SecretStore;
  /**
   * Users permitted to use `/secret` (resource name or ID). Empty means "no
   * extra restriction" — the Pub/Sub allow-list and the web proxy have already
   * decided who may talk to this bridge.
   */
  secretUsers?: readonly string[];
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
export async function defaultSettings(seam: SessionHost): Promise<DefaultSettings> {
  const { cwd } = seam.info();
  const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: false });
  const provider = settings.getDefaultProvider();
  const modelId = settings.getDefaultModel();
  const thinkingLevel = settings.getDefaultThinkingLevel();
  const models = provider && modelId ? await listModels(seam) : [];
  const model = models.find((entry) => entry.provider === provider && entry.id === modelId);
  return {
    provider,
    modelId,
    modelLabel: modelId ? `${model?.label ?? modelId}${provider ? ` (${provider})` : ""}` : undefined,
    thinkingLevel,
  };
}

/** Change the defaults. Affects only conversations created afterwards. */
export async function applyDefaultSettings(
  seam: SessionHost,
  request: { provider: string; modelId: string; thinkingLevel?: string },
): Promise<DefaultSettingsResult> {
  const cwd = seam.info().cwd;
  const model = (await listModels(seam)).find(
    (entry) => entry.provider === request.provider && entry.id === request.modelId,
  );
  if (!model) return { ok: false, modelLabel: request.modelId, error: `Unknown model ${request.provider}/${request.modelId}` };
  try {
    const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: false });
    settings.setDefaultModelAndProvider(request.provider, request.modelId);
    const requested =
      request.thinkingLevel && request.thinkingLevel !== THINKING_KEEP ? request.thinkingLevel : undefined;
    if (requested) settings.setDefaultThinkingLevel(requested as never);
    return {
      ok: true,
      modelLabel: `${model.label}${request.provider ? ` (${request.provider})` : ""}`,
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
    run: async ({ client, seam, chatKey, spaceName, threadName, display }) => {
      await stopConversation(seam, chatKey);
      const current = await conversationStatus(seam, chatKey);
      const defaults = await defaultSettings(seam);
      if (!current.isNew && current.provider && current.modelId) {
        await startConversation(seam, chatKey, {
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
    run: async ({ client, seam, chatKey, spaceName, threadName, display }) => {
      const stopped = await stopConversation(seam, chatKey);
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
    run: async ({ client, seam, chatKey, spaceName, threadName, display, text }) => {
      // Read-only first: compacting must not be the thing that creates a thread's
      // conversation (same rule as /abort and /status).
      const binding = await seam.resolve(chatKey);
      if (!binding) {
        await client.sendMessage(spaceName, "Nothing to compact yet — send a message first.", threadName);
        return "ok";
      }
      const instructions = text.trim().replace(/^\/compact\s*/, "").trim();
      await seam.compact(binding.conversationId, instructions || undefined);
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
    run: async ({ client, seam, chatKey, spaceName, threadName, display }) => {
      const models = await listModels(seam);
      if (models.length === 0) {
        await client.sendMessage(spaceName, "No models configured.", threadName);
        return "ok";
      }
      const status = await conversationStatus(seam, chatKey);
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
    run: async ({ client, seam, spaceName, display }) => {
      const models = await listModels(seam);
      if (models.length === 0) {
        await client.sendMessage(spaceName, "No models configured.");
        return "ok";
      }
      const defaults = await defaultSettings(seam);
      const supportedLevels =
        defaults.provider && defaults.modelId
          ? supportedThinkingLevels(await listModels(seam), defaults.provider, defaults.modelId)
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
    run: async ({ client, seam, chatKey, spaceName, threadName, display }) => {
      const binding = await seam.resolve(chatKey);
      const status = binding ? await conversationStatus(seam, chatKey) : undefined;
      const lines = [
        "**engine=durable**",
        `db: \`${escapeHtml(seam.info().dbPath)}\``,
        `subscription: \`${escapeHtml(process.env.PUBSUB_SUBSCRIPTION ?? "(unset)")}\``,
        `spaces: \`${escapeHtml(process.env.ALLOWED_SPACES || "(all)")}\``,
        `this thread: ${binding ? `conversation ${status?.conversationId} · ${escapeHtml(status?.model ?? "?")}` : "no conversation yet"}`,
      ];
      await client.sendMessage(spaceName, lines.join("\n"), threadName);
      logger.info(`[chat] ${display}: engine report (conversation ${status?.conversationId ?? "none"})`);
      return "ok";
    },
  },
  {
    pattern: /^\/status\b/,
    run: async ({ client, seam, chatKey, spaceName, threadName, display }) => {
      const status = await conversationStatus(seam, chatKey);
      const defaults = await defaultSettings(seam);
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
                cacheRead: status.usage.cacheRead,
                cacheWrite: status.usage.cacheWrite,
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
    run: async ({ client, seam, chatKey, spaceName, threadName, display }) => {
      const status = await conversationStatus(seam, chatKey);
      if (status.isNew) {
        await client.sendMessage(spaceName, "No conversation for this thread yet — send a message first.", threadName);
        return "ok";
      }
      const binding = await seam.resolve(chatKey);
      const lines = [
        `**Conversation ${status.conversationId}**${binding?.name ? ` — ${escapeHtml(binding.name)}` : ""}`,
        `Model: **${escapeHtml(status.model ?? "?")}**${status.thinkingLevel ? ` · thinking ${escapeHtml(status.thinkingLevel)}` : ""}`,
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
    run: async ({ client, seam, chatKey, spaceName, threadName, display, text }) => {
      const arg = text.trim().replace(/^\/name\s*/, "").trim();
      const binding = await seam.resolve(chatKey);
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
      await renameConversation(seam, chatKey, arg);
      await client.sendMessage(spaceName, `Conversation named: **${escapeHtml(arg)}**`, threadName);
      logger.info(`[chat] ${display}: named conversation -> ${arg}`);
      return "ok";
    },
  },
  {
    pattern: /^\/secret\b/,
    // Interrupt: a value typed mid-run could be echoed by the running turn, and
    // the whole point of the card is that the value stays out of the model's way.
    interrupt: true,
    run: async (ctx) => {
      const { client, seam, chatKey, spaceName, threadName, display, text } = ctx;
      const secrets = ctx.secrets;
      if (!isAllowed(display, ctx.secretUsers ?? [])) {
        // Deliberately vague: an unauthorised user should not learn whether
        // there is a store, what is in it, or that this command exists at all.
        await client.sendMessage(spaceName, "You are not allowed to use /secret here.", threadName);
        logger.info(`[chat] ${display}: refused /secret (not in SECRET_USERS)`);
        return "ok";
      }
      if (!secrets) {
        await client.sendMessage(spaceName, "No secret store is configured on this bridge.", threadName);
        return "ok";
      }

      // `/secret` — list. `/secret set NAME` — post the value card.
      // `/secret remove NAME` — delete. Names are shown; values never are.
      const args = text.trim().replace(/^\/secret\s*/, "").trim();
      const [verb = "", ...rest] = args.split(/\s+/).filter(Boolean);
      const name = (rest[0] ?? "").toUpperCase();

      if (verb === "set" || verb === "add") {
        if (!name) {
          await client.sendMessage(
            spaceName,
            "Usage: **/secret set NAME** (value on a card) or **/secret set NAME --file /abs/path**.",
            threadName,
          );
          return "ok";
        }
        if (!isValidSecretName(name)) {
          await client.sendMessage(
            spaceName,
            `**${escapeHtml(name)}** is not a usable name: letters, digits and _ only, starting with a letter; ` +
              "PATH/HOME/PI_* are refused.",
            threadName,
          );
          return "ok";
        }

        // `--file /abs/path` points at bytes instead of storing them. This is
        // the only way to record a multi-line secret (a PEM, a service-account
        // JSON) — a card has no multi-line input — and it is the better option
        // for any long-lived credential, because the bytes never pass through
        // Chat, never enter the store, and a rotation is picked up on next use.
        const fileFlag = rest.findIndex((arg) => arg === "--file" || arg === "--path");
        if (fileFlag !== -1) {
          const filePath = rest[fileFlag + 1] ?? "";
          const scope = await seam.resolve(chatKey);
          try {
            secrets.setFile(name, filePath, display, scope ? [String(scope.conversationId)] : undefined);
            await client.sendMessage(
              spaceName,
              `Stored **${escapeHtml(name)}** as a path: \`${escapeHtml(filePath)}\`. ` +
                "Its contents are read at use time, never copied into the bridge.",
              threadName,
            );
            logger.info(`[chat] ${display}: secret ${name} stored as a path`);
          } catch (error) {
            // No value in the message: the failure is about the path, not the bytes.
            await client.sendMessage(
              spaceName,
              `Could not store **${escapeHtml(name)}**: ${escapeHtml((error as Error).message)}`,
              threadName,
            );
            logger.info(`[chat] ${display}: secret ${name} path rejected: ${(error as Error).message}`);
          }
          return "ok";
        }

        await client.createCardMessage(
          spaceName,
          secretValueCard(name, { replacing: secrets.has(name) }),
          `Enter the value for ${name}.`,
          threadName,
        );
        logger.info(`[chat] ${display}: secret value card posted for ${name}`);
        return "ok";
      }

      if (verb === "remove" || verb === "delete" || verb === "rm") {
        if (!name) {
          await client.sendMessage(spaceName, "Usage: **/secret remove NAME**.", threadName);
          return "ok";
        }
        const removed = secrets.remove(name);
        await client.sendMessage(
          spaceName,
          removed ? `Removed **${escapeHtml(name)}**.` : `No stored secret called **${escapeHtml(name)}**.`,
          threadName,
        );
        return "ok";
      }

      if (verb && verb !== "list") {
        await client.sendMessage(
          spaceName,
          "Usage: **/secret** · **/secret set NAME** · **/secret remove NAME**.",
          threadName,
        );
        return "ok";
      }

      // A card, not a text reply. A text listing is indistinguishable from any
      // other answer the bot posts, and gives no evidence that `/secret` is
      // handled by the bridge rather than by the model — which is exactly the
      // confidence an operator wants before typing a key anywhere near this bot.
      const list = secrets.list();
      await client.createCardMessage(
        spaceName,
        secretPanelCard(list),
        `Secrets: ${list.length} stored.`,
        threadName,
      );
      logger.info(`[chat] ${display}: posted secret panel (${list.length} secret(s))`);
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
    run: async ({ client, seam, chatKey, spaceName, threadName, display }) => {
      const bound = await listConversations(seam);
      if (bound.length === 0) {
        await client.sendMessage(spaceName, "No conversations yet.", threadName);
        return "ok";
      }
      const sessions: SessionInfo[] = bound.map((conversation) => ({
        label: conversation.label ?? `${path.basename(conversation.name)} · ${conversation.model}`,
        // The picker's value is the conversation id; RESUME_ACTION binds to it.
        file: String(conversation.conversationId),
        mtimeMs: conversation.createdAt,
      }));
      await client.createCardMessage(spaceName, pickerCard(sessions, chatKey), "Choose a conversation to resume.", threadName);
      logger.info(`[chat] ${display}: posted conversation picker (${sessions.length})`);
      return "ok";
    },
  },
];

/** The default model as a ModelRef, for commands that may need to create a conversation. */
async function defaultModelRef(seam: SessionHost): Promise<{ provider: string; modelId: string }> {
  const defaults = await defaultSettings(seam);
  if (defaults.provider && defaults.modelId) return { provider: defaults.provider, modelId: defaults.modelId };
  const [first] = await listModels(seam);
  if (!first) throw new Error("no model configured");
  return { provider: first.provider, modelId: first.id };
}

export async function runDurableCommand(ctx: DurableCommandContext): Promise<HandleResult | null> {
  const { client, seam, router, state, incoming, chatKey, actionKey, spaceName, threadName, display, text } = ctx;

  /**
   * Is this user allowed to touch the secret store?
   *
   * Checked here as well as in the receiver because the two frontends differ:
   * Chat events carry a sender the Pub/Sub allow-list has already vetted, but a
   * `/web` submission arrives with a Cloudflare-injected email and no Chat
   * identity at all, so `/secret` typed in the browser would otherwise bypass
   * the gate entirely. `display` is the best identity available on both paths.
   */
  const mayUseSecrets = (): boolean => isAllowed(display, ctx.secretUsers ?? []);

  if (incoming.eventType === "CARD_CLICKED") {
    if (
      (incoming.action?.actionMethodName === SECRET_ACTION ||
        incoming.action?.actionMethodName === SET_SECRET_ACTION) &&
      !mayUseSecrets()
    ) {
      // Refuse without echoing what was clicked: a rejected click should not
      // confirm to an unauthorised user that a secret store exists here.
      await client
        .updateMessageCards(incoming.message.name, errorCard("Not allowed."), "Not allowed.")
        .catch((err) => logger.error("[chat] card update failed:", (err as Error).message));
      logger.info(`[chat] ${display}: refused secret card action (not in SECRET_USERS)`);
      return "ok";
    }
    if (incoming.action?.actionMethodName === THINKING_LEVELS_ACTION) {
      const mode = actionParam(incoming, "mode") === "settings" ? "settings" : "model";
      const picked = formValue(incoming, mode === "settings" ? "default_model_picker" : "model_picker");
      if (!picked) {
        logger.info(`[chat] ${display}: ${THINKING_LEVELS_ACTION} without a selected value — card left as-is`);
        return "ok";
      }
      const [provider = "", modelId = ""] = picked.split("|");
      const supportedLevels = supportedThinkingLevels(await listModels(seam), provider, modelId);
      const models = await listModels(seam);
      const label = models.find((m) => m.provider === provider && m.id === modelId)?.label ?? modelId;

      if (mode === "settings") {
        await client
          .updateMessageCards(
            incoming.message.name,
            settingsCard(models, await defaultSettings(seam), { currentValue: picked, supportedLevels }),
            `Defaults — ${label}: thinking levels ${supportedLevels?.join(", ") ?? "(unknown)"}`,
          )
          .catch((err) => logger.error("[chat] card update failed:", (err as Error).message));
        return "ok";
      }

      const status = await conversationStatus(seam, chatKey);
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
      const status = await conversationStatus(seam, chatKey);
      const targetKey = !status.isNew ? actionKey : chatKey !== spaceName ? chatKey : actionKey;

      const result = await applyModelPick(seam, targetKey, {
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
      const result = await applyDefaultSettings(seam, {
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
      const bound = Number.isFinite(conversationId) && (await rebind(seam, actionKey, conversationId));
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

    if (incoming.action?.actionMethodName === SECRET_ACTION) {
      // The panel's "add" button. The name can arrive two ways: as a card
      // parameter (older cards, and the `/secret set NAME` path) or typed into
      // the panel's text input, which is what the current card offers.
      const name = (formValue(incoming, "secret_name") ?? actionParam(incoming, "name") ?? "")
        .trim()
        .toUpperCase();
      if (!name) {
        await client
          .updateMessageCards(incoming.message.name, errorCard("No name given."), "No name given.")
          .catch((err) => logger.error("[chat] card update failed:", (err as Error).message));
        return "ok";
      }
      if (!isValidSecretName(name)) {
        await client
          .updateMessageCards(
            incoming.message.name,
            errorCard(`${name} is not a usable name (A-Z, 0-9 and _; not PATH/HOME/PI_*).`),
            "Invalid secret name.",
          )
          .catch((err) => logger.error("[chat] card update failed:", (err as Error).message));
        return "ok";
      }
      await client
        .updateMessageCards(
          incoming.message.name,
          secretValueCard(name, { replacing: ctx.secrets?.has(name) }),
          `Enter the value for ${name}.`,
        )
        .catch((err) => logger.error("[chat] card update failed:", (err as Error).message));
      logger.info(`[chat] ${display}: secret prompt posted for ${name}`);
      return "ok";
    }

    if (incoming.action?.actionMethodName === REMOVE_SECRET_ACTION) {
      const secrets = ctx.secrets;
      if (!secrets) {
        await client
          .updateMessageCards(incoming.message.name, errorCard("No secret store configured."), "No secret store.")
          .catch((err) => logger.error("[chat] card update failed:", (err as Error).message));
        return "ok";
      }
      const picked = formValue(incoming, "secret_remove_picker");
      // No selection yet: the panel's "Remove…" button renders the picker in
      // place. A picked value means the form was submitted for real.
      if (!picked) {
        const list = secrets.list();
        await client
          .updateMessageCards(
            incoming.message.name,
            list.length > 0 ? secretRemoveCard(list) : errorCard("No secrets stored."),
            list.length > 0 ? "Pick a secret to remove." : "No secrets stored.",
          )
          .catch((err) => logger.error("[chat] card update failed:", (err as Error).message));
        return "ok";
      }
      const removed = secrets.remove(picked);
      await client
        .updateMessageCards(
          incoming.message.name,
          secretConfirmCard({ ok: removed, name: picked, action: removed ? "removed" : "failed", detail: "no such secret" }),
          removed ? `Removed ${picked}.` : `No stored secret called ${picked}.`,
        )
        .catch((err) => logger.error("[chat] card update failed:", (err as Error).message));
      logger.info(`[chat] ${display}: card removal of ${picked} -> ${removed ? "removed" : "not found"}`);
      return "ok";
    }

    if (incoming.action?.actionMethodName === SET_SECRET_ACTION) {
      const name = (actionParam(incoming, "name") ?? "").trim().toUpperCase();
      const value = formValue(incoming, "secret_value") ?? "";
      const secrets = ctx.secrets;
      // The value must not survive into a log line, a notice, or a card body.
      // Everything logged below is the name and a size — never the value.
      if (!secrets) {
        await client
          .updateMessageCards(incoming.message.name, errorCard("No secret store configured."), "No secret store.")
          .catch((err) => logger.error("[chat] card update failed:", (err as Error).message));
        return "ok";
      }
      const problem = !name
        ? "no name on the card"
        : !isValidSecretName(name)
          ? `${name} is not a usable name`
          : valueProblem(value);
      if (problem) {
        await client
          .updateMessageCards(
            incoming.message.name,
            secretConfirmCard({ ok: false, name: name || "(unnamed)", action: "failed", detail: problem }),
            "Secret not saved.",
          )
          .catch((err) => logger.error("[chat] card update failed:", (err as Error).message));
        logger.info(`[chat] ${display}: secret ${name || "(unnamed)"} rejected: ${problem}`);
        return "ok";
      }
      try {
        // Scope to this conversation, not every conversation on the bridge. The
        // id is what a bash `prepare` hook can see; the chatKey is not.
        const binding = await seam.resolve(chatKey);
        secrets.set(name, value, display, binding ? [String(binding.conversationId)] : undefined);
        await client
          .updateMessageCards(
            incoming.message.name,
            secretConfirmCard({ ok: true, name, action: "stored" }),
            `Stored ${name}.`,
          )
          .catch((err) => logger.error("[chat] card update failed:", (err as Error).message));
        logger.info(`[chat] ${display}: secret ${name} stored (${value.length} chars)`);
      } catch (error) {
        const detail = (error as Error).message;
        await client
          .updateMessageCards(
            incoming.message.name,
            secretConfirmCard({ ok: false, name, action: "failed", detail }),
            "Secret not saved.",
          )
          .catch((err) => logger.error("[chat] card update failed:", (err as Error).message));
        logger.error(`[chat] ${display}: secret ${name} failed: ${detail}`);
      }
      return "ok";
    }

    logger.info(`[chat] ${display}: unhandled card action`);
    return "ok";
  }

  const trimmed = text.trim();
  for (const command of SLASH_COMMANDS) {
    if (!command.pattern.test(trimmed)) continue;
    if (command.interrupt && (await isBusy(seam, chatKey))) await stopConversation(seam, chatKey);
    return command.run(ctx);
  }
  return null;
}

/** Stop whatever the conversation is doing. False when there was nothing to stop. */
async function stopConversation(seam: SessionHost, chatKey: string): Promise<boolean> {
  const named = await seam.resolve(chatKey);
  if (!named) return false;
  return seam.abort(named.conversationId);
}

/** Whether a run currently owns the conversation. */
async function isBusy(seam: SessionHost, chatKey: string): Promise<boolean> {
  // Read-only: a command must never be the thing that creates a conversation,
  // which is why this resolves first instead of asking for a conversation.
  const named = await seam.resolve(chatKey);
  if (!named) return false;
  return (await seam.snapshot(named.conversationId))?.busy ?? false;
}
