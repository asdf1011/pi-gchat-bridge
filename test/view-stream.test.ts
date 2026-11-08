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

/* --- the server --------------------------------------------------------------------- */

function fakeSeam() {
  const frames: ((view: ProjectedView) => void)[] = [];
  const snapshot: ProjectedView = { liveText: "thinking", busy: true, lastAssistantText: "", tools: [] };
  const seam = {
    history: async () => [],
    attach: async (_id: number, onFrame: (view: ProjectedView) => void) => {
      frames.push(onFrame);
      return { snapshot, detach() {} };
    },
  } as unknown as SessionHost;
  return { seam, frames, snapshot };
}

async function serve(seam: SessionHost, heartbeatMs: number) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void handleV1(req, res, url, {
      seam,
      conversations: async () => [{ conversationId: 1, address: "spaces/S/threads/T" }],
      heartbeatMs,
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** Read SSE frames until `stop` says we have enough. */
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
      const chunk = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const event = /^event: (.*)$/m.exec(chunk)?.[1] ?? "message";
      const data = /^data: (.*)$/m.exec(chunk)?.[1] ?? "";
      events.push({ event, data });
      index = buffer.indexOf("\n\n");
    }
  }
  reader.cancel().catch(() => {});
  return events;
}

test("a viewer gets the snapshot on attach, then pushed frames, then heartbeats", async () => {
  const { seam, frames } = fakeSeam();
  const served = await serve(seam, 30);
  try {
    const response = await fetch(`${served.url}/v1/conversations/1/view`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);

    // Push a change before reading, so the frame is already queued.
    await new Promise((resolve) => setTimeout(resolve, 5));
    frames[0]?.({ liveText: "more", busy: true, lastAssistantText: "", tools: [] });

    const events = await readEvents(response, 3);
    assert.equal(events[0]?.event, "view", "the snapshot comes first, so a late joiner paints");
    assert.match(events[0]?.data ?? "", /thinking/);
    assert.equal(events[1]?.event, "view");
    assert.match(events[1]?.data ?? "", /more/);
    // A fixed cadence, independent of activity: that is what makes absence meaningful.
    assert.equal(events[2]?.event, "heartbeat");
  } finally {
    await served.close();
  }
});

test("watching a conversation that does not exist is a 404, not an open stream", async () => {
  const missing = { history: async () => undefined } as unknown as SessionHost;
  const served = await serve(missing, 30);
  try {
    assert.equal((await fetch(`${served.url}/v1/conversations/9/view`)).status, 404);
  } finally {
    await served.close();
  }
});

/* --- the client against the real stream --------------------------------------------- */

test("the SSE client reads the same frames the server writes, and abort ends it", async () => {
  const { seam, frames } = fakeSeam();
  const served = await serve(seam, 25);
  try {
    const received: { kind: string; data: unknown }[] = [];
    const controller = new AbortController();
    const done = httpViewSource({ baseUrl: served.url, conversationId: 1 }).open((kind, data) => {
      received.push({ kind, data });
    }, controller.signal);

    // Give the stream a moment to attach, push a change, then let heartbeats accumulate.
    await new Promise((resolve) => setTimeout(resolve, 20));
    frames[0]?.({ liveText: "half", busy: true, lastAssistantText: "", tools: [] });
    await new Promise((resolve) => setTimeout(resolve, 120));

    assert.ok(received.length >= 2, `expected frames, got ${received.length}`);
    assert.equal(received[0]?.kind, "view", "the snapshot arrives first");
    assert.ok(
      received.some((frame) => frame.kind === "view" && (frame.data as { liveText?: string }).liveText === "half"),
      "the pushed change arrived",
    );
    assert.ok(
      received.some((frame) => frame.kind === "heartbeat"),
      "and the heartbeat, which is the only proof the stream is alive",
    );

    // Abort must end `open`, or the ladder would wait forever on a stream it abandoned.
    controller.abort();
    await done;
  } finally {
    await served.close();
  }
});
