/**
 * Walking a conversation forward from a cursor, one entry at a time.
 *
 * This is the shape a surface's painter will have: read what is after the cursor,
 * hand each entry to the surface, confirm, advance. Today it runs in **shadow
 * mode** — it posts nothing and logs what it *would* post — because that is the
 * only way to prove the cursor arithmetic without any risk to message delivery. The
 * commit history of this file should read "shadow first, then the painter".
 *
 * The unit is the *entry*, not the transcript message. One entry can carry several
 * messages (a turn's user text and its image, an assistant answer split across
 * blocks), and one answer entry must become exactly one message on a surface. So
 * messages are grouped by `entryId` and each entry is handed over once.
 *
 * Two failure modes are handled here rather than left to the caller:
 *
 *   - **The gap.** If the bridge was away long enough that the cursor is beyond the
 *     pages this pass is willing to read, it does not silently jump: it adopts at
 *     the head, says so in the log, and starts from there. "I missed a lot" is a
 *     fact worth printing; "I skipped 300 entries" is not a fact anyone can act on.
 *   - **The unfinished post.** A previous run left an in-flight marker, which means
 *     one message may already be on the surface. The pass reports it instead of
 *     quietly re-posting or quietly advancing past it.
 *
 * The first question a pass asks about an entry is not "what does it say" but "is
 * that mine". A surface that paints a conversation into its own transport must leave
 * alone what that transport already holds: a message typed in Chat is already in
 * Chat, and posting it back as the bot is the assistant replying to itself. So each
 * entry carries the surface that produced it (`origins-doc.ts`), and the pass skips
 * its own.
 *
 * Unknown origin is the interesting case, and it is answered by role rather than by
 * a default:
 *
 *   - a **user** entry with no origin is left alone — the only surface that can
 *     already hold it is the one that received it, and posting somebody's own words
 *     back at them is worse than a missing signpost;
 *   - an **assistant** entry with no origin is presented — an answer is only ever
 *     put on a surface by a bridge, so an answer nobody claims is one this bridge
 *     should probably show.
 *
 * Both are logged, because "unknown" means a stamp was lost or predates the field,
 * and a decision made from an absence should be visible rather than quiet.
 *
 * `history` pages *backwards* from the newest message (the seam's own convention),
 * which is the right direction for this: a bridge that is nearly caught up reads
 * one short page, and a bridge that is far behind notices it quickly.
 */
import type { Ledger } from "./ledger.js";
import { logger } from "../logger.js";

/** One transcript message, as the seam reports it. Structural, so this needs no host. */
export interface MessageLike {
  role: "user" | "assistant";
  text: string;
  at?: number;
  entryId?: number;
  /** The surface that produced it, when stamped at submit time. */
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
  /** Who produced it: this surface, another one, or nobody knows. */
  origin?: string;
}

export interface PassDeps {
  /**
   * The surface this bridge speaks for — `gchat`, `webui`.
   *
   * Entries stamped with this name are already on the surface and are skipped;
   * entries stamped with another one are the reason the pass exists.
   */
  surface: string;
  /** Conversations this bridge might own. `name` is the address, e.g. `spaces/S/threads/T`. */
  conversations(): Promise<readonly { conversationId: number; name: string; lastActivityAt?: number }[]>;
  /** A page of messages, newest last; `offset` counts back from the newest. */
  history(
    conversationId: number,
    limit: number,
    offset: number,
  ): Promise<readonly MessageLike[] | undefined>;
  /** Called for each entry after the cursor. In shadow mode this only logs. */
  present(entry: EntryRef): void | Promise<void>;
  /** True when this bridge is responsible for an address. */
  owns?(name: string): boolean;
  /** Skip conversations nobody has touched for this long. Dormant threads cost nothing. */
  activeWithinMs?: number;
  pageSize?: number;
  /** How many pages to read before calling it a gap. */
  maxPages?: number;
  now?(): number;
  log?(message: string): void;
}

/** What one pass did, for the caller's log line and for tests. */
export interface PassSummary {
  looked: number;
  adopted: number;
  /** Entries handed to `present`. */
  presented: number;
  /** Conversations whose cursor was beyond reach, and were re-adopted at the head. */
  gaps: number;
  /** Conversations with an unconfirmed post from an earlier run. */
  unfinished: number[];
  /** Entries this surface already had, and so were skipped. */
  own: number;
  /** Entries nobody claimed: user entries skipped, assistant entries presented. */
  unknown: number;
}

const SHADOW_LOG_PREFIX = "[ledger] would post";

/**
 * Run one pass: for every conversation this bridge owns, walk from its cursor to
 * the newest entry.
 *
 * Never throws for one conversation's failure — a conversation that cannot be read
 * is skipped and logged, because one unreadable thread must not stop the rest.
 */
export async function runPass(ledger: Ledger, deps: PassDeps): Promise<PassSummary> {
  const log = deps.log ?? ((message: string) => logger.info(message));
  const now = deps.now ?? (() => Date.now());
  const pageSize = deps.pageSize ?? 50;
  const maxPages = deps.maxPages ?? 10;
  const summary: PassSummary = { looked: 0, adopted: 0, presented: 0, gaps: 0, unfinished: [], own: 0, unknown: 0 };

  let conversations: Awaited<ReturnType<PassDeps["conversations"]>>;
  try {
    conversations = await deps.conversations();
  } catch (error) {
    log(`[ledger] cannot list conversations: ${(error as Error).message}`);
    return summary;
  }

  for (const conversation of conversations) {
    if (deps.owns && !deps.owns(conversation.name)) continue;
    if (deps.activeWithinMs !== undefined && conversation.lastActivityAt !== undefined) {
      if (now() - conversation.lastActivityAt > deps.activeWithinMs) continue;
    }
    summary.looked += 1;
    try {
      const result = await walk(ledger, deps, conversation.conversationId, pageSize, maxPages, now(), summary, log);
      if (result.changed) await ledger.save();
    } catch (error) {
      log(`[ledger] conversation ${conversation.conversationId}: ${(error as Error).message}`);
    }
  }
  return summary;
}

/** Walk one conversation. Split out so one failure cannot abort the pass. */
async function walk(
  ledger: Ledger,
  deps: PassDeps,
  conversationId: number,
  pageSize: number,
  maxPages: number,
  at: number,
  summary: PassSummary,
  log: (message: string) => void,
): Promise<{ changed: boolean }> {
  const position = ledger.get(conversationId);
  const window = await readWindow(deps, conversationId, position?.cursor ?? Number.POSITIVE_INFINITY, pageSize, maxPages);

  // --- No position: adopt at the head. Nothing before this bridge existed to post. ---
  if (!position) {
    const head = window.newest;
    ledger.adopt(conversationId, head, ledger.recovered ? "lost-position" : "new", at);
    summary.adopted += 1;
    log(
      `[ledger] conversation ${conversationId}: adopted at entry ${head}` +
        (ledger.recovered ? " (position file was unreadable)" : " (first sight of this conversation)"),
    );
    return { changed: true };
  }

  if (position.inFlight) {
    // Chat cannot be asked what it holds, so this is a report rather than a repair.
    summary.unfinished.push(conversationId);
    log(
      `[ledger] conversation ${conversationId}: entry ${position.inFlight.entryId} was begun at ` +
        `${new Date(position.inFlight.startedAt).toISOString()} and never confirmed — it may be on the surface twice`,
    );
  }

  // --- The cursor is out of reach: say so, and start again from the head. ---
  if (!window.reachedCursor) {
    const head = window.newest;
    ledger.adopt(conversationId, head, "gap", at);
    summary.adopted += 1;
    summary.gaps += 1;
    log(
      `[ledger] conversation ${conversationId}: cursor ${position.cursor} is further back than ` +
        `${maxPages * pageSize} entries — adopting at entry ${head} instead of replaying the gap`,
    );
    return { changed: true };
  }

  const pending = window.entries.filter((entry) => entry.entryId > position.cursor);
  if (pending.length === 0) return { changed: false };

  for (const entry of pending) {
    const verdict = ownership(entry, deps.surface);
    if (verdict === "own") {
      // Already on this surface. Advancing past it is the whole point: the cursor
      // records that it was accounted for, not that a message was sent.
      ledger.confirm(conversationId, entry.entryId);
      summary.own += 1;
      continue;
    }
    if (verdict === "skip-unknown") {
      ledger.confirm(conversationId, entry.entryId);
      summary.unknown += 1;
      log(
        `[ledger] conversation ${conversationId} entry ${entry.entryId}: no origin recorded — ` +
          "a user entry, so it is left alone rather than posted back at its author",
      );
      continue;
    }
    ledger.begin(conversationId, entry.entryId, at);
    await deps.present({
      conversationId,
      entryId: entry.entryId,
      role: entry.role,
      text: entry.text,
      ...(entry.at === undefined ? {} : { at: entry.at }),
      ...(entry.origin === undefined ? {} : { origin: entry.origin }),
    });
    ledger.confirm(conversationId, entry.entryId);
    summary.presented += 1;
    if (entry.origin === undefined) summary.unknown += 1;
    log(
      `${SHADOW_LOG_PREFIX} conversation ${conversationId} entry ${entry.entryId} ` +
        `(${entry.role}, ${entry.text.length} chars, origin ${entry.origin ?? "unknown"}) — ` +
        "shadow mode, nothing was sent",
    );
  }
  return { changed: true };
}

/**
 * What this surface should do with one entry.
 *
 * `own` — it came from this surface, so the transport already has it.
 * `skip-unknown` — nobody recorded an origin and it is a *user* entry: the only
 * surface that can already hold it is the one that received it, so the safe error is
 * to leave it (a missing signpost) rather than post somebody's words back at them.
 * `present` — another surface's, or an unclaimed answer, which is what this pass is
 * for.
 */
function ownership(entry: EntryRef, surface: string): "own" | "skip-unknown" | "present" {
  if (entry.origin === surface) return "own";
  if (entry.origin === undefined && entry.role === "user") return "skip-unknown";
  return "present";
}

interface Window {
  /** Entries in ascending order, grouped by entry id. */
  entries: EntryRef[];
  /** Highest entry id seen, or `0` for a conversation with nothing in it. */
  newest: number;
  /** False when the cursor was never reached — the pages ran out first. */
  reachedCursor: boolean;
}

/**
 * Read back from the newest message until the cursor is passed.
 *
 * Grouped by entry id because a surface posts entries, not messages: an entry with
 * an image has two messages and must still be one message out. The *last* message
 * of an entry is the one kept, which is the assistant's text for an answer.
 */
async function readWindow(
  deps: PassDeps,
  conversationId: number,
  cursor: number,
  pageSize: number,
  maxPages: number,
): Promise<Window> {
  const byEntry = new Map<number, EntryRef>();
  let newest = 0;
  let reachedCursor = false;

  for (let page = 0; page < maxPages; page += 1) {
    const messages = await deps.history(conversationId, pageSize, page * pageSize);
    if (!messages || messages.length === 0) {
      reachedCursor = true; // ran out of transcript: everything there is, is in hand
      break;
    }
    for (const message of messages) {
      if (message.entryId === undefined) continue;
      if (message.entryId > newest) newest = message.entryId;
      if (message.entryId <= cursor) reachedCursor = true;
      byEntry.set(message.entryId, {
        conversationId,
        entryId: message.entryId,
        role: message.role,
        text: message.text,
        ...(message.at === undefined ? {} : { at: message.at }),
        ...(message.origin === undefined ? {} : { origin: message.origin }),
      });
    }
    if (reachedCursor) break;
  }

  const entries = [...byEntry.values()].sort((a, b) => a.entryId - b.entryId);
  return { entries, newest, reachedCursor };
}
