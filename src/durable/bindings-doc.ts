/**
 * Bindings — which pi-durable conversation a Chat thread talks to.
 *
 * A Chat thread (and, for non-threaded DMs, a space) is the unit the user thinks
 * in; a pi-durable conversation is the unit the harness runs. This document is
 * the join between them, and it replaces two pieces of the old bridge:
 *
 *   - `session-key.ts` / `keyFor()` naming: the key is still derived the same
 *     way, but it now points at a conversation ID instead of a JSONL filename.
 *   - `state.json`'s `resumeMap`: the binding lives in the same storage as the
 *     transcript, so it is committed atomically with the conversation that
 *     creates it. There is no window where a conversation exists but the bridge
 *     has forgotten which thread owns it.
 *
 * Session-scoped (not conversation-scoped) because it indexes conversations:
 * a conversation document belongs to one conversation and cannot name others.
 *
 * Per-conversation agent choices live in pi-durable's own `pi.agent` document
 * (`conversation.configure()`), not here — that is the durable equivalent of the
 * `model_change` / `thinking_level_change` entries the old bridge appended. The
 * copy kept here is for the Chat-side cards, which need to render a choice
 * without opening the conversation.
 */
import { defineDoc } from "@earendil-works/pi-durable";

export type ConversationBinding = {
  /** pi-durable conversation ID (a branded number; stored as a plain number). */
  conversationId: number;
  /** "provider/modelId" as the user last chose it, for the `/model` card. */
  model: string;
  /** Thinking level as last chosen, when the model supports one. */
  thinking?: string;
  /** Epoch ms, so a future `/sessions` can sort by recency without opening each conversation. */
  createdAt: number;
};

// A type alias, not an interface: pi-durable's JsonObject accepts literals with
// an implicit index signature, and interfaces do not get one.
export type BindingsValue = {
  /** Chat conversation key (`keyFor(space, thread, threadKey)`) → binding. */
  byChatKey: Record<string, ConversationBinding>;
};

export const BindingsDoc = defineDoc<BindingsValue>({
  kind: "gchat.bindings",
  version: 1,
  scope: "session",
  initial: () => ({ byChatKey: {} }),
  // Every write is a base: the map is small, and replaying deltas against a
  // map that other writers may have pruned is not worth the storage saved.
  checkpointWhen: () => true,
});
