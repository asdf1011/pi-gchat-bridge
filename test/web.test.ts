/**
 * The web sink is a second view onto one conversation.
 *
 * What these pin is not the HTTP plumbing but the property the whole migration
 * was for: a client attached to a conversation receives the state of a turn it
 * did not start. A test that only checked "an event was emitted" would pass
 * even if the browser and Chat saw different conversations.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { attachWebClient, webIndex, webSubmit, type SseClient, type WebOptions } from "../src/adapter/web.js";

interface Sent {
  event: string;
  data: unknown;
}

/** A fake SSE client that records what it was sent. */
function client(): SseClient & { sent: Sent[] } {
  const sent: Sent[] = [];
  let alive = true;
  return {
    sent,
    get open() {
      return alive;
    },
    send(event, data) {
      if (alive) sent.push({ event, data });
    },
    // Test-only kill switch, standing in for a dropped connection.
    close() {
      alive = false;
    },
  } as SseClient & { sent: Sent[]; close(): void };
}

/**
 * A conversation whose view a test can drive.
 *
 * `subscribe` is single-use in Chord, and `viewState` returns a fresh attachment
 * per call, so the fake reflects that: each call yields its own listener, and a
 * commit notifies every one of them.
 */
function fakeConversation(initial: unknown) {
  const listeners: ((value: unknown) => void)[] = [];
  let value = initial;
  return {
    conversation: {
      viewState: async () => ({
        value,
        subscribe: (fn: (v: unknown) => void) => {
          listeners.push(fn);
        },
        dispose: () => {},
      }),
    },
    /** Commit a new view, as the harness does after a run step. */
    push(next: unknown) {
      value = next;
      for (const fn of listeners) fn(next);
    },
    listenerCount: () => listeners.length,
  };
}

function fakeHost(conversation: unknown, bindings: Record<string, unknown> = {}) {
  return {
    context: {},
    harness: {
      conversation: async (id: number) => (id === 1 ? conversation : undefined),
    },
    bindings: async () => ({ byChatKey: bindings }),
  } as unknown as WebOptions["host"];
}

const CONVERSATION = {
  entries: [],
  docs: { "pi.live": { run: { status: "running" }, generation: { message: { role: "assistant", content: [] } } } },
};

test("a client is painted the state of a turn it did not start", async () => {
  const fake = fakeConversation(undefined);
  const c = client();
  const host = fakeHost(fake.conversation);

  await attachWebClient({ host, model: { provider: "p", modelId: "m" } }, 1, c);

  // Nothing has happened yet: an idle conversation paints nothing rather than
  // an empty answer, which would look like a failed reply.
  assert.equal(c.sent.length, 0);

  // A turn committed by *someone else* — this is the sync being tested.
  fake.push({
    entries: [],
    docs: {
      "pi.live": {
        run: { status: "running" },
        generation: { message: { role: "assistant", content: [{ type: "text", text: "Hello" }] } },
      },
    },
  });

  const text = c.sent.filter((s) => s.event === "text");
  assert.equal(text.length, 1);
  assert.deepEqual(text[0].data, { text: "Hello", busy: true });
});

test("a late joiner is seeded from the snapshot, not left blank", async () => {
  const fake = fakeConversation({
    entries: [],
    docs: {
      "pi.live": {
        run: { status: "running" },
        generation: { message: { role: "assistant", content: [{ type: "text", text: "half an ans" }] } },
      },
    },
  });
  const c = client();
  await attachWebClient({ host: fakeHost(fake.conversation), model: { provider: "p", modelId: "m" } }, 1, c);
  // Snapshot first, so connecting mid-turn shows the in-progress answer.
  fake.push({
    entries: [],
    docs: {
      "pi.live": {
        run: { status: "running" },
        generation: { message: { role: "assistant", content: [{ type: "text", text: "half an answer" }] } },
      },
    },
  });
  assert.equal((c.sent.at(-1)!.data as { text: string }).text, "half an answer");
});

test("identical snapshots are not re-sent", async () => {
  const fake = fakeConversation(undefined);
  const c = client();
  await attachWebClient({ host: fakeHost(fake.conversation), model: { provider: "p", modelId: "m" } }, 1, c);
  const view = {
    entries: [],
    docs: { "pi.live": { run: { status: "running" }, generation: { message: { role: "assistant", content: [{ type: "text", text: "x" }] } } } },
  };
  fake.push(view);
  fake.push(view); // a commit that did not change the text
  assert.equal(c.sent.filter((s) => s.event === "text").length, 1);
});

test("a second client is independent of the first", async () => {
  const fake = fakeConversation(undefined);
  const a = client();
  const b = client();
  const host = fakeHost(fake.conversation);
  await attachWebClient({ host, model: { provider: "p", modelId: "m" } }, 1, a);
  await attachWebClient({ host, model: { provider: "p", modelId: "m" } }, 1, b);

  // Two attachments, as two browsers: not one shared listener.
  assert.equal(fake.listenerCount(), 2);

  fake.push({
    entries: [],
    docs: { "pi.live": { run: { status: "running" }, generation: { message: { role: "assistant", content: [{ type: "text", text: "both" }] } } } },
  });
  assert.equal((a.sent.at(-1)!.data as { text: string }).text, "both");
  assert.equal((b.sent.at(-1)!.data as { text: string }).text, "both");
});

test("closing one client leaves the other attached", async () => {
  const fake = fakeConversation(undefined);
  const a = client();
  const b = client();
  const host = fakeHost(fake.conversation);
  const handleA = await attachWebClient({ host, model: { provider: "p", modelId: "m" } }, 1, a);
  await attachWebClient({ host, model: { provider: "p", modelId: "m" } }, 1, b);
  handleA.close();

  fake.push({
    entries: [],
    docs: { "pi.live": { run: { status: "running" }, generation: { message: { role: "assistant", content: [{ type: "text", text: "after" }] } } } },
  });
  assert.equal(a.sent.filter((s) => s.event === "text").length, 0);
  assert.equal((b.sent.at(-1)!.data as { text: string }).text, "after");
});

test("an unknown conversation reports an error instead of hanging", async () => {
  const c = client();
  await attachWebClient({ host: fakeHost(undefined), model: { provider: "p", modelId: "m" } }, 999, c);
  assert.equal(c.sent[0].event, "error");
});

test("the index lists conversations newest first", async () => {
  const host = fakeHost(undefined, {
    "spaces/A": { conversationId: 1, model: "p/m", createdAt: 100 },
    "spaces/B": { conversationId: 2, model: "p/m", createdAt: 300, name: "Named" },
  });
  const rows = await webIndex(host);
  assert.deepEqual(rows.map((r) => r.conversationId), [2, 1]);
  assert.equal(rows[0].name, "Named");
});

test("an empty message is refused rather than submitted", async () => {
  const submitted: unknown[] = [];
  const host = {
    context: {},
    harness: { conversation: async () => ({ submit: async (s: unknown) => { submitted.push(s); return { id: 1 }; } }) },
  } as unknown as WebOptions["host"];
  const result = await webSubmit({ host, model: { provider: "p", modelId: "m" } }, 1, "   ");
  assert.equal(result.ok, false);
  assert.equal(submitted.length, 0);
});

test("a web message steers by default, matching a Chat message", async () => {
  const submitted: { whenBusy?: string }[] = [];
  const host = {
    context: {},
    harness: {
      conversation: async () => ({ submit: async (s: { whenBusy?: string }) => { submitted.push(s); return { id: 7 }; } }),
    },
  } as unknown as WebOptions["host"];
  const result = await webSubmit({ host, model: { provider: "p", modelId: "m" } }, 1, "hello");
  assert.equal(result.ok, true);
  // A browser message must join a running Chat turn, not queue behind it: that
  // is what makes the two frontends one conversation rather than two.
  assert.equal(submitted[0].whenBusy, "steer");
});
