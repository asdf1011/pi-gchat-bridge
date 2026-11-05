/**
 * The naming pass: which conversations it picks up, and what it does with them.
 *
 * The interesting behaviour is not "a title was produced" but the loop's manners —
 * it must skip what it should not touch, contain failures, and stop when there is
 * nothing left. A pass that retried forever, or that titled a validation thread,
 * would be worse than no pass at all.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { nameUntitledConversations, needsTitle } from "../src/durable/naming.js";
import type { NamedConversation, SessionHost } from "../src/session-host/api.js";

function conversation(over: Partial<NamedConversation> & { conversationId: number }): NamedConversation {
  return { name: `threads/${over.conversationId}`, model: "p/m", createdAt: 0, ...over };
}

const config = { baseUrl: "http://titler.invalid/v1", model: "m", timeoutMs: 1000 };

/** A seam that hands out the listed conversations and records labels. */
function fakeSeam(conversations: NamedConversation[], options: { failFirstTurn?: boolean } = {}) {
  const labels = new Map<string, string>();
  let listCalls = 0;
  const seam = {
    list: async () => {
      listCalls += 1;
      return conversations.map((c) => ({ ...c, ...(labels.has(c.name) ? { label: labels.get(c.name) } : {}) }));
    },
    firstTurn: async () => {
      if (options.failFirstTurn) throw new Error("boom");
      return { userText: "how do I shrink a disk image", assistantText: "truncate" };
    },
    label: async (name: string, label: string) => {
      labels.set(name, label);
      return true;
    },
  } as unknown as SessionHost;
  return { seam, labels, listCalls: () => listCalls };
}

test("only conversations without a title need one", () => {
  assert.equal(needsTitle(conversation({ conversationId: 1 })), true);
  assert.equal(needsTitle(conversation({ conversationId: 1, label: "Disk images" })), false);
  // A validation thread is machinery, not a conversation a person reads.
  assert.equal(needsTitle({ conversationId: 2, name: "validation:spaces/S/T", model: "m", createdAt: 0 }), false);
});

test("it names every untitled conversation and then stops", async () => {
  const { seam, labels } = fakeSeam([
    conversation({ conversationId: 1 }),
    conversation({ conversationId: 2, label: "already named" }),
    conversation({ conversationId: 3 }),
  ]);
  let calls = 0;

  const named = await nameUntitledConversations({
    seam,
    config,
    intervalMs: 0,
    summarize: async (turn) => {
      calls += 1;
      return `title ${calls}`;
    },
  });

  assert.equal(named, 2, "both untitled conversations are named");
  assert.equal(calls, 2, "the titled one is left alone");
  assert.deepEqual([...labels.keys()].sort(), ["threads/1", "threads/3"]);
});

test("a titler that fails is retried, and does not stop the pass", async () => {
  const { seam, labels } = fakeSeam([conversation({ conversationId: 1 }), conversation({ conversationId: 2 })]);
  let attempts = 0;

  const named = await nameUntitledConversations({
    seam,
    config,
    intervalMs: 0,
    retryAfterMs: 1,
    summarize: async () => {
      attempts += 1;
      // The first attempt fails, like a titler that is down for a moment.
      if (attempts === 1) throw new Error("titler down");
      return `title ${attempts}`;
    },
  });

  assert.equal(named, 2);
  assert.equal(labels.size, 2);
});

test("a conversation with nothing said yet is left for a later pass", async () => {
  const seam = {
    list: async () => [conversation({ conversationId: 1 })],
    firstTurn: async () => undefined,
    label: async () => true,
  } as unknown as SessionHost;

  // Returns rather than looping: a thread with no words has nothing to title, and
  // the next pass (after a message) will pick it up.
  assert.equal(await nameUntitledConversations({ seam, config, intervalMs: 0, summarize: async () => "x" }), 0);
});
