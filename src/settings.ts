/**
 * Settings, and the results of changing them.
 *
 * These lived in `agent-sessions.ts`, the SDK host's session registry, which meant the *adapter*
 * imported a 1,123-line class module to name four result shapes. They are the durable command
 * layer's vocabulary — a model pick, a thinking level, a label — so they live on their own, and the
 * registry can be deleted without taking them with it.
 */

/** A session offered in the resume picker. */
import { THINKING_LEVELS } from "./constants.js";

export interface SessionInfo {
  /** Display label (derived from the file name). */
  label: string;
  /** Absolute path to the session JSONL. */
  file: string;
  /** For sorting (most recently modified first). */
  mtimeMs: number;
}

/** Result of applying a conversation's model + thinking level. */
export interface ConversationSettingsResult {
  ok: boolean;
  /** Display label of the model now in use (or the one that failed). */
  modelLabel: string;
  /** Effective thinking level after pi clamped it to the model's capabilities. */
  thinkingLevel?: string;
  /** The level that was asked for, when pi had to clamp it to something else. */
  clampedFrom?: string;
  error?: string;
  /** True when the pick created a brand-new conversation session. */
  created?: boolean;
}

/** The bridge's global defaults for NEW conversations (settings.json). */
export interface DefaultSettings {
  provider?: string;
  modelId?: string;
  /** Display label of the default model. */
  modelLabel?: string;
  /** `defaultThinkingLevel`; unset means pi falls back to "medium". */
  thinkingLevel?: string;
}

/** Result of changing the global defaults. */
export interface DefaultSettingsResult {
  ok: boolean;
  modelLabel: string;
  thinkingLevel?: string;
  error?: string;
}

/** Aggregate token usage for a conversation, summed from its session file. */
export interface SessionUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

/** Current context-window occupancy for a conversation (estimate). */
export interface SessionContext {
  /** Tokens in the window now; null when unknown (e.g. after compaction, before the next response). */
  tokens: number | null;
  /** The model's context window size. */
  window: number;
  /** Percent of the window used; null when tokens are unknown. */
  percent: number | null;
}

/** The thinking levels a model supports — pi's own rule (pi-ai
 *  `getSupportedThinkingLevels`, which the SDK doesn't re-export): a
 *  non-reasoning model is `off` only; otherwise every level except those the
 *  model's `thinkingLevelMap` nulls out, and `xhigh`/`max` only when mapped. */
export function supportedThinkingLevels(model: {
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
}): string[] {
  if (!model.reasoning) return ["off"];
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

/** pi's clamp rule: the requested level when supported, else the nearest
 *  supported level ABOVE it, else the nearest below (pi-ai
 *  `clampThinkingLevel`, also not re-exported). Used to preview what a model
 *  switch will actually do, so the card never shows a level that can't happen. */
export function clampToSupported(levels: string[], level: string | undefined): string | undefined {
  if (!level) return undefined;
  if (levels.includes(level)) return level;
  const requestedIndex = THINKING_LEVELS.indexOf(level as (typeof THINKING_LEVELS)[number]);
  if (requestedIndex === -1) return levels[0];
  for (let i = requestedIndex; i < THINKING_LEVELS.length; i++) {
    if (levels.includes(THINKING_LEVELS[i])) return THINKING_LEVELS[i];
  }
  for (let i = requestedIndex - 1; i >= 0; i--) {
    if (levels.includes(THINKING_LEVELS[i])) return THINKING_LEVELS[i];
  }
  return levels[0];
}
