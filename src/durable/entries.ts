/**
 * Entries: what a conversation has said, read forward from a cursor.
 *
 * The primitive every surface reads through — the painter most of all — and it lives on its own
 * now that the shadow pass it was written for is gone. Two rules are load-bearing, both about the
 * unit:
 *
 *   - a surface shows **entries**, not transcript messages. One entry can hold several messages (a
 *     turn's text and its image, an answer split across blocks) and must still become one message
 *     out, so messages are grouped by entry id and the last of each group is kept.
 *   - reading stops as soon as the cursor is passed, working back from the newest. A bridge that is
 *     nearly caught up therefore reads one short page, and one that is far behind finds out
 *     quickly — which is what lets a caller decide "adopt instead of replay" (a cursor beyond the
 *     page budget means the gap is bigger than anything worth painting).
 */
import { logger } from "../logger.js";

/** One transcript message, as the seam reports it. Structural, so this needs no host. */
export interface MessageLike {
  role: "user" | "assistant";
  text: string;
  at?: number;
  entryId?: number;
  /** The surface that produced it, when stamped at submit time. Absent means unknown. */
  origin?: string;
}

/** One entry, ready to hand to a surface. */
export interface EntryRef {
  conversationId: number;
  entryId: number;
  /** The entry's last message is the one a surface renders. */
  role: "user" | "assistant";
  text: string;
  at?: number;
  /** Who produced it; absent when nothing stamped it (a turn's intermediate messages). */
  origin?: string;
}

/** One page-walk's worth of entries after a cursor. */
export interface EntryWindow {
  /** Entries in ascending order, grouped by entry id. */
  entries: EntryRef[];
  /** Highest entry id seen, or `0` for a conversation with nothing in it. */
  newest: number;
  /** False when the cursor was never reached — the pages ran out first. */
  reachedCursor: boolean;
}

export interface EntriesDeps {
  /** A page of messages, newest last; `offset` counts back from the newest. */
  history(conversationId: number, limit: number, offset: number): Promise<readonly MessageLike[] | undefined>;
}

/** Read entries after `cursor`, newest page first. */
export async function entriesAfter(
  deps: EntriesDeps,
  conversationId: number,
  cursor: number,
  options: { pageSize?: number; maxPages?: number } = {},
): Promise<EntryWindow> {
  const pageSize = options.pageSize ?? 50;
  const maxPages = options.maxPages ?? 10;
  const byEntry = new Map<number, EntryRef>();
  let newest = 0;
  let reachedCursor = false;

  for (let page = 0; page < maxPages; page += 1) {
    const messages = await deps.history(conversationId, pageSize, page * pageSize);
    if (!messages || messages.length === 0) {
      reachedCursor = true; // ran out of transcript: everything there is, is in hand
      break;
    }
    // A *short* page is also the end of the transcript: pages are counted back from the newest, so
    // fewer messages than asked for means the beginning was reached. Without this, a conversation
    // with three entries and a page size of 200 looks like it might have more, and callers report a
    // gap that does not exist.
    const exhausted = messages.length < pageSize;
    for (const message of messages) {
      if (message.entryId === undefined) continue;
      if (message.entryId > newest) newest = message.entryId;
      if (message.entryId <= cursor) reachedCursor = true;
      // The *last* message of an entry wins: that is the answer for an assistant entry, and it
      // carries the origin the prompt or answer was stamped with.
      byEntry.set(message.entryId, {
        conversationId,
        entryId: message.entryId,
        role: message.role,
        text: message.text,
        ...(message.at === undefined ? {} : { at: message.at }),
        ...(message.origin === undefined ? {} : { origin: message.origin }),
      });
    }
    if (exhausted) {
      reachedCursor = true;
      break;
    }
    if (reachedCursor) break;
  }

  // Filtered here rather than by every caller: the function is called "after a cursor" and both
  // callers want exactly that. The ones at or below it are still *read* (that is how the cursor is
  // recognised), but they are not entries this window is reporting.
  const entries = [...byEntry.values()]
    .filter((entry) => entry.entryId > cursor)
    .sort((a, b) => a.entryId - b.entryId);
  return { entries, newest, reachedCursor };
}

/**
 * Log helper kept beside the reader: a history read that fails is a conversation to skip, not a
 * process to stop.
 */
export function logUnreadable(conversationId: number, error: unknown): void {
  logger.warn(`[entries] conversation ${conversationId}: ${(error as Error).message}`);
}
