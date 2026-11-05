/**
 * View-sink tests: the translation from committed view state to ReplyStream
 * calls, and the ordering rules the old event wiring used to provide.
 *
 * No Chat client and no model: a fake stream records what would have been
 * painted, and a fake conversation view lets each test push a view value.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { attachViewSink, type StreamTarget } from "../src/adapter/view-sink.js";
import type { SessionHost } from "../src/session-host/api.js";
import { projectView, type ProjectedView, type ViewLike } from "../src/session-host/projection.js";

interface FakeStream extends StreamTarget {
  snapshots: string[];
  tools: { name: string; args: unknown }[];
  cleared: number;
}

function fakeStream(): FakeStream {
  return {
    snapshots: [],
    tools: [],
    cleared: 0,
    onSnapshot(full: string) {
      this.snapshots.push(full);
    },
    showTool(name: string, args: unknown) {
      this.tools.push({ name, args });
    },
    clearTool() {
      this.cleared += 1;
    },
  };
}

/**
 * A seam stub whose frames the test drives.
 *
 * Frames are projections now, so the stub projects: raw views in, the same shape
 * the host would send out. That keeps the assertions below about *painting* rules
 * rather than about projection, which \`projection.test.ts\` covers.
 */
function fakeSeam(initial: unknown) {
  let listener: ((next: ProjectedView) => void) | undefined;
  let disposed = false;
  const seam = {
    attach: async (_id: number, onFrame: (next: ProjectedView) => void) => {
      listener = (raw) => onFrame(raw);
      const snapshot = projectView(initial as ViewLike);
      // The seam contract: the current state arrives as the first frame.
      onFrame(snapshot);
      return {
        snapshot,
        detach() {
          disposed = true;
          listener = undefined;
        },
      };
    },
  } as unknown as SessionHost;
  return {
    seam,
    push(value: unknown) {
      listener?.(projectView(value as ViewLike));
    },
    get disposed() {
      return disposed;
    },
  };
}

const partial = (text: string, tools: unknown[] = [], run = true) => ({
  entries: [],
  docs: { "pi.live": { ...(run ? { run: { taskId: 1 } } : {}), generation: { message: { content: [{ type: "text", text }] } }, tools } },
});

test("an idle initial view paints nothing", async () => {
  const stream = fakeStream();
  const fake = fakeSeam({ entries: [], docs: {} });
  const sink = await attachViewSink({ seam: fake.seam, conversationId: 1, stream });
  assert.deepEqual(stream.snapshots, []);
  assert.equal(sink.current().busy, false);
  await sink.detach();
});

test("a partial answer is painted as a whole snapshot", async () => {
  const stream = fakeStream();
  const fake = fakeSeam({ entries: [], docs: {} });
  await attachViewSink({ seam: fake.seam, conversationId: 1, stream });
  fake.push(partial("Hello"));
  fake.push(partial("Hello there"));
  assert.deepEqual(stream.snapshots, ["Hello", "Hello there"]);
});

test("a sink attached mid-run paints the current state immediately", async () => {
  const stream = fakeStream();
  const fake = fakeSeam(partial("already answering"));
  await attachViewSink({ seam: fake.seam, conversationId: 1, stream });
  assert.deepEqual(stream.snapshots, ["already answering"]);
});

test("tool status follows the newest unfinished call and clears when the round ends", async () => {
  const stream = fakeStream();
  const fake = fakeSeam({ entries: [], docs: {} });
  await attachViewSink({ seam: fake.seam, conversationId: 1, stream });

  const entries = [
    {
      kind: "pi.assistant",
      model: [{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }] }],
    },
  ];
  fake.push({ entries, docs: { "pi.live": { run: { taskId: 1 }, tools: [{ callId: "c1", name: "bash", status: "running" }] } } });
  fake.push({ entries, docs: { "pi.live": { run: { taskId: 1 }, tools: [{ callId: "c1", name: "bash", status: "done" }] } } });

  assert.deepEqual(stream.tools, [{ name: "bash", args: { command: "ls" } }]);
  assert.equal(stream.cleared, 1);
});

test("the same running tool is not re-shown on every progress commit", async () => {
  const stream = fakeStream();
  const fake = fakeSeam({ entries: [], docs: {} });
  await attachViewSink({ seam: fake.seam, conversationId: 1, stream });
  const tools = [{ callId: "c1", name: "bash", status: "running" }];
  fake.push({ entries: [], docs: { "pi.live": { run: { taskId: 1 }, tools } } });
  fake.push({ entries: [], docs: { "pi.live": { run: { taskId: 1 }, tools } } });
  fake.push({ entries: [], docs: { "pi.live": { run: { taskId: 1 }, tools } } });
  assert.equal(stream.tools.length, 1);
});

test("detach stops painting and disposes the view", async () => {
  const stream = fakeStream();
  const fake = fakeSeam({ entries: [], docs: {} });
  const sink = await attachViewSink({ seam: fake.seam, conversationId: 1, stream });
  await sink.detach();
  fake.push(partial("too late"));
  assert.deepEqual(stream.snapshots, []);
  assert.equal(fake.disposed, true);
});
