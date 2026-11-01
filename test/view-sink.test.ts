/**
 * View-sink tests: the translation from committed view state to ReplyStream
 * calls, and the ordering rules the old event wiring used to provide.
 *
 * No Chat client and no model: a fake stream records what would have been
 * painted, and a fake conversation view lets each test push a view value.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Context } from "@earendil-works/chord";
import type { Conversation } from "@earendil-works/pi-durable";

import { attachViewSink, type StreamTarget } from "../src/adapter/view-sink.js";

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

/** A conversation stub whose view can be driven by the test. */
function fakeConversation(initial: unknown) {
  let listener: ((value: unknown) => void) | undefined;
  let disposed = false;
  const conversation = {
    async viewState() {
      return {
        value: initial,
        subscribe(next: (value: unknown) => void) {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
        dispose() {
          disposed = true;
        },
      };
    },
  };
  return {
    conversation: conversation as unknown as Conversation,
    push(value: unknown) {
      listener?.(value);
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
  const fake = fakeConversation({ entries: [], docs: {} });
  const sink = await attachViewSink({ conversation: fake.conversation, context: {} as Context, stream });
  assert.deepEqual(stream.snapshots, []);
  assert.equal(sink.current().busy, false);
  await sink.detach();
});

test("a partial answer is painted as a whole snapshot", async () => {
  const stream = fakeStream();
  const fake = fakeConversation({ entries: [], docs: {} });
  await attachViewSink({ conversation: fake.conversation, context: {} as Context, stream });
  fake.push(partial("Hello"));
  fake.push(partial("Hello there"));
  assert.deepEqual(stream.snapshots, ["Hello", "Hello there"]);
});

test("a sink attached mid-run paints the current state immediately", async () => {
  const stream = fakeStream();
  const fake = fakeConversation(partial("already answering"));
  await attachViewSink({ conversation: fake.conversation, context: {} as Context, stream });
  assert.deepEqual(stream.snapshots, ["already answering"]);
});

test("tool status follows the newest unfinished call and clears when the round ends", async () => {
  const stream = fakeStream();
  const fake = fakeConversation({ entries: [], docs: {} });
  await attachViewSink({ conversation: fake.conversation, context: {} as Context, stream });

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
  const fake = fakeConversation({ entries: [], docs: {} });
  await attachViewSink({ conversation: fake.conversation, context: {} as Context, stream });
  const tools = [{ callId: "c1", name: "bash", status: "running" }];
  fake.push({ entries: [], docs: { "pi.live": { run: { taskId: 1 }, tools } } });
  fake.push({ entries: [], docs: { "pi.live": { run: { taskId: 1 }, tools } } });
  fake.push({ entries: [], docs: { "pi.live": { run: { taskId: 1 }, tools } } });
  assert.equal(stream.tools.length, 1);
});

test("detach stops painting and disposes the view", async () => {
  const stream = fakeStream();
  const fake = fakeConversation({ entries: [], docs: {} });
  const sink = await attachViewSink({ conversation: fake.conversation, context: {} as Context, stream });
  await sink.detach();
  fake.push(partial("too late"));
  assert.deepEqual(stream.snapshots, []);
  assert.equal(fake.disposed, true);
});
