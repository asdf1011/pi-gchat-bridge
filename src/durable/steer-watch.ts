/**
 * A steer that is waiting behind a tool that will not return.
 *
 * A steer is placed at a boundary (spec §6): `postTools` once the round's tools
 * settle, otherwise `final`. That is the right rule for a tool that returns, and a
 * trap for one that does not. `finishToolRound` reads the round's outcomes with
 * policy `allSettled`, so the round cannot end while any tool in it runs; a tool
 * with no timeout of its own therefore leaves the steer queued for as long as it
 * runs. Nothing in the harness bounds that. The durable engine has no stall
 * watchdog — `settings.ts` records why it was dropped — and pi's `bash` takes
 * `timeout` as optional with no default, so a wedged `npx --test` holds a
 * conversation open indefinitely.
 *
 * The SDK bridge before this one capped the wait and aborted the run when the cap
 * passed (`AgentRouter.redirect()`, `BRIDGE_STEER_WAIT_MS`). This is the durable
 * equivalent, and it differs in three deliberate ways:
 *
 *   - It aborts the round's *tool tasks*, not the conversation.
 *     `Conversation.abort()` withdraws queued inputs and settles them
 *     `unanswered` — it would throw away the very message this exists to deliver.
 *   - A tool task that settles `aborted` is an ordinary result to the model ("Tool
 *     bash was aborted"), so the turn carries on holding the steer instead of
 *     failing. That is the whole point: the steer lands, and the transcript shows
 *     why the tool stopped.
 *   - It re-reads the queue before acting. A steer the boundary placed in the
 *     meantime is left alone, because the cap bounds how long a *wait* may last,
 *     not how long a tool may run. A tool that finishes in nine seconds of a
 *     ten-second cap is never touched.
 *
 * A wait that is not behind a tool — a slow model request — is deliberately out of
 * scope: `stream.timeoutMs` (`BRIDGE_MODEL_TIMEOUT_MS`) is the knob for that, and
 * a second opinion here would only make the two fight.
 */

/** What the watch reads and does, passed in so the rules run without a harness. */
export interface SteerWatchDeps {
  /**
   * How long a queued steer may wait behind a running tool, in ms. 0 disables the
   * watch: the caller has decided that unbounded tool runs are its own problem.
   */
  steerWaitMs: number;
  /** Whether the steer is still queued. Placed, done and unanswered all mean no. */
  isWaiting(): Promise<boolean>;
  /**
   * The conversation's tool tasks that are still running, from its current round.
   * Empty means the conversation is busy with something other than a tool.
   */
  runningTools(conversationId: number): Promise<readonly number[]>;
  /** Abort one tool task. Its round settles as a result, and the boundary follows. */
  abortTask(taskId: number): Promise<unknown>;
  /** Told what the watch did. Warnings only; it never changes behaviour. */
  log?(message: string): void;
  /** Timers, for tests: schedule `fire` after `ms` and return a canceller. */
  schedule?(fire: () => void, ms: number): () => void;
}

/** The steer being watched: which conversation waits, and which submission it is. */
export interface SteerTarget {
  readonly conversationId: number;
  readonly submissionId: number;
}

/** What one expiry did, so a caller and a test can tell the cases apart. */
export type SteerWatchOutcome = "aborted" | "not-waiting" | "no-tools";

/**
 * One expiry: abort the tools the steer is waiting behind, if it is still waiting
 * behind any.
 *
 * Never throws. It runs from a timer, where a rejection has no caller to see it,
 * and a failed rescue must not become an unhandled one.
 */
export async function runSteerWatch(
  deps: SteerWatchDeps,
  target: SteerTarget,
): Promise<SteerWatchOutcome> {
  if (!(await deps.isWaiting())) return "not-waiting";

  const tools = await deps.runningTools(target.conversationId);
  if (tools.length === 0) {
    // Busy with the model, or between rounds. The steer is placed when that ends,
    // and there is nothing here to cut short.
    deps.log?.(
      `[steer] conversation ${target.conversationId}: submission ${target.submissionId} ` +
        `waits on the model, not a tool — leaving it`,
    );
    return "no-tools";
  }

  deps.log?.(
    `[steer] conversation ${target.conversationId}: submission ${target.submissionId} ` +
      `still queued after ${deps.steerWaitMs}ms — aborting tool task${tools.length === 1 ? "" : "s"} ` +
      tools.join(", "),
  );
  for (const taskId of tools) {
    // One abort per task, each on its own: a task that is already terminal must
    // not stop the others from being cut short.
    try {
      await deps.abortTask(taskId);
    } catch (error) {
      deps.log?.(`[steer] abort of tool task ${taskId} failed: ${(error as Error).message}`);
    }
  }
  return "aborted";
}

/**
 * Arm one expiry per queued steer. Returns a canceller, for a shutdown that would
 * rather not fire it.
 *
 * The timer is unreferenced: a watcher must never be the reason a process stays up
 * or a test hangs. Ten seconds from now the bridge is either serving or gone, and
 * in the second case there is nothing to rescue.
 */
export function armSteerWatch(deps: SteerWatchDeps, target: SteerTarget): () => void {
  if (!(deps.steerWaitMs > 0)) return () => {};

  const schedule =
    deps.schedule ??
    ((fire: () => void, ms: number) => {
      const timer = setTimeout(fire, ms);
      timer.unref();
      return () => clearTimeout(timer);
    });

  return schedule(() => {
    void runSteerWatch(deps, target).catch((error: unknown) => {
      deps.log?.(
        `[steer] watch for submission ${target.submissionId} failed: ${(error as Error).message}`,
      );
    });
  }, deps.steerWaitMs);
}
