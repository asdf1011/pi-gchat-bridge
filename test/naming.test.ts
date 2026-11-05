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

test("a titler that fails does not stop the pass, and the thread is named next time", async () => {
  // A seam that remembers labels, so the pass can actually finish.
  const labels = new Map<string, string>();
  let fail = true;
  const seam = {
    list: async () =>
      [conversation({ conversationId: 1 }), conversation({ conversationId: 2 })].map((c) => ({
        ...c,
        ...(labels.has(c.name) ? { label: labels.get(c.name) } : {}),
      })),
    firstTurn: async () => ({ userText: "how do I shrink a disk image", assistantText: "truncate" }),
    label: async (name: string, label: string) => {
      labels.set(name, label);
      return true;
    },
  } as unknown as SessionHost;

  const summarize = async () => {
    if (fail) throw new Error("titler down");
    return "Disk images";
  };

  // First pass: every attempt fails, every conversation is skipped, and the pass
  // ends rather than spinning.
  assert.equal(await nameUntitledConversations({ seam, config, intervalMs: 0, retryAfterMs: 1, summarize }), 0);
  assert.equal(labels.size, 0);

  // Second pass, titler back: the backlog is picked up where it was left.
  fail = false;
  assert.equal(await nameUntitledConversations({ seam, config, intervalMs: 0, retryAfterMs: 1, summarize }), 2);
  assert.equal(labels.size, 2);
});

test("a conversation with nothing to title is skipped, not retried forever", async () => {
  const labels: string[] = [];
  const stored = new Map<string, string>();
  const seam = {
    list: async () =>
      [conversation({ conversationId: 1 }), conversation({ conversationId: 2 })].map((c) => ({
        ...c,
        ...(stored.has(c.name) ? { label: stored.get(c.name) } : {}),
      })),
    firstTurn: async (id: number) =>
      id === 1 ? undefined : { userText: "how do I shrink a disk image", assistantText: "truncate" },
    label: async (name: string, label: string) => {
      labels.push(name);
      stored.set(name, label);
      return true;
    },
  } as unknown as SessionHost;

  // One unnameable conversation must not block the backlog behind it: that is what
  // "no title came back" once a minute for minutes looked like from the log.
  const named = await nameUntitledConversations({
    seam,
    config,
    intervalMs: 0,
    retryAfterMs: 1,
    summarize: async () => "Disk images",
  });
  assert.equal(named, 1);
  assert.deepEqual(labels, ["threads/2"]);
});

test("a conversation the titler refuses is also skipped", async () => {
  const labels = new Map<string, string>();
  const seam = {
    list: async () =>
      [conversation({ conversationId: 1 }), conversation({ conversationId: 2 })].map((c) => ({
        ...c,
        ...(labels.has(c.name) ? { label: labels.get(c.name) } : {}),
      })),
    firstTurn: async () => ({ userText: "hello", assistantText: "hi" }),
    label: async (name: string, label: string) => {
      labels.set(name, label);
      return true;
    },
  } as unknown as SessionHost;

  let calls = 0;
  const named = await nameUntitledConversations({
    seam,
    config,
    intervalMs: 0,
    retryAfterMs: 1,
    summarize: async () => {
      calls += 1;
      return calls === 1 ? undefined : "Second title";
    },
  });
  assert.equal(named, 1, "the second conversation is named; the first is left alone this pass");
  assert.equal(calls, 2, "no conversation is asked about twice in one pass");
  assert.deepEqual([...labels.keys()], ["threads/2"]);
});

test("maxPerPass limits a pass, so a slow titler does not hog the machine", async () => {
  const labels: string[] = [];
  const stored = new Map<string, string>();
  const seam = {
    list: async () =>
      [conversation({ conversationId: 1 }), conversation({ conversationId: 2 }), conversation({ conversationId: 3 })].map((c) => ({
        ...c,
        ...(stored.has(c.name) ? { label: stored.get(c.name) } : {}),
      })),
    firstTurn: async () => ({ userText: "hello", assistantText: "hi" }),
    label: async (name: string, label: string) => {
      labels.push(name);
      stored.set(name, label);
      return true;
    },
  } as unknown as SessionHost;

  const named = await nameUntitledConversations({
    seam,
    config,
    intervalMs: 0,
    summarize: async () => "title",
    maxPerPass: 1,
  });
  assert.equal(named, 1, "one title per pass");
  assert.equal(labels.length, 1);
});
