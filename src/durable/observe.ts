/**
 * Watching one conversation's turn, over the protocol.
 *
 * A long poll that asks for the *view* as well as the log, and turns both into what a painter needs:
 * frames while a turn runs, an edge when it ends, and the entries that arrived on the way. Extracted
 * from the bridge's main file where it was inline and untestable — and it is the one piece that has
 * to be right for a live update to appear at all, so it earns a module and a test against a real
 * server rather than a mock.
 *
 * Two properties the loop has on purpose:
 *
 *   - **One request in flight.** The next poll is issued when the answer arrives, so a slow host
 *     slows the loop instead of queueing work behind it. A storm is not possible by construction.
 *   - **A deadline for a turn that never starts.** A prompt can be consumed for a turn that never
 *     happened (a catch-up, a submission that failed before the run began). Nothing else will end the
 *     watch in that case, so it ends itself.
 */
import { httpPoll } from "../adapter/poll-client.js";
import { logger } from "../logger.js";

export interface ObserveTurnOptions {
  baseUrl: string;
  conversationId: number;
  token?: string;
  /**
   * The position to ask from.
   *
   * A function, not a value: the caller's cursor moves as entries are delivered, and a captured
   * number would ask the same question for ever.
   */
  since(): number;
  /** How long one request may be held. */
  waitSeconds?: number;
  /** How long a turn may take to start before the watch gives up. */
  startGraceMs?: number;
  /** Called with each view, in the order they arrive. `busy` included: the painter decides. */
  onFrame(view: { liveText: string; busy: boolean; tools: unknown }): void;
  /** Called once, when the turn that was running has stopped. */
  onSettled(): void;
  /** Entries that arrived while waiting. The caller feeds them to its own delivery path. */
  onEntries?(entries: { conversationId: number; entryId: number; role: "user" | "assistant"; text: string }[]): void | Promise<void>;
  log?(message: string): void;
}

/** Follow a conversation until `signal` aborts, or until a watch that never saw a turn gives up. */
export function observeTurn(options: ObserveTurnOptions, signal: AbortSignal): void {
  const log = options.log ?? ((message: string) => logger.warn(message));
  const waitSeconds = options.waitSeconds ?? 25;
  const startGraceMs = options.startGraceMs ?? 30_000;

  void (async () => {
    let backoff = 1_000;
    let wasBusy: boolean | undefined;
    let sawBusy = false;
    const openedAt = Date.now();

    while (!signal.aborted) {
      let result;
      try {
        result = await httpPoll({
          baseUrl: options.baseUrl,
          // The position is the caller's: entries are delivered once, and a poll without a cursor
          // would replay the conversation. The caller supplies it through `onEntries` ordering, so
          // this asks for everything after the last thing it acknowledged.
          since: options.since(),
          waitSeconds,
          conversationId: options.conversationId,
          observe: true,
          ...(options.token ? { token: options.token } : {}),
          signal,
        });
        backoff = 1_000;
      } catch (error) {
        if (signal.aborted) return;
        log(`[paint] observing ${options.conversationId} failed: ${(error as Error).message}`);
        await new Promise((resolve) => setTimeout(resolve, backoff));
        backoff = Math.min(30_000, backoff * 2);
        continue;
      }

      if (result.entries.length > 0) await options.onEntries?.(result.entries);

      const view = result.view;
      if (view) {
        if (view.busy) sawBusy = true;
        // Settle is a transition, not a state: an idle conversation stays idle, and reporting every
        // idle answer would re-read the transcript continuously.
        if (wasBusy === true && !view.busy) options.onSettled();
        wasBusy = view.busy;
        options.onFrame(view);
      }

      if (!sawBusy && Date.now() - openedAt > startGraceMs) {
        log(`[paint] conversation ${options.conversationId}: no turn started — stopping the watch`);
        options.onSettled();
        return;
      }
    }
  })();
}
