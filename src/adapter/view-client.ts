/**
 * The client half of the view stream: the ladder from push to polling and back.
 *
 * The rule this implements (§18) is that there is **one** liveness mechanism at a time.
 * The heartbeat *is* the test; polling is what happens when that test has failed. Doing
 * both at once would be two answers to one question, and the slower one would decide the
 * behaviour anyway.
 *
 * The ladder, in full:
 *
 *   ┌ push ──── any frame (view or heartbeat) ───────────────────────────┐
 *   │   silence ≥ suspect → reconnect (the common case: a stale socket) │
 *   │   failed reconnects ≥ degrade → poll, keep retrying in background │
 *   └── a subscription that holds → back to push ───────────────────────┘
 *
 * The timing source and the connector are injected, because a ladder that can only be
 * tested by waiting is a ladder nobody tests. `decide()` is the whole policy as a pure
 * function; `ViewLadder` is the small amount of bookkeeping around it.
 */
import { logger } from "../logger.js";

/** What the ladder is doing right now. */
export type ViewMode = "push" | "degraded";

/** The facts a decision needs. */
export interface LadderFacts {
  mode: ViewMode;
  /** No frame (view or heartbeat) for this long. */
  silentForMs: number;
  /** Consecutive reconnects that did not hold a stream. */
  failedReconnects: number;
}

export interface LadderPolicy {
  /** Silence after which the stream is presumed dead. Two heartbeats, by default. */
  suspectAfterMs: number;
  /** Reconnects that must fail before polling is used as well as retrying. */
  degradeAfter: number;
}

export type LadderAction = "wait" | "reconnect" | "degrade";

/**
 * The policy, as a pure function.
 *
 * `degrade` does not mean "stop reconnecting": a dead stream that recovers should stop
 * polling at once, so the ladder keeps trying while it polls.
 */
export function decide(facts: LadderFacts, policy: LadderPolicy): LadderAction {
  if (facts.failedReconnects >= policy.degradeAfter) return "degrade";
  if (facts.silentForMs >= policy.suspectAfterMs) return "reconnect";
  return "wait";
}

/**
 * The protocol's implementation of `ViewSource`: SSE over HTTP against `/v1/view`.
 *
 * Reads the wire format it is given rather than parsing optimistically: a `data:` line
 * that is not JSON is a frame to skip, not a stream to tear down, because a proxy that
 * injects a comment or a keep-alive should not look like a broken server.
 */
export function httpViewSource(options: {
  baseUrl: string;
  conversationId: number;
  token?: string;
}): ViewSource {
  return {
    async open(onFrame, signal) {
      const headers: Record<string, string> = { Accept: "text/event-stream" };
      if (options.token) headers.Authorization = `Bearer ${options.token}`;
      const response = await fetch(
        `${options.baseUrl.replace(/\/$/, "")}/v1/conversations/${options.conversationId}/view`,
        { headers, signal },
      );
      if (!response.ok) throw new Error(`view stream: HTTP ${response.status}`);
      if (!response.body) throw new Error("view stream: no body");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      // Abort is a normal ending, not a failure: the ladder's contract is that `open`
      // resolves when the stream ends either way, and a caller that asked to stop should
      // not receive an exception for being obeyed.
      const aborted = (error: unknown): boolean => signal.aborted || (error as Error)?.name === "AbortError";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf("\n\n");
          while (boundary !== -1) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const event = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (data !== undefined && (event === "view" || event === "heartbeat")) {
              let parsed: unknown;
              try {
                parsed = JSON.parse(data) as unknown;
              } catch {
                parsed = undefined;
              }
              if (parsed !== undefined) onFrame(event, parsed);
            }
            boundary = buffer.indexOf("\n\n");
          }
        }
      } catch (error) {
        if (!aborted(error)) throw error;
      } finally {
        reader.cancel().catch(() => {});
      }
    },
  };
}

/** A subscription as the ladder sees it: open it, get told about closes. */
export interface ViewSource {
  /**
   * Subscribe and call `onFrame` for every frame.
   *
   * Resolves when the stream ends **or when `signal` aborts** — an implementation that
   * ignores the abort would make `stop()` wait for a connection that may never speak
   * again, which is the exact failure the ladder exists to recover from.
   */
  open(onFrame: (kind: "view" | "heartbeat", data: unknown) => void, signal: AbortSignal): Promise<void>;
}

export interface LadderDeps {
  source: ViewSource;
  /** Called with each view frame, in order, whichever way it arrived. */
  onView(view: unknown): void;
  /** Poll while degraded. Resolves when one poll is done. */
  poll(): Promise<void>;
  /** Base cadence of the server's heartbeat, for computing `suspectAfterMs`. */
  heartbeatMs?: number;
  policy?: Partial<LadderPolicy>;
  now?(): number;
  pollIntervalMs?: number;
  /**
   * How the ladder waits between attempts. Injected so a test can compress a reconnect
   * backoff to nothing — a ladder whose timing can only be exercised by waiting is a
   * ladder nobody exercises.
   */
  delay?(ms: number): Promise<void>;
  /** Told on every mode change, for a log or a test. */
  onMode?(mode: ViewMode): void;
  log?(message: string): void;
}

/**
 * Runs one conversation's subscription for as long as it is asked to.
 *
 * `run()` never resolves while healthy; stop it by calling `stop()`, which aborts the
 * stream and any poll loop.
 */
export class ViewLadder {
  private stopped = false;
  private mode: ViewMode = "push";
  private failedReconnects = 0;
  private lastFrameAt: number;
  private abort: AbortController | undefined;
  private readonly policy: LadderPolicy;

  constructor(private readonly deps: LadderDeps) {
    const heartbeat = deps.heartbeatMs ?? 15_000;
    this.policy = {
      // Two missed heartbeats, which is the shortest window that is not a false positive
      // on a slow frame or a GC pause.
      suspectAfterMs: deps.policy?.suspectAfterMs ?? heartbeat * 2,
      degradeAfter: deps.policy?.degradeAfter ?? 3,
    };
    this.lastFrameAt = this.now();
  }

  private now(): number {
    return (this.deps.now ?? (() => Date.now()))();
  }

  private log(message: string): void {
    (this.deps.log ?? ((line: string) => logger.info(line)))(message);
  }

  private setMode(mode: ViewMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.deps.onMode?.(mode);
    this.log(`[view] ${mode === "push" ? "stream is alive again — polling stops" : "stream is not holding — polling as well"}`);
  }

  /** Run until stopped. */
  async run(): Promise<void> {
    while (!this.stopped) {
      this.abort = new AbortController();
      const startedAt = this.now();
      try {
        await this.deps.source.open((kind, data) => {
          this.lastFrameAt = this.now();
          this.failedReconnects = 0;
          this.setMode("push");
          if (kind === "view") this.deps.onView(data);
        }, this.abort.signal);
      } catch (error) {
        this.log(`[view] stream failed: ${(error as Error).message}`);
      }
      if (this.stopped) return;

      // The stream ended. Whether that was moments after opening or hours later is the
      // whole difference between "the server restarted" and "my network died", so the
      // ladder is asked with that fact rather than assuming.
      const held = this.now() - startedAt > this.policy.suspectAfterMs;
      if (!held) this.failedReconnects += 1;
      const action = decide(
        { mode: this.mode, silentForMs: this.now() - this.lastFrameAt, failedReconnects: this.failedReconnects },
        this.policy,
      );

      if (action === "degrade") {
        this.setMode("degraded");
        await this.pollOnce();
        continue;
      }
      // A pause before reconnecting: a server that is restarting should not be hammered.
      await this.wait(action === "reconnect" ? 500 : 1_000);
    }
  }

  /** Poll once, if polling is what the caller wants while degraded. */
  private async pollOnce(): Promise<void> {
    try {
      await this.deps.poll();
    } catch (error) {
      this.log(`[view] poll failed: ${(error as Error).message}`);
    }
    await this.wait(this.deps.pollIntervalMs ?? 15_000);
  }

  /** Wait, unless stopped. */
  private async wait(ms: number): Promise<void> {
    if (this.deps.delay) {
      await this.deps.delay(ms);
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
      // `stop()` resolves it immediately so shutdown is not delayed by a poll interval.
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    this.wake = undefined;
  }

  private wake: (() => void) | undefined;

  /** Stop the stream and any poll loop. Idempotent. */
  stop(): void {
    this.stopped = true;
    this.abort?.abort();
    this.wake?.();
  }

  /** For diagnostics and tests. */
  currentMode(): ViewMode {
    return this.mode;
  }
}
