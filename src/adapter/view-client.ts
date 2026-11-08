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
}): StreamSource {
  return sseSource(`${options.baseUrl.replace(/\/$/, "")}/v1/conversations/${options.conversationId}/view`, options.token);
}

/**
 * Activity: the server's account of turns starting and settling.
 *
 * Unfiltered on purpose for the chat bridge — it serves every thread it is bound to and wants to
 * hear about all of them. The `events` it yields are hints, so a caller does not repaint from
 * them; it goes and reads.
 */
export function httpActivitySource(options: { baseUrl: string; token?: string }): StreamSource {
  return sseSource(`${options.baseUrl.replace(/\/$/, "")}/v1/activity`, options.token);
}

/**
 * The log as a stream: replay from a cursor, then follow.
 *
 * Unfiltered — the chat bridge's shape — or filtered to one conversation. `live=1` is passed through
 * only when the caller asks for it, because live text needs a conversation to be about.
 */
export function httpEventsSource(options: {
  baseUrl: string;
  since: number;
  conversationId?: number;
  live?: boolean;
  token?: string;
}): StreamSource {
  const query = new URLSearchParams({ since: String(options.since) });
  if (options.conversationId !== undefined) query.set("conversation", String(options.conversationId));
  if (options.live) query.set("live", "1");
  return sseSource(`${options.baseUrl.replace(/\/$/, "")}/v1/events?${query.toString()}`, options.token);
}

/**
 * One conversation's stream: `activity` boundaries and `view` frames over one connection.
 *
 * What a surface watching a single conversation should hold, instead of the unfiltered activity
 * stream plus a view stream. Both carry hints, so the ladder treats them identically.
 */
export function httpConversationEventsSource(options: {
  baseUrl: string;
  conversationId: number;
  token?: string;
}): StreamSource {
  return sseSource(
    `${options.baseUrl.replace(/\/$/, "")}/v1/conversations/${options.conversationId}/events`,
    options.token,
  );
}

/** The SSE reader both sources share: frames and heartbeats, nothing else. */
function sseSource(url: string, token: string | undefined): StreamSource {
  return {
    async open(onFrame, signal) {
      const headers: Record<string, string> = { Accept: "text/event-stream" };
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await fetch(url, { headers, signal });
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
            // Every event the protocol defines, passed through untouched: which ones matter is the
            // caller's business, and a ladder that filtered them would need updating per stream.
            if (data !== undefined) {
              let parsed: unknown;
              try {
                parsed = JSON.parse(data) as unknown;
              } catch {
                parsed = undefined;
              }
              if (parsed !== undefined) onFrame(event as StreamKind, parsed);
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
/** What an SSE stream can carry: the view of a turn, the server's activity, or proof of life. */
export type StreamKind = "view" | "activity" | "heartbeat" | "entry" | "ready" | "resync";

export interface StreamSource {
  /**
   * Subscribe and call `onFrame` for every frame.
   *
   * Resolves when the stream ends **or when `signal` aborts** — an implementation that
   * ignores the abort would make `stop()` wait for a connection that may never speak
   * again, which is the exact failure the ladder exists to recover from.
   */
  open(onFrame: (kind: StreamKind, data: unknown) => void, signal: AbortSignal): Promise<void>;
}

export interface LadderDeps {
  source: StreamSource;
  /**
   * Called with every frame, in order, whichever way it arrived.
   *
   * The kind matters to the caller — a `view` is live state, an `entry` is content, `ready`/`resync`
   * are positions — so this is a stream ladder rather than a view one.
   */
  onEvent(kind: StreamKind, data: unknown): void;
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
export class StreamLadder {
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
          this.deps.onEvent(kind, data);
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

/**
 * One long poll of the log, as a client sees it.
 *
 * Deliberately a plain request: no connection to hold, no event kinds, no ladder. The cursor goes in
 * the query and the answer comes back whole — which is the whole reason polling is worth considering
 * over streaming here.
 */
export interface PollResult {
  cursor: number;
  entries: { conversationId: number; entryId: number; role: "user" | "assistant"; text: string; at?: number; origin?: string }[];
  /** How long the server actually waited. Far below `wait` with no entries means a cache answered. */
  waitedMs: number;
  busy?: boolean;
  view?: { liveText: string; busy: boolean; tools: unknown } | null;
}

export async function httpPoll(options: {
  baseUrl: string;
  since: number;
  waitSeconds?: number;
  batchMs?: number;
  conversationId?: number;
  observe?: boolean;
  token?: string;
  signal?: AbortSignal;
}): Promise<PollResult> {
  const query = new URLSearchParams({ since: String(options.since) });
  if (options.waitSeconds !== undefined) query.set("wait", String(options.waitSeconds));
  if (options.batchMs !== undefined) query.set("batch", String(options.batchMs));
  if (options.conversationId !== undefined) query.set("conversation", String(options.conversationId));
  if (options.observe) query.set("observe", "1");
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const response = await fetch(`${options.baseUrl.replace(/\/$/, "")}/v1/poll?${query.toString()}`, {
    headers,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) throw new Error(`poll: HTTP ${response.status}`);
  return (await response.json()) as PollResult;
}
