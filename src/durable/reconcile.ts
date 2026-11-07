/**
 * Does the cursor match what the bridge actually posted?
 *
 * The ledger is a claim about what a surface has been shown. While the legacy path
 * is still the thing that shows it, that claim is only as good as my belief about
 * it — and the failure that matters is silent: a cursor that has moved past an
 * answer nobody ever posted looks exactly like a healthy one.
 *
 * So this compares the two, and it is deliberately the *bridge* that does it: the
 * cursor is the bridge's memory and the poster is the bridge's mouth, so a
 * disagreement is the bridge's own problem to notice. Nothing here is on the
 * delivery path — it observes, logs, and never repairs, because a repair invented
 * from a guess is how you turn one divergence into two.
 *
 * Two directions, and they mean different things:
 *
 *   - **Confirmed but not posted.** The cursor has learned about an answer the
 *     mouth never delivered. Either the post failed, or the cursor is wrong.
 *   - **Posted but cursor behind.** The mouth delivered something the cursor has
 *     not reached. Usually just latency — the pass has not run yet — so this one
 *     waits, and only a *sustained* lag is worth a line.
 *
 * Both get a grace period of one pass. Observing an answer a second before it is
 * posted is normal and must not be reported as a fault: the pass runs on a timer
 * and the poster runs on a turn, and they are allowed to overlap.
 */
import { logger } from "../logger.js";

/** An answer entry the ledger has confirmed, i.e. claims is on the surface. */
export interface ConfirmedAnswer {
  conversationId: number;
  entryId: number;
}

/** What the reconciler remembers between passes. Small, in-memory, lost on restart. */
export interface ReconcileState {
  /** Key → when it was first seen in that condition, and whether it was reported. */
  pending: Record<string, { since: number; reported: boolean }>;
}

export interface ReconcileDeps {
  /** The highest answer this bridge actually posted in a conversation, if any. */
  lastPosted(conversationId: number): Promise<number | undefined>;
  /** How long a disagreement may persist before it is reported. One pass, plus slack. */
  graceMs?: number;
  now?(): number;
}

export interface ReconcileResult {
  /** Confirmed answers that were never posted, past the grace period. */
  unposted: ConfirmedAnswer[];
  /** Answers posted while the cursor stayed behind, past the grace period. */
  lagging: { conversationId: number; cursor: number; posted: number }[];
  /** How many disagreements cleared on their own this round. */
  recovered: number;
  state: ReconcileState;
}

const DEFAULT_GRACE_MS = 5 * 60 * 1000;

/**
 * Compare one pass's confirmations and cursors against what was posted.
 *
 * Returns what crossed the grace period and a new state to carry into the next
 * pass. Never throws: a diagnostic that can fail a turn is worse than no
 * diagnostic.
 */
export async function reconcile(
  state: ReconcileState,
  input: {
    confirmed: readonly ConfirmedAnswer[];
    /** The ledger's cursor per conversation, for the other direction. */
    cursors: readonly { conversationId: number; cursor: number }[];
  },
  deps: ReconcileDeps,
): Promise<ReconcileResult> {
  const now = deps.now ?? (() => Date.now());
  const grace = deps.graceMs ?? DEFAULT_GRACE_MS;
  const pending: ReconcileState["pending"] = {};
  const unposted: ConfirmedAnswer[] = [];
  const lagging: ReconcileResult["lagging"] = [];
  let recovered = 0;

  const keep = (key: string): { since: number; reported: boolean } => {
    const previous = state.pending[key];
    const entry = previous ?? { since: now(), reported: false };
    pending[key] = entry;
    return entry;
  };
  const due = (entry: { since: number; reported: boolean }): boolean =>
    !entry.reported && now() - entry.since >= grace;
  const mark = (entry: { since: number; reported: boolean }): void => {
    entry.reported = true;
  };

  // --- Direction one: an answer the ledger confirmed that was never posted. ---
  for (const answer of input.confirmed) {
    const key = `unposted:${answer.conversationId}:${answer.entryId}`;
    const posted = await deps.lastPosted(answer.conversationId).catch(() => undefined);
    if (posted !== undefined && posted >= answer.entryId) {
      if (state.pending[key]) recovered += 1; // it was late; now it is there
      continue;
    }
    const entry = keep(key);
    if (due(entry)) {
      mark(entry);
      unposted.push(answer);
      logger.error(
        "[ledger] divergence: conversation " +
          `${answer.conversationId} entry ${answer.entryId} is accounted for by the cursor but ` +
          `the highest answer posted is ${posted ?? "none"} — the thread is missing an answer`,
      );
    }
  }

  // --- Direction two: something posted that the cursor has not reached. ---
  for (const { conversationId, cursor } of input.cursors) {
    const key = `lagging:${conversationId}`;
    const posted = await deps.lastPosted(conversationId).catch(() => undefined);
    if (posted === undefined || posted <= cursor) {
      if (state.pending[key]) recovered += 1;
      continue;
    }
    const entry = keep(key);
    if (due(entry)) {
      mark(entry);
      lagging.push({ conversationId, cursor, posted });
      logger.warn(
        `[ledger] conversation ${conversationId}: cursor ${cursor} is behind the last posted answer ${posted}` +
          " — the walk is not advancing there",
      );
    }
  }

  // Anything not seen this round has cleared; forgetting it is what makes the next
  // occurrence report immediately rather than staying quiet for hours.
  return { unposted, lagging, recovered, state: { pending } };
}
