/**
 * Chat keys, and the one place they are taken apart.
 *
 * A key is the address a conversation lives at, and it has three shapes that must not be
 * confused: a bare space, a thread inside a space, and a thread the app opened by a key it
 * chose. Parsing lives beside formatting so the two cannot drift — an address that means
 * two things to two modules is how a message lands in the wrong thread.
 *
 * The quoting test lives here too because it is the other half of the same address: what a
 * prompt from another surface looks like once Chat has to carry it.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { chatTarget, keyFor } from "../src/session-key.js";
import { quotePrompt } from "../src/durable/painter.js";

test("the three key shapes are told apart", () => {
  assert.deepEqual(chatTarget("spaces/S"), { space: "spaces/S" });
  assert.deepEqual(chatTarget("spaces/S/threads/T"), { space: "spaces/S", threadName: "spaces/S/threads/T" });
  // "threads" must not be read as a thread *key*: order matters in the parser.
  assert.deepEqual(chatTarget("spaces/S/cron-invites"), { space: "spaces/S", threadKey: "cron-invites" });
});

test("anything that is not a Chat key has no target", () => {
  assert.equal(chatTarget(undefined), undefined);
  assert.equal(chatTarget(""), undefined);
  assert.equal(chatTarget("webui/local-1"), undefined);
});

test("a key and its parse agree, for every shape keyFor produces", () => {
  // The pair is what matters: `keyFor` writes what `chatTarget` reads, and a change to
  // either alone would post into the space instead of the thread.
  assert.deepEqual(chatTarget(keyFor("spaces/S", "spaces/S/threads/T")), {
    space: "spaces/S",
    threadName: "spaces/S/threads/T",
  });
  assert.deepEqual(chatTarget(keyFor("spaces/S", undefined, "cron-invites")), {
    space: "spaces/S",
    threadKey: "cron-invites",
  });
  assert.deepEqual(chatTarget(keyFor("spaces/S")), { space: "spaces/S" });
});

test("a prompt is quoted line by line, so a paragraph break cannot end the quote", () => {
  assert.equal(quotePrompt("one"), "> one");
  assert.equal(quotePrompt("one\n\ntwo"), "> one\n>\n> two");
  assert.equal(quotePrompt("  "), "");
});
