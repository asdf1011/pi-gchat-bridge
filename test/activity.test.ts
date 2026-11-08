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

/* --- the stream, with and without a filter ------------------------------------------ */

async function serve(feed: ActivityFeed) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void handleV1(req, res, url, {
      seam: { history: async () => [] } as unknown as SessionHost,
      conversations: async () => [],
      activity: feed,
      heartbeatMs: 20,
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** Read SSE events until `count` arrive. */
async function readEvents(response: Response, count: number): Promise<{ event: string; data: string }[]> {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const events: { event: string; data: string }[] = [];
  let buffer = "";
  while (events.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf("\n\n");
    while (index !== -1) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
      const data = /^data: (.*)$/m.exec(block)?.[1] ?? "";
      if (event !== "heartbeat") events.push({ event, data });
      else if (events.length === 0 && count > 0) {
        /* keep reading: the test asked for activity, not heartbeats */
      }
      index = buffer.indexOf("\n\n");
    }
    if (events.length >= count) break;
  }
  reader.cancel().catch(() => {});
  return events;
}

test("activity is unfiltered, and points at the per-conversation stream instead", async () => {
  const { seam } = fakeSeam();
  const feed = new ActivityFeed({ seam });
  const served = await serve(feed);
  try {
    // A filtered activity stream *is* a per-conversation stream, and that one also carries the live
    // view — so it has a path of its own rather than being a mode of this one.
    const refused = await fetch(`${served.url}/v1/activity?conversation=2`);
    assert.equal(refused.status, 400);
    assert.match(((await refused.json()) as { error: string }).error, /conversations\/\{id\}\/events/);

    const all = await fetch(`${served.url}/v1/activity`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    feed.started(1);
    feed.started(2);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const events = await readEvents(all, 2);
    assert.deepEqual(
      events.map((event) => JSON.parse(event.data).conversationId),
      [1, 2],
      "the chat bridge's shape: every conversation",
    );
  } finally {
    await served.close();
    feed.close();
  }
});

test("one conversation's stream carries boundaries and live frames together", async () => {
  // The pane's shape: one connection for the conversation it is showing, instead of one activity
  // subscription plus one view subscription for the same reader.
  const { seam, frames } = fakeSeam();
  const feed = new ActivityFeed({ seam });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void handleV1(req, res, url, {
      seam: {
        ...(seam as unknown as Record<string, unknown>),
        history: async () => [],
        attach: async (_id: number, onFrame: (view: unknown) => void) => {
          frames.push(onFrame as never);
          return { snapshot: { liveText: "starting", busy: true, lastAssistantText: "", tools: [] }, detach() {} };
        },
      } as unknown as SessionHost,
      conversations: async () => [],
      activity: feed,
      heartbeatMs: 5_000,
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/conversations/1/events`);
    assert.equal(response.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));

    feed.started(1); // a boundary for this conversation
    feed.started(2); // and one for another, which must not arrive here
    frames[0]?.({ liveText: "half", busy: true, lastAssistantText: "", tools: [] });
    await new Promise((resolve) => setTimeout(resolve, 30));

    const events = await readEvents(response, 3);
    assert.deepEqual(
      events.map((event) => event.event),
      ["view", "activity", "view"],
      "the snapshot first, then the boundary, then live text",
    );
    assert.equal(JSON.parse(events[1]!.data).conversationId, 1, "only this conversation's boundary");
    assert.match(events[2]!.data, /half/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    feed.close();
  }
});

test("activity is 404 where the deployment does not serve it", async () => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void handleV1(req, res, url, { seam: { history: async () => [] } as unknown as SessionHost, conversations: async () => [] });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/activity`)).status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
