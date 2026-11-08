/**
 * A bridge's own memory of how far it has got — one number.
 *
 * The cursor is **global**: entry ids come from one monotonic sequence across every conversation,
 * so a single integer addresses "everything that has happened, in order". That is what makes the log
 * streamable (`GET /v1/events?since=`), and it is why this file no longer holds a map of
 * per-conversation positions: one cursor is the position, and "which conversation" is a property of
 * the entry rather than of the reader's memory.
 *
 * This is the whole of a bridge's durable state, and it lives next to the bridge rather than in the
 * conversation server, on purpose. The server owns what happened; a bridge owns *how much of it this
 * surface has seen*. A bridge is temporary — its surface can be closed for a week, its process
 * restarted, its state file lost — and none of that is a fact about the conversation.
 *
 * Three rules that keep this from becoming a liability:
 *
 *   1. **Adopt at the head, never at zero.** A bridge with no position starts from the newest entry
 *      and says so. Starting at zero would replay a captured conversation — a week of history — as a
 *      burst of messages the moment a state file is missing or a deployment is copied.
 *   2. **A lost position is not a lost conversation.** Nothing is ever posted twice *because* state
 *      was lost: the head is the boundary.
 *   3. **A corrupt file is treated as absent.** Refusing to start because a cursor cannot be parsed
 *      would make bookkeeping more important than the job. It is logged and replaced.
 */
import fsp from "node:fs/promises";
import path from "node:path";

import { logger } from "../logger.js";

/** Why a position was established. Recorded for the log, not for logic. */
export type AdoptionReason = "new" | "gap" | "lost-position" | "migrated";

export interface LedgerValue {
  version: 2;
  /** Highest entry this bridge has accounted for, across every conversation. */
  cursor: number;
  adoptedAt: number;
  adoptedReason: AdoptionReason;
}

/**
 * One bridge's position, and the file it lives in.
 *
 * Reads are synchronous over an in-memory copy; `save()` is the only I/O that matters, and it is
 * atomic (write beside, then rename) so a kill mid-write cannot leave a half-written cursor that
 * reads as "no position at all".
 */
export class Ledger {
  private constructor(
    private readonly file: string,
    private value: LedgerValue,
    /** True when a file existed but could not be read: the position was adopted afresh. */
    readonly recovered: boolean,
  ) {}

  /** Load the ledger at `file`, or start empty. Never throws for a bad file. */
  static async load(file: string): Promise<Ledger> {
    const fresh = (): LedgerValue => ({
      version: 2,
      cursor: 0,
      adoptedAt: Date.now(),
      adoptedReason: "new",
    });
    try {
      const raw = await fsp.readFile(file, "utf8");
      const parsed = JSON.parse(raw) as
        | (Partial<LedgerValue> & { conversations?: Record<string, { cursor?: number }> })
        | { version?: number };
      const asV2 = parsed as Partial<LedgerValue>;
      if (asV2.version === 2 && typeof asV2.cursor === "number") {
        return new Ledger(
          file,
          {
            version: 2,
            cursor: asV2.cursor,
            adoptedAt: typeof asV2.adoptedAt === "number" ? asV2.adoptedAt : Date.now(),
            adoptedReason: (asV2.adoptedReason as AdoptionReason) ?? "new",
          },
          false,
        );
      }
      // Version 1 kept a position *per conversation*. The global cursor is the highest of those: a
      // conversation that was behind is behind the global cursor anyway, and the sweep reads forward
      // from the cursor per conversation, so nothing is skipped by taking the maximum.
      const asV1 = parsed as { version?: number; conversations?: Record<string, { cursor?: number }> };
      if (asV1.version === 1 && asV1.conversations && typeof asV1.conversations === "object") {
        const cursors = Object.values(asV1.conversations)
          .map((entry) => (typeof entry?.cursor === "number" ? entry.cursor : 0))
          .filter((cursor) => Number.isFinite(cursor));
        const cursor = cursors.length === 0 ? 0 : Math.max(...cursors);
        logger.info(`[ledger] ${file}: migrated ${cursors.length} per-conversation positions to one cursor ${cursor}`);
        return new Ledger(file, { version: 2, cursor, adoptedAt: Date.now(), adoptedReason: "migrated" }, false);
      }
      logger.warn(`[ledger] ${file}: unrecognised contents — starting from the head`);
      return new Ledger(file, fresh(), true);
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      // A missing file is the normal first start. Anything else is damage worth a line in the log,
      // because the adoptions that follow are not the bridge's real history.
      if (!missing) logger.warn(`[ledger] ${file}: unreadable (${(error as Error).message}) — adopting afresh`);
      return new Ledger(file, fresh(), !missing);
    }
  }

  /** True when this bridge has ever taken a position. */
  hasPosition(): boolean {
    return this.value.cursor > 0;
  }

  /** The highest entry accounted for, across every conversation. */
  get cursor(): number {
    return this.value.cursor;
  }

  /** When and why the position was first taken. */
  get adoptedReason(): AdoptionReason {
    return this.value.adoptedReason;
  }

  /** True when a position was established by reading a file that could not be parsed. */
  get isFresh(): boolean {
    return this.value.cursor === 0;
  }

  /**
   * Take a position without having posted anything, because there is nothing to post: everything up
   * to here was another path's work, or predates this bridge.
   */
  adopt(cursor: number, reason: AdoptionReason, at = Date.now()): void {
    this.value = { version: 2, cursor, adoptedAt: at, adoptedReason: reason };
  }

  /** Account for an entry. The cursor never goes backwards, so out-of-order calls are harmless. */
  advance(entryId: number): void {
    if (!Number.isFinite(entryId) || entryId <= this.value.cursor) return;
    this.value = { ...this.value, cursor: entryId };
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
    return { ...this.value };
  }
}
