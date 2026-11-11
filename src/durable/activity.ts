/**
 * Activity: the server saying what it is doing, to whoever is listening.
 *
 * This is the piece that lets a bridge stop asking. Until now the only way to learn that a
 * turn had started in a conversation was to read it — and for a thread nobody was holding a
 * subscription on, that meant a sweep every minute. The server, of course, already knows: it is
 * the thing running the turn. So it says so, and the sweep becomes the fallback it was always
 * meant to be.
 *
 * Two event kinds, both *hints* and neither carrying data:
 *
 *   - `started` — a submission became a turn;
 *   - `settled` — that turn ended.
 *
 * A hint is deliberately not a delivery: losing one costs latency, never a message, because the
 * transcript and the bridge's cursor are the record. That is what makes this compatible with
 * Delivery is the reader's state — a subscriber list is a set of *open connections*, not remembered positions, and a bridge
 * that was away holds no subscription and therefore misses nothing it cannot re-read.
 *
 * The turn watcher that produces `settled` is the server minding its own business: one view
 * attachment per running turn, dropped when it ends. It is not per-reader state, and a server
 * with no subscribers still runs turns exactly as before.
 *
 * Filtering is optional on purpose, because the two consumers want opposite things: the chat
 * bridge serves every thread it is bound to and wants all of them, while a browser showing one
 * conversation cares about that one and should not be woken for the rest.
 */
import type { SessionHost } from "../session-host/api.js";
import { logger } from "../logger.js";

/** What happened, and where. No payload: the reader fetches what it needs. */
export interface ActivityEvent {
  conversationId: number;
  kind: "started" | "settled";
  at: number;
}

export type ActivityListener = (event: ActivityEvent) => void;

/**
 * The fan-out, and the per-turn watching that feeds it.
 *
 * Deliberately tiny and in-memory: subscribers are connections, so they are held as callbacks
 * and forgotten when the connection closes. Nothing here is durable, and nothing here is a
 * cursor.
 */
export class ActivityFeed {
  private listeners = new Set<ActivityListener>();
  /** Turns already being watched, so two submissions in one conversation watch it once. */
  private watching = new Set<number>();

  constructor(
    private readonly deps: {
      seam: Pick<SessionHost, "attach">;
      now?(): number;
      log?(message: string): void;
      /**
       * How long a turn may take to *start* before the watch gives up and calls it settled.
       *
       * `started` is announced when the submission is accepted, and the run begins a moment
       * later — so the first frame a watcher sees is often already idle. Treating that as "the
       * turn ended" is what silenced two replies: the painter closed its view before the turn
       * had begun, and with no sweep left to notice, the answer was never posted.
       */
      settleGraceMs?: number;
    },
  ) {}

  /** Subscribe. Returns the unsubscribe, which the transport must call when the client goes. */
  subscribe(listener: ActivityListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** For diagnostics: how many connections are listening. */
  get size(): number {
    return this.listeners.size;
  }

  private emit(event: ActivityEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        // A broken subscriber is its own problem: one dead socket must not silence the rest.
        (this.deps.log ?? ((line: string) => logger.warn(line)))(`[activity] listener failed: ${(error as Error).message}`);
      }
    }
  }

  /**
   * Say that a turn has started, and watch it so `settled` can be said too.
   *
   * Idempotent per conversation: several submissions can join one turn (a steer), and a second
   * watcher would attach to the same view for no reason.
   */
  started(conversationId: number): void {
    this.emit({ conversationId, kind: "started", at: this.now() });
    if (this.watching.has(conversationId)) return;
    this.watching.add(conversationId);

    // Watch the turn to its end. The view is the honest signal: `busy` going false is the same
    // edge every surface uses, and it needs no cooperation from whatever awaited the turn.
    void (async () => {
      // A turn settles when `busy` goes true → false. An idle frame *before* the run has begun
      // is not a settle, it is the gap between accepting a submission and starting it — the
      // distinction that cost two replies.
      let sawBusy = false;
      let handle: Awaited<ReturnType<typeof this.deps.seam.attach>>;
      const settle = (): void => {
        if (!this.watching.delete(conversationId)) return; // already settled
        clearTimeout(grace);
        handle?.detach();
        this.emit({ conversationId, kind: "settled", at: this.now() });
      };
      // A turn that never starts (a submission that fails immediately) still has to settle, or a
      // reader waits for an event that will never come.
      const grace = setTimeout(() => {
        if (sawBusy) return; // it is running; the view will say when it stops
        settle();
      }, this.deps.settleGraceMs ?? 60_000);
      grace.unref?.();

      try {
        handle = await this.deps.seam.attach(conversationId, (view) => {
          const busy = (view as { busy?: unknown }).busy === true;
          if (busy) {
            sawBusy = true;
            return;
          }
          if (sawBusy) settle();
        });
      } catch (error) {
        this.watching.delete(conversationId);
        clearTimeout(grace);
        (this.deps.log ?? ((line: string) => logger.warn(line)))(
          `[activity] cannot watch conversation ${conversationId}: ${(error as Error).message}`,
        );
        return;
      }
      if (!handle) {
        this.watching.delete(conversationId);
        clearTimeout(grace);
        return;
      }
      // Attaching can itself reveal a turn that is already running.
      if (handle.snapshot.busy === true) sawBusy = true;
    })();
  }

  /** Stop watching everything; called on shutdown so a restart leaves no dangling attachment. */
  close(): void {
    this.listeners.clear();
    this.watching.clear();
  }

  private now(): number {
    return (this.deps.now ?? (() => Date.now()))();
  }
}
