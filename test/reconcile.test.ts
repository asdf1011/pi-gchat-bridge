/**
 * The invariant check: does the cursor agree with what was actually posted?
 *
 * This is the safety net for the migration, not for production behaviour, so what is
 * tested is the *judgement*: a disagreement that clears within a pass must be quiet,
 * a persistent one must be loud, and it must be loud exactly once rather than every
 * pass forever.
 *
 * Both directions matter and they are not the same fault: an answer the cursor
 * believes in but nobody posted is a hole in the thread; a cursor stuck behind the
 * poster means the walk has stopped moving. The fake clock is what makes the grace
 * period testable at all.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { reconcile, type ReconcileState } from "../src/durable/reconcile.js";

const empty = (): ReconcileState => ({ pending: {} });

function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const deps = (posted: Record<number, number | undefined>, time: { now(): number }) => ({
  lastPosted: async (conversationId: number) => posted[conversationId],
  graceMs: 60_000,
  now: time.now,
});

test("an answer posted moments after the cursor confirms it is not a fault", async () => {
  const time = clock();
  const answer = { conversationId: 1, entryId: 10 };

  // First pass: the cursor is ahead of the mouth, which is normal — the pass runs on
  // a timer and the poster runs on a turn.
  let result = await reconcile(empty(), { confirmed: [answer], cursors: [] }, deps({ 1: 9 }, time));
  assert.deepEqual(result.unposted, []);
  assert.equal(result.recovered, 0);

  // A minute later it has been posted: the disagreement simply disappears.
  time.advance(61_000);
  result = await reconcile(result.state, { confirmed: [answer], cursors: [] }, deps({ 1: 10 }, time));
  assert.deepEqual(result.unposted, []);
  assert.equal(result.recovered, 1, "clearing on its own is worth recording");
});

test("an answer that stays unposted past the grace period is reported, once", async () => {
  const time = clock();
  const answer = { conversationId: 1, entryId: 10 };

  let result = await reconcile(empty(), { confirmed: [answer], cursors: [] }, deps({ 1: 8 }, time));
  assert.deepEqual(result.unposted, [], "too early to accuse anyone");

  time.advance(61_000);
  result = await reconcile(result.state, { confirmed: [answer], cursors: [] }, deps({ 1: 8 }, time));
  assert.deepEqual(result.unposted, [answer]);

  // And it must not shout every pass for the rest of the process's life.
  time.advance(61_000);
  result = await reconcile(result.state, { confirmed: [answer], cursors: [] }, deps({ 1: 8 }, time));
  assert.deepEqual(result.unposted, [], "reported once, then held");
});

test("nothing posted at all is still a divergence, not a reason to throw", async () => {
  const time = clock();
  let result = await reconcile(
    empty(),
    { confirmed: [{ conversationId: 2, entryId: 7 }], cursors: [] },
    deps({}, time),
  );
  time.advance(61_000);
  result = await reconcile(result.state, { confirmed: [{ conversationId: 2, entryId: 7 }], cursors: [] }, deps({}, time));
  assert.deepEqual(result.unposted, [{ conversationId: 2, entryId: 7 }]);
});

test("a cursor stuck behind the poster is reported as lag, separately", async () => {
  const time = clock();
  const cursors = [{ conversationId: 3, cursor: 20 }];

  let result = await reconcile(empty(), { confirmed: [], cursors }, deps({ 3: 25 }, time));
  assert.deepEqual(result.lagging, [], "one pass of lag is just the timer");

  time.advance(61_000);
  result = await reconcile(result.state, { confirmed: [], cursors }, deps({ 3: 25 }, time));
  assert.deepEqual(result.lagging, [{ conversationId: 3, cursor: 20, posted: 25 }]);
});

test("a lag that catches up clears without a word", async () => {
  const time = clock();
  const cursors = [{ conversationId: 3, cursor: 20 }];
  let result = await reconcile(empty(), { confirmed: [], cursors }, deps({ 3: 25 }, time));
  time.advance(61_000);
  result = await reconcile(result.state, { confirmed: [], cursors }, deps({ 3: 25 }, time));
  assert.equal(result.lagging.length, 1);

  time.advance(61_000);
  result = await reconcile(result.state, { confirmed: [], cursors: [{ conversationId: 3, cursor: 25 }] }, deps({ 3: 25 }, time));
  assert.deepEqual(result.lagging, []);
  assert.equal(result.recovered, 1);
});

test("a poster that cannot be asked is not a divergence", async () => {
  const time = clock();
  // The legacy path may refuse to answer (an older conversation, a name it does not
  // know). Not knowing must never be reported as "not posted", or the check cries
  // wolf on every thread it cannot see.
  const result = await reconcile(
    empty(),
    { confirmed: [{ conversationId: 4, entryId: 9 }], cursors: [] },
    {
      lastPosted: async () => {
        throw new Error("no such name");
      },
      graceMs: 60_000,
      now: time.now,
    },
  );
  assert.deepEqual(result.unposted, []);
});
