/**
 * Activity: the server saying what it is doing, so a bridge can stop asking.
 *
 * Two things are being pinned, and the second is the one that matters architecturally: events
 * are *hints*, so a subscriber's only job is to go and read. The first is the optional filter —
 * the chat bridge wants every thread, a browser wants one — and the filter has to be a property
 * of the connection, not of remembered state, or §17 comes undone.
 */
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { handleV1 } from "../src/adapter/v1-routes.js";
import { ActivityFeed, type ActivityEvent } from "../src/durable/activity.js";
import type { SessionHost } from "../src/session-host/api.js";

/** A seam whose view the test drives, so `settled` can be produced without a real turn. */
function fakeSeam(options: { busy?: boolean } = {}) {
  const frames: ((view: { busy: boolean }) => void)[] = [];
  const detaches: number[] = [];
  const seam = {
    attach: async (_id: number, onFrame: (view: { busy: boolean }) => void) => {
      frames.push(onFrame);
      return {
        snapshot: { busy: options.busy ?? true },
        detach() {
          detaches.push(1);
        },
      };
    },
    history: async () => [],
  } as unknown as SessionHost;
  return { seam, frames, detaches };
}

test("a start is announced, and the settle comes from the view rather than from an awaiter", async () => {
  const { seam, frames } = fakeSeam();
  const feed = new ActivityFeed({ seam });
  const seen: ActivityEvent[] = [];
  feed.subscribe((event) => seen.push(event));

  feed.started(7);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen.map((event) => event.kind), ["started"]);

  // Nothing awaited the turn; the view is what says it ended.
  frames[0]?.({ busy: false });
  assert.deepEqual(seen.map((event) => event.kind), ["started", "settled"]);
});

test("one turn is watched once, however many submissions join it", async () => {
  // Several messages can steer one turn. A second watcher would attach to the same view for no
  // reason, and would announce a second settle for one turn.
  const { seam, frames } = fakeSeam();
  const feed = new ActivityFeed({ seam });
  const seen: ActivityEvent[] = [];
  feed.subscribe((event) => seen.push(event));

  feed.started(1);
  feed.started(1);
  feed.started(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(frames.length, 1, "one attachment");
  frames[0]?.({ busy: false });
  assert.deepEqual(seen.map((event) => event.kind), ["started", "started", "started", "settled"]);
});

test("an idle frame before the run starts is not a settle", async () => {
  // The regression that silenced two replies: `started` is announced when the submission is
  // accepted, the run begins a moment later, so the first frame is usually idle. Treating it as
  // the end closed the painter's view before the turn began, and nothing ever posted the answer.
  const { seam, frames } = fakeSeam({ busy: false });
  const feed = new ActivityFeed({ seam, settleGraceMs: 60_000 });
  const seen: ActivityEvent[] = [];
  feed.subscribe((event) => seen.push(event));

  feed.started(5);
  await new Promise((resolve) => setImmediate(resolve));
  frames[0]?.({ busy: false }); // the gap between accepting and starting
  assert.deepEqual(seen.map((event) => event.kind), ["started"], "not settled: the turn has not run yet");

  frames[0]?.({ busy: true });
  frames[0]?.({ busy: false });
  assert.deepEqual(seen.map((event) => event.kind), ["started", "settled"], "settled when it actually ended");
});

test("a turn that never starts settles on the grace timeout", async () => {
  // A submission that fails before running must still produce a settle, or a reader waits forever.
  const { seam } = fakeSeam({ busy: false });
  const feed = new ActivityFeed({ seam, settleGraceMs: 5 });
  const seen: ActivityEvent[] = [];
  feed.subscribe((event) => seen.push(event));
  feed.started(6);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(seen.map((event) => event.kind), ["started", "settled"]);
});

test("a listener that throws does not silence the others", async () => {
  const { seam } = fakeSeam();
  const feed = new ActivityFeed({ seam, log: () => {} });
  const seen: string[] = [];
  feed.subscribe(() => {
    throw new Error("dead socket");
  });
  feed.subscribe((event) => seen.push(event.kind));
  feed.started(1);
  assert.deepEqual(seen, ["started"]);
});
