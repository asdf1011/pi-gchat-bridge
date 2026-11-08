/**
 * The view stream and its client ladder.
 *
 * Two halves again, and the split is the point: the *server* half is tested for what it
 * emits (a snapshot on attach, pushed frames, a heartbeat at a fixed cadence that does not
 * depend on activity), and the *client* half for the policy that decides when to stop
 * trusting it. What must never happen is both mechanisms at once (§18): a bridge that
 * polls while its stream is healthy is two answers to one question.
 *
 * The ladder is driven by injected time and a fake source, because a ladder that can only
 * be tested by waiting is a ladder nobody tests.
 */
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { handleV1 } from "../src/adapter/v1-routes.js";
import { httpViewSource } from "../src/adapter/view-client.js";
import { decide, StreamLadder, type LadderPolicy, type StreamSource } from "../src/adapter/view-client.js";
import type { ProjectedView } from "../src/session-host/projection.js";
import type { SessionHost } from "../src/session-host/api.js";

const policy: LadderPolicy = { suspectAfterMs: 100, degradeAfter: 3 };

/* --- policy ------------------------------------------------------------------------- */

test("a healthy stream is left alone", () => {
  assert.equal(decide({ mode: "push", silentForMs: 10, failedReconnects: 0 }, policy), "wait");
});

test("silence past the threshold means reconnect", () => {
  assert.equal(decide({ mode: "push", silentForMs: 100, failedReconnects: 0 }, policy), "reconnect");
});

test("enough failed reconnects degrade to polling, whatever the silence says", () => {
  // Freshly connected and silent for no time at all: still degraded, because the stream is
  // not *holding* — a stream that opens and dies repeatedly is worse than no stream.
  assert.equal(decide({ mode: "push", silentForMs: 0, failedReconnects: 3 }, policy), "degrade");
});

/* --- the client --------------------------------------------------------------------- */

/** A view source the test drives: `open` resolves when told to. */
function fakeSource() {
  const opens: { onFrame(kind: "view" | "heartbeat", data: unknown): void; finish(): void }[] = [];
  const source: StreamSource = {
    open: (onFrame, signal) =>
      new Promise<void>((resolve) => {
        // Honours the abort, like a real implementation must: `stop()` cannot wait for a
        // connection that may never speak again.
        signal.addEventListener("abort", () => resolve(), { once: true });
        opens.push({ onFrame, finish: resolve });
      }),
  };
  return { source, opens };
}

function ladder(deps: Partial<Parameters<typeof StreamLadder.prototype.constructor>[0]> = {}) {
  const { source, opens } = fakeSource();
  const views: unknown[] = [];
  const kinds: string[] = [];
  const modes: string[] = [];
  let polls = 0;
  const policy = { suspectAfterMs: 100, degradeAfter: 2 };
  const time = { now: 1_000 };
  const instance = new StreamLadder({
    source,
    onEvent: (kind, view) => {
      kinds.push(kind);
      views.push(view);
    },
    poll: async () => {
      polls += 1;
    },
    heartbeatMs: 50,
    policy,
    now: () => time.now,
    pollIntervalMs: 1,
    // No real waiting: the ladder's *decisions* are what is under test, not the clock.
    delay: async () => {},
    onMode: (mode) => modes.push(mode),
    log: () => {},
    ...deps,
  });
  return { instance, opens, views, kinds, modes, time, polls: () => polls, policy };
}

test("view frames are passed on, and heartbeats keep the stream trusted", async () => {
  const { instance, opens, views, kinds } = ladder();
  const running = instance.run();
  await Promise.resolve();
  opens[0]!.onFrame("view", { liveText: "half an answer" });
  opens[0]!.onFrame("heartbeat", { at: 1 });
  // Every frame reaches the caller with its kind, because a stream carries several kinds and only
  // the caller knows which matter. The ladder's own business is liveness, which it takes from all of
  // them; filtering here would mean touching the ladder whenever a stream gains an event.
  assert.deepEqual(views, [{ liveText: "half an answer" }, { at: 1 }]);
  assert.deepEqual(kinds, ["view", "heartbeat"]);
  instance.stop();
  await running;
});

test("a stream that ends before it holds degrades to polling", async () => {
  const { instance, opens, modes, polls } = ladder();
  const running = instance.run();
  // Each attempt connects and immediately ends: the ladder counts that as a failure.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await Promise.resolve();
    opens.at(-1)?.finish();
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(modes.includes("degraded"), "polling comes on only after the stream fails to hold");
  assert.ok(polls() >= 1, "and it actually polls while degraded");
  instance.stop();
  await running.catch(() => {});
});

test("the first frame after a recovery stops polling again", async () => {
  const { instance, opens, modes } = ladder();
  const running = instance.run();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await Promise.resolve();
    opens.at(-1)?.finish();
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(modes, ["degraded"]);
  // A subscription that delivers is the only evidence that counts: back to push, no poll.
  opens.at(-1)?.onFrame("heartbeat", { at: 2 });
  assert.deepEqual(modes, ["degraded", "push"]);
  instance.stop();
  await running.catch(() => {});
});
