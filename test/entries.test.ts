/**
 * The reading primitive every surface shares.
 *
 * Two rules carry the weight, and both are about the unit a surface deals in: one *entry* becomes
 * one message (even when the transcript holds several messages for it), and a cursor the pages
 * cannot reach is reported as such rather than silently skipped — which is what lets a caller
 * decide to adopt instead of replaying.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { entriesAfter, type MessageLike } from "../src/durable/entries.js";

function historyOf(messages: MessageLike[]) {
  const reads: { limit: number; offset: number }[] = [];
  return {
    reads,
    history: async (_id: number, limit: number, offset: number) => {
      reads.push({ limit, offset });
      const end = Math.max(0, messages.length - offset);
      return messages.slice(Math.max(0, end - limit), end);
    },
  };
}

const entry = (entryId: number, messages: MessageLike[]) =>
  messages.map((message) => ({ ...message, entryId }));

test("entries come back in order, one per entry id", async () => {
  const messages = [
    ...entry(3, [{ role: "user" as const, text: "a question", origin: "gchat" }]),
    ...entry(4, [
      { role: "assistant" as const, text: "checking" },
      { role: "assistant" as const, text: "the answer", origin: "gchat" },
    ]),
  ];
  const window = await entriesAfter(historyOf(messages), 1, 2);
  assert.deepEqual(
    window.entries.map((row) => [row.entryId, row.role, row.text]),
    [
      [3, "user", "a question"],
      [4, "assistant", "the answer"],
    ],
    "the last message of an entry is the one a surface renders",
  );
  assert.equal(window.newest, 4);
  assert.equal(window.reachedCursor, true);
});

test("nothing after the cursor reads one page and stops", async () => {
  const messages = [...entry(1, [{ role: "user" as const, text: "old", origin: "gchat" }])];
  const fake = historyOf(messages);
  const window = await entriesAfter(fake, 1, 1, { pageSize: 10 });
  assert.deepEqual(window.entries, []);
  assert.equal(window.reachedCursor, true, "the cursor was seen, so there is nothing to replay");
  assert.equal(fake.reads.length, 1, "one page, because the cursor was in it");
});

test("a cursor beyond the page budget is reported, not silently skipped", async () => {
  // This is the signal a caller uses to adopt instead of painting a week of missed answers.
  const messages: MessageLike[] = [];
  for (let id = 2; id <= 40; id += 1) messages.push(...entry(id, [{ role: "assistant" as const, text: `e${id}` }]));
  const window = await entriesAfter(historyOf(messages), 1, 1, { pageSize: 5, maxPages: 2 });
  assert.equal(window.reachedCursor, false, "the pages ran out before the cursor");
  assert.equal(window.newest, 40, "and the newest entry is still known, for adoption");
});

test("an empty conversation is a real answer, not an error", async () => {
  const window = await entriesAfter(historyOf([]), 1, 0);
  assert.deepEqual(window.entries, []);
  assert.equal(window.newest, 0);
  assert.equal(window.reachedCursor, true);
});

test("an unreadable conversation is reported as such", async () => {
  // `undefined` from the host means "no such conversation", which a caller must be able to tell
  // apart from "nothing new".
  const window = await entriesAfter({ history: async () => undefined }, 9, 0);
  assert.deepEqual(window.entries, []);
  assert.equal(window.newest, 0);
});
