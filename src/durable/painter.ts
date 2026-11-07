/**
 * The painter: one component that puts a conversation's turns on one surface.
 *
 * Until now two things posted into Chat and had to agree about it — the Chat handler,
 * which had the submission in hand, and the mirror, which watched settlement — so the
 * claim records (`claimAnswer`, `releaseAnswer`, `lastPostedAnswer`) existed to
 * arbitrate between them. The painter removes the arbitration by being the only mouth
 * on this surface: it reads entries after its own cursor, paints the running turn, and
 * posts the answer, in that order, for a surface it is the sole writer of.
 *
 * How it paints a turn, and why it needs the view:
 *
 *   - a running turn is *live* state, not entries, so the painter attaches to the view
 *     and drives `ReplyStream` — the placeholder, the PATCHes, the tool line. That is
 *     the same machinery the handler drives today; it moves here rather than being
 *     rewritten, because every Chat API quirk in it was paid for.
 *   - a settled turn is an *entry*, so the answer is finished from the transcript. The
 *     streamed placeholder becomes the answer (in place, no "Message deleted" stub) or,
 *     when no stream was attached — the bridge was down, or the turn settled between
 *     ticks — the answer is posted plainly.
 *
 * Two things it must not do, both learned from real data:
 *
 *   - **Post commentary.** A turn emits an assistant entry per message; only the entry
 *     the turn settles on is stamped as its answer (`origins-doc.ts`). Unstamped
 *     assistant entries are the agent saying "checking now", and painting them would
 *     turn one reply into a stream of small messages.
 *   - **Paint its own surface's words back.** An entry stamped with this surface is
 *     already there.
 *
 * The cursor is the recovery story: an answer that fails to post leaves the cursor
 * behind it, so the next tick tries again. That is strictly better than the handler's
 * one-shot post, which is why the reconciler can tell the two apart.
 */
import type { EntryRef, MessageLike } from "./delivery-pass.js";
import { entriesAfter } from "./delivery-pass.js";
import type { Ledger } from "./ledger.js";
import { quotePrompt } from "./mirror.js";
import { logger } from "../logger.js";

/**
 * What the painter needs from a surface: a live stream per conversation, and a poster.
 *
 * One call opens the stream *and* subscribes it to the turn, because the two are the
 * same act on a real transport: a Chat placeholder is created before it can be
 * patched, so "open" and "attach" cannot be separated without inventing a state
 * between them.
 */
export interface PaintSurface {
  /** Open a live stream for a conversation and start feeding it view frames. */
  open(
    conversationId: number,
  ): Promise<{ stream: PaintStream; detach(): void } | undefined>;
  /** Post a finished answer with no live stream, chunked by the surface. */
  post(conversationId: number, text: string): Promise<void>;
}

/** The slice of `ReplyStream` a painter drives. Structural, so tests need no Chat. */
export interface PaintStream {
  /** Live answer text, as a whole snapshot. */
  text(full: string): void;
  tool(name: string, args: unknown): void;
  clearTool(): void;
  /** The turn finished: `text` becomes the answer, in place where the surface allows. */
  finish(text: string): Promise<void>;
  /** The turn produced nothing: leave no placeholder behind. */
  abandon(): Promise<void>;
}

export interface PainterDeps {
  surface: string;
  ledger: Ledger;
  /** Conversations this painter owns. The rollout unit — see the migration notes. */
  owns(conversationId: number): boolean;
  /** The surface's address for a conversation, for logs. */
  address?(conversationId: number): string | undefined;
  conversations(): Promise<readonly { conversationId: number }[]>;
  history(conversationId: number, limit: number, offset: number): Promise<readonly MessageLike[] | undefined>;
  /** Is a turn running in this conversation right now? */
  busy(conversationId: number): Promise<boolean>;
  surfaceClient: PaintSurface;
  log?(message: string): void;
}

/** What one tick did, for the caller's log line and for tests. */
export interface PaintSummary {
  painted: number;
  streamed: number;
  posted: number;
  failed: number;
}

/** Live stream and view handle per conversation, held across ticks. */
interface Open {
  stream: PaintStream;
  detach(): void;
  /** The tool line currently shown, so a frame that changes nothing costs nothing. */
  tool?: string;
}

export class Painter {
  private open = new Map<number, Open>();
  private summary: PaintSummary = { painted: 0, streamed: 0, posted: 0, failed: 0 };

  constructor(private deps: PainterDeps) {}

  private log(message: string): void {
    (this.deps.log ?? ((line: string) => logger.info(line)))(message);
  }

  /** One tick over every conversation this painter owns. Never throws. */
  async tick(): Promise<PaintSummary> {
    const summary: PaintSummary = { painted: 0, streamed: 0, posted: 0, failed: 0 };
    let conversations: readonly { conversationId: number }[];
    try {
      conversations = await this.deps.conversations();
    } catch (error) {
      this.log(`[paint] cannot list conversations: ${(error as Error).message}`);
      return summary;
    }

    for (const { conversationId } of conversations) {
      if (!this.deps.owns(conversationId)) continue;
      const position = this.deps.ledger.get(conversationId);
      if (!position) continue; // no cursor: adoption belongs to the pass, not the painter
      try {
        await this.tickOne(conversationId, position.cursor, summary);
      } catch (error) {
        summary.failed += 1;
        this.log(`[paint] conversation ${conversationId}: ${(error as Error).message}`);
      }
    }
    this.summary = summary;
    return summary;
  }

  private async tickOne(conversationId: number, cursor: number, summary: PaintSummary): Promise<void> {
    const window = await entriesAfter(this.deps, conversationId, cursor, {});
    const pending = window.entries.filter((entry) => entry.entryId > cursor);
    const answer = pending.find((entry) => this.isAnswer(entry));
    const busy = await this.deps.busy(conversationId);

    // --- A settled turn: the answer is an entry, so finish from the transcript. ---
    if (answer && !busy) {
      const prompt = this.promptFor(pending, answer);
      const body = prompt ? `${quotePrompt(prompt.text)}\n\n${answer.text}` : answer.text;
      const open = this.open.get(conversationId);
      if (open) {
        // The placeholder becomes the answer where the surface allows it: no second
        // create, no "Message deleted" stub, one notification.
        await open.stream.finish(body);
        open.detach();
        this.open.delete(conversationId);
        summary.streamed += 1;
      } else {
        await this.deps.surfaceClient.post(conversationId, body);
        summary.posted += 1;
      }
      // Everything up to the answer is accounted for in one step: commentary is never
      // painted, and the answer has just been.
      this.deps.ledger.confirm(conversationId, answer.entryId);
      await this.deps.ledger.save();
      summary.painted += 1;
      this.log(
        `[paint] ${this.deps.address?.(conversationId) ?? `conversation ${conversationId}`}: ` +
          `painted answer ${answer.entryId} (${answer.text.length} chars)${prompt ? ", quoting the prompt" : ""}`,
      );
      return;
    }

    // --- A running turn: attach to the view so the surface shows progress. ---
    if (busy) {
      // Commentary before the answer is accounted for immediately: it will never be
      // painted, and holding the cursor back would re-read it every tick.
      const last = pending.filter((entry) => !this.isAnswer(entry)).at(-1);
      if (last && !answer) {
        this.deps.ledger.confirm(conversationId, last.entryId);
        await this.deps.ledger.save();
      }
      if (!this.open.has(conversationId)) {
        const opened = await this.deps.surfaceClient.open(conversationId);
        if (opened) {
          this.open.set(conversationId, { stream: opened.stream, detach: () => opened.detach() });
          this.log(
            `[paint] ${this.deps.address?.(conversationId) ?? `conversation ${conversationId}`}: streaming a turn`,
          );
        }
      }
      return;
    }

    // --- Neither: a settled turn with no answer (an aborted or failed run). ---
    if (pending.length > 0) {
      const open = this.open.get(conversationId);
      if (open) {
        await open.stream.abandon();
        open.detach();
        this.open.delete(conversationId);
      }
      // The failure notice is not this component's job: it belongs to whatever knows
      // *why* the turn produced nothing, which is the adapter that awaited it.
      this.deps.ledger.confirm(conversationId, pending[pending.length - 1]!.entryId);
      await this.deps.ledger.save();
      this.log(
        `[paint] ${this.deps.address?.(conversationId) ?? `conversation ${conversationId}`}: ` +
          `turn produced no answer (through entry ${pending[pending.length - 1]!.entryId})`,
      );
    }
  }

  /** An assistant entry stamped by the host is a settled answer; nothing else is. */
  private isAnswer(entry: EntryRef): boolean {
    return entry.role === "assistant" && entry.origin !== undefined;
  }

  /**
   * The prompt this answer is replying to, when it came from *another* surface.
   *
   * A prompt typed in Chat is already in the thread, so quoting it would repeat it. A
   * prompt that arrived from the browser is not, so the answer carries it — the same
   * trade `mirror.ts` made, now in the one place that posts.
   */
  private promptFor(pending: readonly EntryRef[], answer: EntryRef): EntryRef | undefined {
    const before = pending.filter((entry) => entry.entryId < answer.entryId);
    const user = before.filter((entry) => entry.role === "user").at(-1);
    if (!user) return undefined;
    if (user.origin === undefined || user.origin === this.deps.surface) return undefined;
    return user;
  }

  /** Detach everything; called on shutdown so a restart leaves no half-open view. */
  async close(): Promise<void> {
    for (const [, open] of this.open) {
      open.detach();
    }
    this.open.clear();
  }

  /** The last tick's summary, for diagnostics. */
  last(): PaintSummary {
    return this.summary;
  }
}
