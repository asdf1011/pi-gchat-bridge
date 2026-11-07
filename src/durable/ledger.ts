/**
 * A bridge's own memory of how far it has got.
 *
 * This is the whole of a bridge's durable state, and it lives next to the bridge
 * rather than in the conversation server on purpose. The server owns what happened;
 * a bridge owns *how much of it this surface has seen*. A bridge is temporary — its
 * surface can be closed for a week, its process restarted, its state file lost —
 * and none of that is a fact about the conversation.
 *
 * Two fields per conversation, and the second is the interesting one:
 *
 *   - `cursor` — the highest entry this bridge has accounted for.
 *   - `inFlight` — an entry it *started* handing to its surface and has not
 *     confirmed. Chat offers no idempotent create and no way to ask what it
 *     already holds, so this marker cannot prevent a duplicate; what it can do is
 *     make one *explainable*: on restart we know exactly which message may appear
 *     twice, and say so instead of shrugging.
 *
 * Three rules that keep this from becoming a liability:
 *
 *   1. **Adopt at the head, never at zero.** A bridge with no position starts from
 *      the conversation's newest entry and logs it. Starting at zero would replay
 *      a captured conversation — a week of history — as a burst of messages the
 *      moment a state file is missing or a deployment is copied.
 *   2. **A lost position is not a lost conversation.** Nothing is ever posted
 *      twice *because* state was lost: the head is the boundary, so the cost is one
 *      possibly-duplicated message from the crash window, not a replay.
 *   3. **A corrupt file is treated as absent.** Refusing to start because a cursor
 *      file cannot be parsed would make the bridge's bookkeeping more important
 *      than its job. It is logged and replaced.
 */
import fsp from "node:fs/promises";
import path from "node:path";

import { logger } from "../logger.js";

/** Why a conversation's position was established. Recorded for the log, not for logic. */
export type AdoptionReason = "new" | "gap" | "lost-position";

/** How far one bridge has got in one conversation. */
export interface ConversationCursor {
  /** Highest entry accounted for. `0` means "an empty conversation, seen at the start". */
  cursor: number;
  /** An entry this bridge began posting but never confirmed. */
  inFlight?: { entryId: number; startedAt: number };
  /** When the bridge first took a position here. */
  adoptedAt: number;
  adoptedReason: AdoptionReason;
}

export interface LedgerValue {
  version: 1;
  conversations: Record<string, ConversationCursor>;
}

/**
 * One bridge's positions, and the file they live in.
 *
 * Reads are synchronous over an in-memory copy; `save()` is the only I/O that
 * matters, and it is atomic (write beside, then rename) so a kill mid-write cannot
 * leave a half-written cursor that reads as "no position at all".
 */
export class Ledger {
  private constructor(
    private readonly file: string,
    private value: LedgerValue,
    /** True when a file existed but could not be read: positions were adopted afresh. */
    readonly recovered: boolean,
  ) {}

  /** Load the ledger at `file`, or start empty. Never throws for a bad file. */
  static async load(file: string): Promise<Ledger> {
    try {
      const raw = await fsp.readFile(file, "utf8");
      const parsed = JSON.parse(raw) as Partial<LedgerValue>;
      if (parsed?.version !== 1 || typeof parsed.conversations !== "object" || parsed.conversations === null) {
        logger.warn(`[ledger] ${file}: unrecognised contents — starting from the head of each conversation`);
        return new Ledger(file, { version: 1, conversations: {} }, true);
      }
      return new Ledger(file, { version: 1, conversations: parsed.conversations as LedgerValue["conversations"] }, false);
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      // A missing file is the normal first start. Anything else is damage worth a
      // line in the log, because it means the adoptions that follow are not the
      // bridge's real history.
      if (!missing) logger.warn(`[ledger] ${file}: unreadable (${(error as Error).message}) — adopting afresh`);
      return new Ledger(file, { version: 1, conversations: {} }, !missing);
    }
  }

  /** Where this bridge has got to in one conversation, if it has ever engaged. */
  get(conversationId: number): ConversationCursor | undefined {
    return this.value.conversations[String(conversationId)];
  }

  /** Every conversation this bridge has a position for. */
  conversations(): { conversationId: number; cursor: ConversationCursor }[] {
    return Object.entries(this.value.conversations).map(([id, cursor]) => ({
      conversationId: Number(id),
      cursor,
    }));
  }

  /**
   * Take a position at `cursor` without having posted anything, because there is
   * nothing to post: everything up to here was the other path's work, or predates
   * this bridge.
   */
  adopt(conversationId: number, cursor: number, reason: AdoptionReason, at = Date.now()): void {
    this.value.conversations[String(conversationId)] = { cursor, adoptedAt: at, adoptedReason: reason };
  }

  /** Record that this bridge is about to hand `entryId` to its surface. */
  begin(conversationId: number, entryId: number, at = Date.now()): void {
    const current = this.value.conversations[String(conversationId)];
    if (!current) return; // no position: `adopt` comes first, and a stray begin is a bug elsewhere
    this.value.conversations[String(conversationId)] = {
      ...current,
      inFlight: { entryId, startedAt: at },
    };
  }

  /** Record that `entryId` is on the surface: advance, and clear the in-flight marker. */
  confirm(conversationId: number, entryId: number): void {
    const current = this.value.conversations[String(conversationId)];
    if (!current) return;
    this.value.conversations[String(conversationId)] = {
      cursor: Math.max(current.cursor, entryId),
      adoptedAt: current.adoptedAt,
      adoptedReason: current.adoptedReason,
    };
  }

  /** Write the ledger out atomically. A failure is logged, never thrown: bookkeeping is not the job. */
  async save(): Promise<void> {
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      await fsp.writeFile(temporary, `${JSON.stringify(this.value, null, 1)}\n`, "utf8");
      await fsp.rename(temporary, this.file);
    } catch (error) {
      logger.error(`[ledger] could not save ${this.file}: ${(error as Error).message}`);
      await fsp.rm(temporary, { force: true }).catch(() => {});
    }
  }

  /** The whole value, for tests and diagnostics. */
  snapshot(): LedgerValue {
    return JSON.parse(JSON.stringify(this.value)) as LedgerValue;
  }
}
