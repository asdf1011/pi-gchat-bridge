/**
 * Queries and per-conversation changes the Chat commands need.
 *
 * Commands are Chat-heavy (`commands.ts` builds cards), but almost every card is
 * fed by the same few facts: which model and thinking level this conversation
 * runs with, what it has cost, which models exist, which conversations are bound
 * to threads. Those live here — on top of `SessionHost`, not on top of the
 * harness — so this layer holds the *policy* (clamp a level, start a conversation
 * on a first pick) and none of the storage.
 *
 * Two things are deliberately *not* here:
 *
 *   - Default model/thinking for new conversations. That stays in pi's
 *     settings.json (`/settings`), because it is shared with the TUI and cron.
 *   - Session-file adoption (`/resume` of a pi session). Those sessions are
 *     coding-agent JSONL, not durable conversations; importing them is the
 *     one-shot M7 tool, not a runtime query.
 */
import { clampToSupported, type ConversationSettingsResult } from "../settings.js";
import { THINKING_KEEP } from "../constants.js";
import type { ConversationState, ModelInfo, NamedConversation, SessionHost } from "../session-host/api.js";

export type { ModelInfo };

/**
 * The thinking levels one model in this list supports, as the host reported them.
 *
 * A lookup, not a rule: the rule is pi's, and it lives in `settings.ts` (`supportedThinkingLevels`
 * over the model's own `reasoning`/`thinkingLevelMap`) so both surfaces — and the harness that
 * applies it — agree about which levels exist. Named for what it does, because two functions with
 * one name in one call graph is how a clamp gets applied twice.
 */
export function levelsForModel(
  models: readonly ModelInfo[],
  provider: string,
  modelId: string,
): string[] | undefined {
  return models.find((model) => model.provider === provider && model.id === modelId)?.thinkingLevels;
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
  usage?: ConversationState["usage"];
  /** Number of entries in the active transcript. */
  entries?: number;
}

/** Everything `/status` and the `/model` card need about one Chat conversation. */
export async function conversationStatus(seam: SessionHost, chatKey: string): Promise<ConversationStatus> {
  const named = await seam.resolve(chatKey);
  if (!named) return { isNew: true };

  const state = await seam.state(named.conversationId);
  if (!state) return { isNew: true };

  return {
    isNew: false,
    conversationId: state.conversationId,
    model: state.model,
    provider: state.provider,
    modelId: state.modelId,
    ...(state.thinkingLevel === undefined ? {} : { thinkingLevel: state.thinkingLevel }),
    ...(state.supportedLevels === undefined ? {} : { supportedLevels: state.supportedLevels }),
    ...(state.usage === undefined ? {} : { usage: state.usage }),
    entries: state.entries,
  };
}

/** Every model the picker should offer. */
export async function listModels(seam: SessionHost): Promise<ModelInfo[]> {
  return [...(await seam.models())];
}

/**
 * Switch one conversation's model (and thinking level).
 *
 * The clamping is policy and lives here; the commit that keeps the agent and the
 * binding in step is the host's, in one operation.
 */
export async function switchModel(
  seam: SessionHost,
  chatKey: string,
  provider: string,
  modelId: string,
  thinkingLevel?: string,
): Promise<{ model: string; thinkingLevel?: string }> {
  const binding = await seam.resolve(chatKey);
  if (!binding) throw new Error(`no conversation for ${chatKey}`);
  const levels = levelsForModel(await listModels(seam), provider, modelId);
  const level = levels ? (clampToSupported(levels, thinkingLevel) ?? levels[0]) : undefined;
  return seam.setModel(chatKey, {
    provider,
    modelId,
    ...(level === undefined ? {} : { thinkingLevel: level }),
  });
}

/**
 * Start this Chat key on a fresh conversation, leaving the old transcript in
 * storage. Used by `/new`, and by `/model` when a thread has no conversation yet.
 */
export async function startConversation(
  seam: SessionHost,
  chatKey: string,
  agent: { model: { provider: string; modelId: string }; thinkingLevel?: string },
): Promise<NamedConversation> {
  return seam.create(chatKey, {
    model: agent.model,
    ...(agent.thinkingLevel === undefined ? {} : { thinkingLevel: agent.thinkingLevel }),
  });
}

/** Bound conversations, newest first — the `/sessions` list. */
export async function listConversations(seam: SessionHost): Promise<NamedConversation[]> {
  return [...(await seam.list())];
}

/** Give a conversation a display name (`/name`). Chat-side label only. */
export async function renameConversation(seam: SessionHost, chatKey: string, name: string): Promise<boolean> {
  return seam.label(chatKey, name);
}

/**
 * Point a Chat key at an existing conversation — `/resume` from the picker.
 *
 * The previous display name is kept and the model comes from the target's own
 * agent; both are the host's business now, so this only reports success.
 */
export async function rebind(seam: SessionHost, chatKey: string, conversationId: number): Promise<boolean> {
  return (await seam.bind(chatKey, conversationId)) !== undefined;
}

/**
 * Apply a `/model` pick: switch the conversation, or start it on that model when
 * the thread has none yet.
 *
 * Returns `created` when the pick started a conversation, which the caller uses to post the
 * "Starting a new conversation…" notice and to remember the card for topic titling.
 */
export async function applyModelPick(
  seam: SessionHost,
  chatKey: string,
  request: { provider: string; modelId: string; thinkingLevel?: string },
): Promise<ConversationSettingsResult> {
  const models = await listModels(seam);
  const model = models.find((entry) => entry.provider === request.provider && entry.id === request.modelId);
  if (!model) {
    return {
      ok: false,
      modelLabel: request.modelId,
      error: `Unknown model ${request.provider}/${request.modelId}`,
    };
  }
  const label = `${model.label}${request.provider ? ` (${request.provider})` : ""}`;
  const requested = request.thinkingLevel === THINKING_KEEP ? undefined : request.thinkingLevel;
  const levels = levelsForModel(models, request.provider, request.modelId);
  // pi clamps to a level the model has; report what it will actually run.
  const clamped = levels ? clampToSupported(levels, requested) ?? levels[0] : requested;

  try {
    const existing = await seam.resolve(chatKey);
    if (existing) {
      const result = await switchModel(seam, chatKey, request.provider, request.modelId, clamped);
      return {
        ok: true,
        modelLabel: label,
        thinkingLevel: result.thinkingLevel,
        ...(result.thinkingLevel && clamped && result.thinkingLevel !== clamped ? { clampedFrom: clamped } : {}),
      };
    }
    await startConversation(seam, chatKey, {
      model: { provider: request.provider, modelId: request.modelId },
      ...(clamped ? { thinkingLevel: clamped } : {}),
    });
    return { ok: true, modelLabel: label, thinkingLevel: clamped, created: true };
  } catch (error) {
    return { ok: false, modelLabel: label, error: (error as Error).message };
  }
}
