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
 * behind it, so the next look tries again. That is strictly better than the handler's
 * one-shot post, and it is why the reconciler that compared the two could be deleted.
 *
 * Three mechanisms, and each has one job — the split matters because two of them overlapping
 * is how a turn gets painted twice:
 *
 *   - **subscriptions** (when the surface can hold one) are *liveness*: a turn that starts is
 *     pushed, and its frames paint the placeholder. Held per conversation, so one that starts
 *     later is seen too.
 *   - **`poke`** is *delivery of one answer*: a frame can say the turn ended, but only the
 *     transcript can say what it said.
 *   - **`tick`** is *discovery*, and nothing else: it adopts conversations it has never seen,
 *     and reads the ones nobody is watching — a dormant thread, or every thread in in-process
 *     mode. It is the residual polling §18 allows, and it never runs for a watched thread.
 */
import type { EntryRef, MessageLike } from "./entries.js";
import type { Ledger } from "./ledger.js";

import { logger } from "../logger.js";

/**
 * The prompt as a Chat block quote, so the answer reads as a reply to it.
 *
 * Quote markers on every line, because Chat's Markdown ends a block quote at the first
 * unmarked line — a two-paragraph paste would otherwise have its second paragraph read
 * like the start of the answer.
 */
export function quotePrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) return "";
  return trimmed
    .split("\n")
    .map((line) => (line.trim() === "" ? ">" : `> ${line}`))
    .join("\n");
}

/**
 * What the painter needs from a surface: a live stream per conversation, and a poster.
 *
 * One call opens the stream *and* subscribes it to the turn, because the two are the
 * same act on a real transport: a Chat placeholder is created before it can be
 * patched, so "open" and "attach" cannot be separated without inventing a state
 * between them.
 */
export interface PaintSurface {
  /**
   * Open a live stream for a conversation, and return the painter for it.
   *
   * The frame→stream mapping belongs to whoever owns the transport (it is where the tool-line
   * and snapshot rules already live), so the painter is handed one rather than importing it.
   * `paint` is a no-op for a surface that subscribed the stream itself.
   */
  open(conversationId: number): Promise<
    | {
        stream: PaintStream;
        detach(): void;
        paint(projected: unknown): void;
      }
    | undefined
  >;
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
  conversations(): Promise<readonly { conversationId: number; lastActivityAt?: number }[]>;
  /**
   * Entries after `since`, oldest first, at most `limit` — the shape `GET /v1/…/entries?since=` serves.
   *
   * Deliberately not a paged transcript read: the painter walks *forward* from its cursor, and a
   * backwards page (which the pane needs for "show earlier") would be a different call with a
   * different meaning. Asking for what the protocol offers is what keeps the extracted bridge a
   * change of wiring rather than a rewrite.
   */
  entriesSince(
    conversationId: number,
    since: number,
    limit: number,
  ): Promise<readonly { entryId: number; role: "user" | "assistant"; text: string; at?: number; origin?: string }[] | undefined>;
  /** Is a turn running in this conversation right now? */
  busy(conversationId: number): Promise<boolean>;
  surfaceClient: PaintSurface;
  /**
   * Open a live view for one turn, and report what it says.
   *
   * This is what makes the tick a *fallback* rather than the mechanism: with a subscription
   * the start of a turn is pushed too (a browser message starts one with no local hint), and
   * the frames drive the placeholder. Without it — the in-process mode, or before the split —
   * the tick notices a running turn instead, one interval later.
   *
   * Returns `undefined` when the surface cannot hold one; the painter then falls back.
   */
  watch?(
    conversationId: number,
    handlers: {
      /** A frame for this conversation. `busy` says whether a turn is running. */
      frame(projected: unknown): void;
      /** The turn ended, as far as the view can tell. */
      settled(): void;
    },
  ): { detach(): void } | undefined;
  /** How much history one look may read before calling the position unreachable. */
  pageSize?: number;
  maxPages?: number;
  log?(message: string): void;
}

/** What one tick did, for the caller's log line and for tests. */
export interface PaintSummary {
  painted: number;
  streamed: number;
  posted: number;
  failed: number;
  /** Conversations whose cursor was too far behind to trust, and were adopted at the head. */
  adopted: number;
}

/** Live stream and view handle per conversation, held across ticks. */
interface Open {
  stream: PaintStream;
  detach(): void;
  paint(projected: unknown): void;
}

export class Painter {
  private open = new Map<number, Open>();
  /**
   * The prompt of the turn each conversation is in, when it came from *another* surface.
   *
   * Held because the answer usually arrives in a *later* batch than its prompt: the poll delivers the
   * prompt as it is typed, the cursor advances past it — it has to, or the poll would deliver it for
   * ever — and the answer lands minutes later, alone. Looking only at the batch found nothing to
   * quote, which is why the quote appeared in tests (where a prompt and its answer arrive together)
   * and never in a real thread.
   */
  private pendingPrompt = new Map<number, { entryId: number; text: string }>();
  /** Open views, one per *running turn* — never held between turns. */
  private watching = new Map<number, { detach(): void }>();
  /**
   * Opens in progress, by conversation.
   *
   * A view frame arrives in bursts — the snapshot on attach, then deltas — so two `frame`
   * callbacks can reach the open path in the same millisecond and both see "no stream yet".
   * Without this they each created a placeholder, which is two "Thinking…" messages and two
   * notifications for one turn (observed at 23:07:34.594Z, in this very thread). Single-flight
   * is the fix: the second caller waits for the first stream rather than making another.
   */
  private opening = new Map<number, Promise<Open | undefined>>();
  private summary: PaintSummary = { painted: 0, streamed: 0, posted: 0, failed: 0, adopted: 0 };
  /** Serialises ticks. Two at once could both see one unposted answer and post it twice. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private deps: PainterDeps) {}

  /**
   * Look at the log now.
   *
   * Despite the name this is a *global* look, because the cursor is global: advancing it from one
   * conversation's entries would step over earlier entries in another, and those would never be
   * read again. So any "look now" is a merge of every owned conversation — which is what a tick
   * does, and the reason this is now a thin alias.
   */
  async poke(): Promise<void> {
    await this.tick();
  }

  /**
   * Run one tick, serialised against any other.
   *
   * Two ticks for one conversation would each read the same unposted answer and each
   * post it, which is precisely the duplication this component exists to prevent — so
   * ticks queue rather than race.
   */
  async tick(): Promise<PaintSummary> {
    const run = this.chain.then(() => this.tickAll());
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private log(message: string): void {
    (this.deps.log ?? ((line: string) => logger.info(line)))(message);
  }

  /** One tick over every conversation this painter owns. Never throws. */
  private async tickAll(): Promise<PaintSummary> {
    const summary: PaintSummary = { painted: 0, streamed: 0, posted: 0, failed: 0, adopted: 0 };
    let conversations: readonly { conversationId: number; lastActivityAt?: number }[];
    try {
      conversations = await this.deps.conversations();
    } catch (error) {
      this.log(`[paint] cannot list conversations: ${(error as Error).message}`);
      return summary;
    }
    const owned = conversations.filter((conversation) => this.deps.owns(conversation.conversationId));
    if (owned.length === 0) return summary;

    // No position at all: take one at the newest entry anywhere, and paint nothing on this look.
    if (!this.deps.ledger.hasPosition()) {
      await this.adoptAtHead(owned);
      return summary;
    }

    // One cursor, so entries must be consumed in *global* order: reading one conversation at a
    // time would let a busy thread's later entry advance the cursor past an earlier entry in a
    // quiet one, and that entry would never be read again. Hence a batch, merged and sorted.
    const batch: { conversationId: number; entryId: number; role: "user" | "assistant"; text: string; at?: number; origin?: string }[] = [];
    // One cursor, so the batch may only be consumed up to the *frontier*: the earliest id where some
    // conversation has more that we did not read. Advancing past it would step over entries in a
    // conversation that was cut short by the page budget, and they would never be read again — the
    // failure mode a per-conversation cursor used to make impossible.
    let frontier = Number.POSITIVE_INFINITY;
    for (const { conversationId } of owned) {
      try {
        const pageSize = this.deps.pageSize ?? 50;
        const read = (await this.deps.entriesSince(conversationId, this.deps.ledger.cursor, pageSize)) ?? [];
        // A page that came back full means there may be more, so nothing above its last id may be
        // consumed yet: advancing past it would step over entries in this conversation that were cut
        // short by the page budget.
        if (read.length >= pageSize && read.length > 0) {
          frontier = Math.min(frontier, Math.max(...read.map((entry) => entry.entryId)) + 1);
        }
        batch.push(
          ...read.map((entry) => ({
            conversationId,
            entryId: entry.entryId,
            role: entry.role,
            text: entry.text,
            ...(entry.at === undefined ? {} : { at: entry.at }),
            ...(entry.origin === undefined ? {} : { origin: entry.origin }),
          })),
        );
      } catch (error) {
        summary.failed += 1;
        this.log(`[paint] conversation ${conversationId}: ${(error as Error).message}`);
      }
    }
    const safe = batch.filter((entry) => entry.entryId < frontier);
    // Directly, not through `ingest`: this already runs inside the chain, and awaiting a promise
    // chained *after* the running one is a deadlock.
    await this.consumeBatch(safe, summary);
    this.summary = summary;
    return summary;
  }

  /**
   * Take a batch of entries the way a *poll* delivers them: already in order, already past the
   * cursor, already a prefix.
   *
   * Split out from the sweep because it is now the primary path — `GET /v1/poll` hands a bridge what
   * has happened and the bridge hands it here — while the sweep stays as the fallback that reads the
   * same way. Serialised on the same chain as a tick, so a poll and a sweep can never both consume
   * the same entry.
   */
  async ingest(
    entries: readonly { conversationId: number; entryId: number; role: "user" | "assistant"; text: string; at?: number; origin?: string }[],
    summary: PaintSummary = { painted: 0, streamed: 0, posted: 0, failed: 0, adopted: 0 },
  ): Promise<void> {
    const run = this.chain.then(() => this.consumeBatch(entries, summary));
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** The body of a batch, for callers already inside the chain. Never re-enters it. */
  private async consumeBatch(
    entries: readonly { conversationId: number; entryId: number; role: "user" | "assistant"; text: string; at?: number; origin?: string }[],
    summary: PaintSummary,
  ): Promise<void> {
    const batch = entries
      .filter((entry) => entry.entryId > this.deps.ledger.cursor)
      .sort((a, b) => a.entryId - b.entryId);
    if (batch.length === 0) return;

    // A turn whose answer we are about to paint carries the prompt it is replying to, which is also
    // in this batch — so the batch is consulted, not the transcript.
    for (const [index, entry] of batch.entries()) {
      try {
        await this.consume(entry, batch.slice(0, index), summary);
      } catch (error) {
        summary.failed += 1;
        this.log(`[paint] conversation ${entry.conversationId}: ${(error as Error).message}`);
      }
    }
    await this.deps.ledger.save();

    // A turn that ended without an answer leaves a placeholder behind; the handler words the failure
    // notice, but the placeholder is this component's to remove.
    for (const [conversationId, open] of this.open) {
      if (await this.deps.busy(conversationId).catch(() => true)) continue;
      await open.stream.abandon().catch(() => {});
      open.detach();
      this.open.delete(conversationId);
      this.endTurn(conversationId);
    }
  }

  /**
   * One entry, decided and acted on.
   *
   * This is the whole of the painter's judgement in one place, and it is the same judgement whether
   * the entry arrived on the stream or was read by the sweep:
   *
   *   - **commentary** (an assistant entry with no origin stamp) is accounted for and never painted:
   *     a turn emits an entry per message and only the settled one is its answer;
   *   - **an answer** becomes one message — the placeholder finished in place, or posted plainly if
   *     no stream was open — quoting a prompt that came from another surface;
   *   - **its own surface's entries** are stepped over: they are already in the thread.
   */
  private async consume(
    entry: { conversationId: number; entryId: number; role: "user" | "assistant"; text: string; at?: number; origin?: string },
    earlier: readonly { conversationId: number; entryId: number; role: "user" | "assistant"; text: string; origin?: string }[],
    summary: PaintSummary,
  ): Promise<void> {
    const conversationId = entry.conversationId;

    if (this.isAnswer(entry)) {
      // The batch first (a prompt and its answer delivered together), then what was remembered when
      // the prompt was consumed on its own — which is the ordinary case for a turn that takes minutes.
      const prompt = this.promptFor(earlier, entry) ?? this.pendingPrompt.get(conversationId);
      this.pendingPrompt.delete(conversationId);
      const body = prompt ? `${quotePrompt(prompt.text)}\n\n${entry.text}` : entry.text;
      const open = this.open.get(conversationId);
      if (open) {
        await open.stream.finish(body);
        open.detach();
        this.open.delete(conversationId);
        summary.streamed += 1;
      } else {
        await this.deps.surfaceClient.post(conversationId, body);
        summary.posted += 1;
      }
      this.endTurn(conversationId);
      summary.painted += 1;
      this.deps.ledger.advance(entry.entryId);
      this.log(
        `[paint] ${this.deps.address?.(conversationId) ?? `conversation ${conversationId}`}: ` +
          `painted answer ${entry.entryId} (${entry.text.length} chars)${prompt ? ", quoting the prompt" : ""}`,
      );
      return;
    }

    if (entry.role === "user") {
      if (entry.origin !== undefined && entry.origin !== this.deps.surface) {
        // Another surface's prompt: the answer will quote it, and the answer is not in this batch.
        this.pendingPrompt.set(conversationId, { entryId: entry.entryId, text: entry.text });
      }
      // A prompt means a turn. Only a turn *still running* deserves a placeholder: the `busy` check
      // is what separates "someone just typed" from "a prompt we are catching up on".
      if (await this.deps.busy(conversationId).catch(() => false)) await this.openTurn(conversationId);
    }
    // Commentary, a prompt, or this surface's own words: accounted for, not painted.
    this.deps.ledger.advance(entry.entryId);
  }

  /** Take a position at the newest entry anywhere, and say so. */
  private async adoptAtHead(owned: readonly { conversationId: number }[]): Promise<void> {
    let newest = 0;
    for (const { conversationId } of owned) {
      // The newest entry anywhere, which is where a first look starts.
      const newestHere = (await this.deps.entriesSince(conversationId, 0, 1).catch(() => undefined)) ?? [];
      for (const entry of newestHere) newest = Math.max(newest, entry.entryId);
    }
    this.deps.ledger.adopt(newest, this.deps.ledger.recovered ? "lost-position" : "new");
    await this.deps.ledger.save();
    this.log(
      `[paint] adopted at entry ${newest} (` +
        (this.deps.ledger.recovered
          ? "the position file was unreadable"
          : "nothing before this painter's first look is repainted") +
        ")",
    );
  }

  /** Page budget for one look. Exposed so a test can make "too far behind" cheap to reach. */
  private get pages(): { pageSize?: number; maxPages?: number } {
    return {
      ...(this.deps.pageSize === undefined ? {} : { pageSize: this.deps.pageSize }),
      ...(this.deps.maxPages === undefined ? {} : { maxPages: this.deps.maxPages }),
    };
  }

  /**
   * Hold a subscription for a conversation, creating it once.
   *
   * Idempotent and cheap to call every tick: a watcher that is already there is left alone,
   * so this is "make sure", not "open another".
   */
  /**
   * A turn started: open the view that paints it.
   *
   * Called when a prompt is *consumed*, whichever way it arrived — a poll batch or the sweep — so
   * there is one trigger. A position is global and taken at startup; a turn starting cannot invent
   * one, and painting without one would leave the answer unpostable.
   */
  private async openTurn(conversationId: number): Promise<void> {
    if (!this.deps.owns(conversationId)) return;
    if (!this.deps.ledger.hasPosition()) return;
    if (this.watching.has(conversationId)) return;
    const watch = this.deps.watch;
    if (!watch) {
      // In-process mode: no observer to subscribe, so the placeholder is opened directly and the
      // sink attached to it does the painting.
      await this.ensureStream(conversationId, "polled");
      return;
    }
    const handle = watch(conversationId, {
      frame: (projected) => {
        void this.paintFrame(conversationId, projected);
      },
      settled: () => {
        void this.poke().finally(() => this.endTurn(conversationId));
      },
    });
    if (handle) this.watching.set(conversationId, handle);
  }

  /** The turn is over: no view, and no stream waiting to be finished. */
  private endTurn(conversationId: number): void {
    // A turn that ended without an answer leaves nothing to quote; a later answer must not pick up
    // this prompt as if it were its own.
    this.pendingPrompt.delete(conversationId);
    const watcher = this.watching.get(conversationId);
    if (watcher) {
      watcher.detach();
      this.watching.delete(conversationId);
    }
  }

  /**
   * Paint one frame, opening the turn's stream the first time the turn is seen running.
   *
   * The stream is per *turn* while the subscription is per conversation: a placeholder must
   * not exist between turns, or every conversation would own a bot message saying "Thinking…"
   * forever.
   */
  private async paintFrame(conversationId: number, projected: unknown): Promise<void> {
    const busy = (projected as { busy?: unknown }).busy === true;
    if (!busy) return; // the settle edge is reported separately, and finishes the stream
    const open = await this.ensureStream(conversationId, "pushed");
    open?.paint(projected);
  }

  /**
   * The one stream for a conversation's running turn, opened at most once.
   *
   * Single-flight in both directions: a stream that exists is returned, and a stream being
   * opened is awaited rather than duplicated. This is the fix for a real duplicate — two frames
   * of the same burst opened two placeholders, so the thread got two "Thinking…" messages and
   * two notifications for one turn.
   */
  private async ensureStream(conversationId: number, why: "pushed" | "polled" | "fallback"): Promise<Open | undefined> {
    const existing = this.open.get(conversationId);
    if (existing) return existing;
    const inFlight = this.opening.get(conversationId);
    if (inFlight) return inFlight;

    const opening = (async (): Promise<Open | undefined> => {
      const opened = await this.deps.surfaceClient.open(conversationId);
      if (!opened) return undefined;
      const record: Open = {
        stream: opened.stream,
        detach: () => opened.detach(),
        paint: (projected) => opened.paint(projected),
      };
      this.open.set(conversationId, record);
      this.log(
        `[paint] ${this.deps.address?.(conversationId) ?? `conversation ${conversationId}`}: streaming a turn (${why})`,
      );
      return record;
    })();
    this.opening.set(conversationId, opening);
    try {
      return await opening;
    } finally {
      this.opening.delete(conversationId);
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
    for (const [, watcher] of this.watching) watcher.detach();
    this.watching.clear();
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
