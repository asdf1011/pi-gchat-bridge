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
 * **Conversation-scoped, not session-scoped.** The stamp is a property of one
 * message in one conversation, so that is where it is stored: stamping a turn reads
 * and writes only that conversation's document, and no conversation can evict
 * another's history.
 *
 * It used to live in one session-wide map keyed `"<conversationId>:<entryId>"`, with
 * a cap of 5,000 stamps pruned oldest-first. That was a read optimisation — one
 * snapshot served every conversation's stamps — paid for with two defects: the cap
 * silently truncated a record that readers may want to *query* long after the bridge
 * has caught up, and every write rebuilt the shared map. A session-scoped document is
 * also written on the session's mutation line, so a stamp for one conversation
 * contended with every other write in the process. Neither cost survives contact with
 * the domain: an origin is per message, so a per-conversation document is the shape
 * the data already had.
 *
 * The per-conversation cap is retention, not correctness. A conversation holds its own
 * stamps, so nothing here can lose another conversation's — and a thousand entries is
 * far past any bridge that could still be behind.
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
  /** Entry id, as a string, → stamp. */
  byEntry: Record<string, EntryOrigin>;
};

/**
 * How many stamps one conversation keeps.
 *
 * A stamp is a few dozen bytes, and this is routing metadata for live traffic rather
 * than history. The number is per conversation, so it is a retention rule — an entry
 * this far behind is behind any bridge that could still be catching up — and never a
 * budget one conversation can spend on behalf of another.
 */
export const MAX_ORIGINS_PER_CONVERSATION = 1000;

export const OriginsDoc = defineDoc<OriginsValue>({
  kind: "gchat.origins",
  version: 2,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ byEntry: {} }),
  checkpointWhen: () => true,
  /**
   * There is no in-place migration, and none is possible: version 1 was one document for
   * every conversation, this is one document per conversation. A `migrate()` would fire
   * when a document of this kind is loaded at this scope, and no such document exists —
   * the old value sits under a different scope entirely. The conversion is therefore a
   * step that reads the old document and writes the new ones, and it is
   * `BridgeHost.backfillOrigins()`.
   */
});

/** The key one entry's stamp is filed under. */
export function originKey(entryId: number): string {
  return String(entryId);
}

/** The stamp for one entry, if it has one. */
export function originOf(
  value: OriginsValue | undefined,
  entryId: number,
): EntryOrigin | undefined {
  return value?.byEntry[originKey(entryId)];
}

/**
 * The stamp for whichever entry a submission created.
 *
 * Linear over the conversation's stamps, and deliberately not indexed. It is a point
 * query on a field that is unique and always present, so an inverse map
 * (`submission` → `entryId`) would make it O(1) — but the map would be a second copy
 * with an invariant to keep, and this is not where the time goes: measured at the cap
 * (1,000 stamps), worst case, it is **0.069 ms** per lookup, against the ~5 ms the
 * transaction itself costs and the seconds to minutes a turn takes. Two of these per
 * turn is noise, and `withOrigin`'s sort only runs when the cap is crossed.
 *
 * If a future document holds far more stamps, the fix is the inverse map written
 * alongside `byEntry` in the same value — not a bigger `MAX_ORIGINS_PER_CONVERSATION`.
 */
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
  entryId: number,
  stamp: EntryOrigin,
): OriginsValue {
  const byEntry: Record<string, EntryOrigin> = { ...(value?.byEntry ?? {}) };
  byEntry[originKey(entryId)] = stamp;
  const keys = Object.keys(byEntry);
  if (keys.length > MAX_ORIGINS_PER_CONVERSATION) {
    // Oldest first, and only as many as overflowed: dropping a record costs one
    // "unknown origin", which every reader already handles without guessing.
    const oldest = keys
      .sort((a, b) => (byEntry[a]?.at ?? 0) - (byEntry[b]?.at ?? 0))
      .slice(0, keys.length - MAX_ORIGINS_PER_CONVERSATION);
    for (const key of oldest) delete byEntry[key];
  }
  return { byEntry };
}

/**
 * The version-1 document, kept only so its contents can be read.
 *
 * Never written and never migrated: `backfillOrigins()` reads it once and copies each
 * conversation's stamps into that conversation's own document. It stays declared
 * because the kind is what addresses the value in storage — deleting this would not
 * delete the data, only the ability to find it.
 *
 * Session scope, deliberately: that is where the data *is*, and a definition that says
 * otherwise would look for it somewhere it was never written.
 */
export type LegacyOriginsValue = {
  /** `"<conversationId>:<entryId>"` → stamp. */
  byEntry: Record<string, EntryOrigin>;
};

export const LegacyOriginsDoc = defineDoc<LegacyOriginsValue>({
  kind: "gchat.origins",
  version: 1,
  scope: "session",
  initial: () => ({ byEntry: {} }),
  checkpointWhen: () => true,
});
