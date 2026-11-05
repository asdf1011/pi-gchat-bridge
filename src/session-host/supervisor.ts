/**
 * Restarting a child process with exponential backoff.
 *
 * Written for the web adapter, which is a child of the session host because the
 * IPC channel is the chord link. Two properties matter and neither is speed:
 *
 *   - **It comes back.** Before this, a crashed adapter logged one line and
 *     `/web` stayed down until the bridge was restarted by hand.
 *   - **It does not spin.** A child that dies on startup would otherwise refork
 *     forever at 100% CPU, and bury whatever the real error was under identical
 *     log lines — the exact failure this repository has already had once, from a
 *     supervisor loop restarting a bridge that refused to start.
 *
 * So the delay doubles from `baseMs` to `maxMs` (five minutes by default) and
 * resets once a run has stayed up long enough to count as healthy, so a one-off
 * crash does not leave the next restart waiting minutes.
 */

export interface RestartPolicy {
  /** First retry delay. */
  baseMs: number;
  /** Ceiling: the delay never exceeds this. */
  maxMs: number;
  /** A run this long counts as healthy and resets the backoff. */
  resetAfterMs: number;
}

export const DEFAULT_RESTART_POLICY: RestartPolicy = {
  baseMs: 1_000,
  maxMs: 300_000,
  resetAfterMs: 60_000,
};

/**
 * Delay before attempt `attempt` (1 = first retry, 2 = second, …).
 *
 * Doubling with the exponent clamped, so a very long outage cannot overflow the
 * arithmetic into a negative or absurd delay.
 */
export function backoffDelayMs(attempt: number, policy: RestartPolicy = DEFAULT_RESTART_POLICY): number {
  const safe = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  const exponent = Math.min(safe - 1, 20);
  return Math.min(policy.maxMs, policy.baseMs * 2 ** exponent);
}

/** The bit of a child process the supervisor needs. */
export interface Supervisable {
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface SupervisorOptions<C extends Supervisable> {
  /** Start one child. Called again on every retry. */
  start: () => C;
  /** Called after each spawn, e.g. to accept a new link. */
  onStart?: (child: C, attempt: number) => void;
  policy?: RestartPolicy;
  log?: (message: string) => void;
  /** Injected for tests; defaults to the real timers. */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export interface Supervisor<C extends Supervisable> {
  /** The live child, if one is running. */
  current(): C | undefined;
  /** Stop supervising and kill the child. Idempotent. */
  stop(): void;
}

/**
 * Keep one child alive.
 *
 * The first child counts as attempt 1 and starts immediately; retries use
 * `backoffDelayMs`. A run that survives `resetAfterMs` resets the attempt
 * counter, so backoff reflects "crashing repeatedly", not "restarted once".
 */
export function supervise<C extends Supervisable>(options: SupervisorOptions<C>): Supervisor<C> {
  const policy = options.policy ?? DEFAULT_RESTART_POLICY;
  const log = options.log ?? ((message: string) => console.error(message));
  const schedule = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = options.clearTimeout ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));

  let child: C | undefined;
  /** Spawns so far, for `onStart` and logging. */
  let attempt = 0;
  /** Consecutive crashes since a run last stayed up; this is what backoff counts. */
  let failures = 0;
  let timer: unknown;
  let stopped = false;
  let startedAt = 0;

  const spawn = (): void => {
    if (stopped) return;
    attempt += 1;
    startedAt = Date.now();
    const spawned = options.start();
    child = spawned;
    options.onStart?.(spawned, attempt);

    spawned.on("exit", (code, signal) => {
      // A child we killed ourselves, or a supervisor already stopped, is not a
      // crash and must not schedule anything.
      if (stopped) return;
      child = undefined;
      const ranFor = Date.now() - startedAt;
      // A run that lasted resets the count, so the next crash waits `baseMs`
      // rather than continuing where an earlier burst left off.
      if (ranFor >= policy.resetAfterMs) failures = 0;
      failures += 1;
      const delay = backoffDelayMs(failures, policy);
      log(
        `[supervisor] child exited (code ${code ?? signal ?? "unknown"}) after ${Math.round(ranFor / 1000)}s — respawning in ${Math.round(delay / 1000)}s`,
      );
      timer = schedule(() => {
        timer = undefined;
        spawn();
      }, delay);
    });
  };

  spawn();

  return {
    current: () => child,
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) {
        cancel(timer);
        timer = undefined;
      }
      const live = child;
      child = undefined;
      live?.kill("SIGTERM");
    },
  };
}
