/**
 * Which surface an entry came from.
 *
 * A conversation is one thing with several faces, and the faces need to tell each
 * other's work apart. Without this, a bridge that paints a conversation into its
 * own transport cannot answer the first question it has to ask: *is this message
 * already on my surface?* — a message typed in Chat is already in Chat, and posting
 * it back as the bot would make the assistant talk to itself.
 *
 * The value is a surface name, chosen by whoever submits: `gchat`, `webui`, `cron`.
 * Deliberately not an enum in the type: the set of surfaces is a deployment fact,
 * and a bridge unknown to this file should still be stampable. What matters is that
 * two surfaces never choose the same name.
 *
 * Two entries get a stamp, at two different moments:
 *
 *   - the **user entry**, when the submission that created it returns (the store has
 *     appended it by then);
 *   - the **answer entry**, when the turn settles, since the answer belongs to the
 *     surface whose message started the turn.
 *
 * Everything else — a custom entry, an annotation — has no origin and does not need
 * one: it was written by an adapter that knows who it was writing for.
 *
 * Session-scoped and capped: this is routing metadata for messages that are recent
 * because somebody is looking at them, and an origin record older than the entries a
 * bridge might still be behind on has no use. When the cap is reached the oldest
 * records go first, which is safe in the only direction that matters: losing an old
 * origin makes an entry "unknown", and unknown is handled conservatively by every
 * reader (`delivery-pass.ts`), never by assuming a surface already had it.
 */
import { defineDoc } from "@earendil-works/pi-durable";

/** One stamp: who submitted the turn this entry belongs to. */
export type EntryOrigin = {
  /** Surface that produced it — `gchat`, `webui`, `cron`, … */
  origin: string;
  /** The submission it belongs to, so an answer can inherit the prompt's surface. */
  submission?: number;
  /** Epoch ms, for pruning. */
  at: number;
};

export type OriginsValue = {
  /** `"<conversationId>:<entryId>"` → stamp. */
  byEntry: Record<string, EntryOrigin>;
};

/**
 * How many stamps are kept. A stamp is a few dozen bytes and this is routing
 * metadata for live traffic, not history: an entry old enough to fall off the end of
 * this is far behind any bridge that could still be catching up.
 */
export const MAX_ORIGINS = 5000;

export const OriginsDoc = defineDoc<OriginsValue>({
  kind: "gchat.origins",
  version: 1,
  scope: "session",
  initial: () => ({ byEntry: {} }),
  checkpointWhen: () => true,
});

export function originKey(conversationId: number, entryId: number): string {
  return `${conversationId}:${entryId}`;
}

/** The stamp for one entry, if it has one. */
export function originOf(
  value: OriginsValue | undefined,
  conversationId: number,
  entryId: number,
): EntryOrigin | undefined {
  return value?.byEntry[originKey(conversationId, entryId)];
}

/** The stamp for whichever entry a submission created. */
export function originForSubmission(
  value: OriginsValue | undefined,
  submission: number,
): EntryOrigin | undefined {
  if (!value) return undefined;
  for (const stamp of Object.values(value.byEntry)) {
    if (stamp.submission === submission) return stamp;
  }
  return undefined;
}

/**
 * Record one stamp, keeping the value bounded.
 *
 * Returns a new value rather than mutating, because it is written inside a
 * transaction: a rejected write must leave nothing half-stamped behind.
 */
export function withOrigin(
  value: OriginsValue | undefined,
  conversationId: number,
  entryId: number,
  stamp: EntryOrigin,
): OriginsValue {
  const byEntry: Record<string, EntryOrigin> = { ...(value?.byEntry ?? {}) };
  byEntry[originKey(conversationId, entryId)] = stamp;
  const keys = Object.keys(byEntry);
  if (keys.length > MAX_ORIGINS) {
    // Oldest first, and only as many as overflowed: dropping a record costs one
    // "unknown origin", which every reader already handles without guessing.
    const oldest = keys
      .sort((a, b) => (byEntry[a]?.at ?? 0) - (byEntry[b]?.at ?? 0))
      .slice(0, keys.length - MAX_ORIGINS);
    for (const key of oldest) delete byEntry[key];
  }
  return { byEntry };
}
