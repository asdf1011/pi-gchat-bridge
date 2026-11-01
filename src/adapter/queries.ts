/**
 * Queries and per-conversation changes the Chat commands need.
 *
 * Commands are Chat-heavy (`commands.ts` builds cards), but almost every card is
 * fed by the same few facts: which model and thinking level this conversation
 * runs with, what it has cost, which models exist, which conversations are bound
 * to threads. Those live here, on top of pi-durable, so the command layer stays
 * about rendering and the semantics below are testable without Chat.
 *
 * Two things are deliberately *not* here:
 *
 *   - Default model/thinking for new conversations. That stays in pi's
 *     settings.json (`/settings`), because it is shared with the TUI and cron.
 *   - Session-file adoption (`/resume` of a pi session). Those sessions are
 *     coding-agent JSONL, not durable conversations; importing them is the
 *     one-shot M7 tool, not a runtime query.
 */
import {
  configure,
  type Agent,
  type AgentState,
  type ConversationId,
} from "@earendil-works/pi-durable";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type { ConversationSettingsResult } from "../agent-sessions.js";
import type { BridgeHost } from "../durable/host.js";
import { BindingsDoc, type ConversationBinding } from "../durable/bindings-doc.js";
import { THINKING_KEEP } from "../constants.js";

/** A model as the `/model` card lists it (same shape `cards.ts` already takes). */
export interface ModelInfo {
  provider: string;
  id: string;
  label: string;
}

/** The thinking levels a model supports, using pi's own rule. */
export function supportedThinkingLevels(
  models: ModelRuntime,
  provider: string,
  modelId: string,
): string[] | undefined {
  const model = models.getModel(provider, modelId);
  if (!model) return undefined;
  // A non-reasoning model is "off" only; getSupportedThinkingLevels already
  // applies the model's thinkingLevelMap, so this matches what the TUI offers.
  return model.reasoning ? getSupportedThinkingLevels(model) : ["off"];
}

/** Clamp a requested level to one the model has, like pi does when it applies it. */
export function clampThinkingLevel(levels: readonly string[], requested: string | undefined): string | undefined {
  if (requested === undefined) return levels[0];
  if (levels.includes(requested)) return requested;
  // pi clamps to the nearest supported level at or below the request; falling
  // back to the lowest keeps the card honest instead of showing a level that
  // cannot happen.
  const order = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const wanted = order.indexOf(requested);
  if (wanted < 0) return levels[0];
  for (let index = wanted; index >= 0; index -= 1) {
    if (levels.includes(order[index])) return order[index];
  }
  return levels[0];
}

export interface ConversationStatus {
  /** True when this Chat key has no conversation yet. */
  isNew: boolean;
  conversationId?: number;
  /** "provider/modelId", or undefined for a new conversation. */
  model?: string;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  supportedLevels?: string[];
  /** Totals across every model this conversation has used. */
  usage?: { input: number; output: number; total: number; cost: number };
  /** Number of entries in the active transcript. */
  entries?: number;
}

/** Sum `docs["pi.usage"]` into the totals `/status` shows. */
export function totalUsage(usageDoc: unknown): ConversationStatus["usage"] {
  const models = (usageDoc as { models?: Record<string, { input?: number; output?: number; totalTokens?: number; cost?: { total?: number } }> } | undefined)?.models;
  if (!models) return undefined;
  const totals = { input: 0, output: 0, total: 0, cost: 0 };
  for (const usage of Object.values(models)) {
    totals.input += usage.input ?? 0;
    totals.output += usage.output ?? 0;
    totals.total += usage.totalTokens ?? 0;
    totals.cost += usage.cost?.total ?? 0;
  }
  return totals.total > 0 ? totals : undefined;
}

/** Everything `/status` and the `/model` card need about one Chat conversation. */
export async function conversationStatus(host: BridgeHost, chatKey: string): Promise<ConversationStatus> {
  const binding = await host.bindingFor(chatKey);
  if (!binding) return { isNew: true };

  const conversation = await host.harness.conversation(
    binding.conversationId as ConversationId,
    host.context,
  );
  if (!conversation) return { isNew: true };

  const agent: Agent = await conversation.agent(host.context);
  const view = await conversation.viewState(host.context);
  const value = view.value as unknown as { entries?: readonly unknown[]; docs?: Record<string, unknown> };
  view.dispose();

  // A conversation always has a model once it exists (it is configured at
  // creation); the type leaves it optional because the host default can supply it.
  const model = agent.model;
  if (!model) return { isNew: false, conversationId: binding.conversationId };

  return {
    isNew: false,
    conversationId: binding.conversationId,
    model: `${model.provider}/${model.modelId}`,
    provider: model.provider,
    modelId: model.modelId,
    ...(agent.thinkingLevel ? { thinkingLevel: String(agent.thinkingLevel) } : {}),
    supportedLevels: supportedThinkingLevels(host.modelRuntime, model.provider, model.modelId),
    usage: totalUsage(value.docs?.["pi.usage"]),
    entries: value.entries?.length ?? 0,
  };
}

/** Every model the picker should offer, with availability resolved by ModelRuntime. */
export async function listModels(host: BridgeHost): Promise<ModelInfo[]> {
  const available = await host.modelRuntime.getAllAvailable();
  return available
    .filter((model) => model.type === undefined || model.type === "chat" || (model as { output?: string[] }).output?.includes("text"))
    .map((model) => ({
      provider: model.provider,
      id: model.id,
      label: model.name ?? model.id,
    }));
}

function bindingWith(binding: ConversationBinding, change: { model?: string; thinking?: string }): ConversationBinding {
  return {
    ...binding,
    ...(change.model === undefined ? {} : { model: change.model }),
    ...(change.thinking === undefined ? {} : { thinking: change.thinking }),
  };
}

/**
 * Switch one conversation's model (and thinking level).
 *
 * The agent change and the binding are written in **one commit**: the card, the
 * next request and any later `/status` then agree, with no window where the
 * conversation runs one model while the card claims another.
 */
export async function switchModel(
  host: BridgeHost,
  chatKey: string,
  provider: string,
  modelId: string,
  thinkingLevel?: string,
): Promise<{ model: string; thinkingLevel?: string }> {
  const binding = await host.bindingFor(chatKey);
  if (!binding) throw new Error(`no conversation for ${chatKey}`);

  const levels = supportedThinkingLevels(host.modelRuntime, provider, modelId);
  const level = levels ? clampThinkingLevel(levels, thinkingLevel) : undefined;
  const model = `${provider}/${modelId}`;

  await host.harness.commit(async (tx) => {
    await configure(tx, binding.conversationId as ConversationId, {
      model: { provider, modelId },
      ...(level === undefined ? {} : { thinkingLevel: level as AgentState["thinkingLevel"] }),
    });
    const doc = await tx.doc(BindingsDoc);
    const current = doc.byChatKey[chatKey];
    if (current) doc.byChatKey[chatKey] = bindingWith(current, { model, ...(level ? { thinking: level } : {}) });
  }, host.context);

  return { model, ...(level ? { thinkingLevel: level } : {}) };
}

/**
 * Start this Chat key on a fresh conversation, leaving the old transcript in
 * storage. Used by `/new`, and by `/model` when a thread has no conversation yet
 * (the pick then starts it, exactly like the old bridge).
 */
export async function startConversation(
  host: BridgeHost,
  chatKey: string,
  agent: { model: { provider: string; modelId: string }; thinkingLevel?: AgentState["thinkingLevel"] },
): Promise<ConversationBinding> {
  return host.harness.commit(async (tx) => {
    const record = await tx.createConversation({ ownership: { kind: "ownerless" } });
    await configure(tx, record.id, { model: agent.model, ...(agent.thinkingLevel ? { thinkingLevel: agent.thinkingLevel } : {}) });
    const doc = await tx.doc(BindingsDoc);
    const binding: ConversationBinding = {
      conversationId: record.id as number,
      model: `${agent.model.provider}/${agent.model.modelId}`,
      ...(agent.thinkingLevel ? { thinking: String(agent.thinkingLevel) } : {}),
      createdAt: Date.now(),
    };
    doc.byChatKey[chatKey] = binding;
    return binding;
  }, host.context);
}

/** Bound conversations, newest first — the `/sessions` list. */
export async function listConversations(host: BridgeHost): Promise<{ chatKey: string; binding: ConversationBinding }[]> {
  const all = await host.bindings();
  return Object.entries(all.byChatKey)
    .map(([chatKey, binding]) => ({ chatKey, binding }))
    .sort((a, b) => b.binding.createdAt - a.binding.createdAt);
}

/** Token/cost totals for the whole store, for a future `/status` overview. */
export async function storeUsage(
  host: BridgeHost,
): Promise<{ models: Record<string, unknown>; tools: Record<string, unknown> }> {
  return (await host.harness.usage(host.context)) as {
    models: Record<string, unknown>;
    tools: Record<string, unknown>;
  };
}

/** Give a conversation a display name (`/name`). Chat-side label only. */
export async function renameConversation(host: BridgeHost, chatKey: string, name: string): Promise<boolean> {
  return host.harness.commit(async (tx) => {
    const doc = await tx.doc(BindingsDoc);
    const current = doc.byChatKey[chatKey];
    if (!current) return false;
    doc.byChatKey[chatKey] = { ...current, name };
    return true;
  }, host.context);
}

/**
 * Point a Chat key at an existing conversation — `/resume` from the picker.
 *
 * The previous binding's display name is kept (it described the thread, not the
 * transcript); model and thinking level are taken from the target conversation's
 * own agent, so the card and `/status` describe what will actually run.
 */
export async function rebind(host: BridgeHost, chatKey: string, conversationId: number): Promise<boolean> {
  const conversation = await host.harness.conversation(conversationId as ConversationId, host.context);
  if (!conversation) return false;
  const agent = await conversation.agent(host.context);
  const target = agent.model;
  if (!target) return false;
  const level = agent.thinkingLevel;

  return host.harness.commit(async (tx) => {
    const doc = await tx.doc(BindingsDoc);
    const previous = doc.byChatKey[chatKey];
    doc.byChatKey[chatKey] = {
      conversationId,
      model: `${target.provider}/${target.modelId}`,
      ...(level ? { thinking: String(level) } : {}),
      createdAt: Date.now(),
      ...(previous?.name ? { name: previous.name } : {}),
    };
    return true;
  }, host.context);
}

/**
 * Apply a `/model` pick: switch the conversation, or start it on that model when
 * the thread has none yet.
 *
 * Mirrors the old `applyConversationSettings`, including its `created` flag,
 * which the caller uses to post the "Starting a new conversation…" notice and to
 * remember the card for topic titling.
 */
export async function applyModelPick(
  host: BridgeHost,
  chatKey: string,
  request: { provider: string; modelId: string; thinkingLevel?: string },
): Promise<ConversationSettingsResult> {
  const model = host.modelRuntime.getModel(request.provider, request.modelId);
  if (!model) return { ok: false, modelLabel: request.modelId, error: `Unknown model ${request.provider}/${request.modelId}` };
  const label = `${model.name ?? model.id}${request.provider ? ` (${request.provider})` : ""}`;
  const requested = request.thinkingLevel === THINKING_KEEP ? undefined : request.thinkingLevel;
  const levels = supportedThinkingLevels(host.modelRuntime, request.provider, request.modelId);
  // pi clamps to a level the model has; report what it will actually run.
  const clamped = levels ? clampThinkingLevel(levels, requested) : requested;

  try {
    const existing = await host.bindingFor(chatKey);
    if (existing) {
      const result = await switchModel(host, chatKey, request.provider, request.modelId, clamped);
      return {
        ok: true,
        modelLabel: label,
        thinkingLevel: result.thinkingLevel,
        ...(result.thinkingLevel && clamped && result.thinkingLevel !== clamped ? { clampedFrom: clamped } : {}),
      };
    }
    await startConversation(host, chatKey, {
      model: { provider: request.provider, modelId: request.modelId },
      ...(clamped ? { thinkingLevel: clamped as never } : {}),
    });
    return { ok: true, modelLabel: label, thinkingLevel: clamped, created: true };
  } catch (error) {
    return { ok: false, modelLabel: label, error: (error as Error).message };
  }
}
