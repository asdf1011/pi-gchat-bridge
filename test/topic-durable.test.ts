/**
 * Titles on the durable engine read the conversation view, not a session file.
 *
 * The important properties are not "a title was produced" but: it uses the
 * titler's own server, it asks for `cache_prompt: false` so a one-shot summary
 * cannot accumulate a slot, and it never writes to the conversation.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { firstTurnFromView, summarizeConversationTopic } from "../src/durable/topic.js";

const view = (entries: unknown[]) => ({ entries }) as never;
const msg = (role: string, text: string) => ({
  id: 1,
  model: [{ role, content: [{ type: "text", text }] }],
});

test("first turn takes the first user text and the first assistant reply", () => {
  const turn = firstTurnFromView(
    view([
      { id: 1, model: [{ role: "system", content: [{ type: "text", text: "ignored" }] }] },
      msg("user", "how do I shrink this disk image"),
      msg("assistant", "Use truncate, then e2fsck."),
      msg("user", "and then?"),
    ]),
  );
  assert.equal(turn.userText, "how do I shrink this disk image");
  assert.equal(turn.assistantText, "Use truncate, then e2fsck.");
});

test("a turn with no assistant reply yet only yields the user text", () => {
  const turn = firstTurnFromView(view([msg("user", "hello")]));
  assert.equal(turn.userText, "hello");
  assert.equal(turn.assistantText, "");
});

test("tool-only entries are skipped rather than counted as the first turn", () => {
  const turn = firstTurnFromView(
    view([
      { id: 1, model: [{ role: "user", content: [{ type: "tool_result", text: "x" }] }] },
      msg("user", "real question"),
      msg("assistant", "real answer"),
    ]),
  );
  assert.equal(turn.userText, "real question");
});

test("the title request goes to the titler server with caching off", async () => {
  const seen: { url: string; body: Record<string, unknown> }[] = [];
  const post = (async (url: string, body: Record<string, unknown>) => {
    seen.push({ url, body });
    return { choices: [{ message: { content: "Shrinking a disk image" } }] };
  }) as never;

  const title = await summarizeConversationTopic(
    firstTurnFromView(view([msg("user", "how do I shrink this disk image"), msg("assistant", "truncate")])),
    { baseUrl: "http://127.0.0.1:8091/v1/", model: "lfm3-vl-2b-q8", timeoutMs: 1000 },
    { post },
  );

  assert.equal(title, "Shrinking a disk image");
  assert.equal(seen[0].url, "http://127.0.0.1:8091/v1/chat/completions");
  // One-shot: never reuse, never accumulate a slot.
  assert.equal(seen[0].body.cache_prompt, false);
  assert.equal(seen[0].body.temperature, 0);
});

test("an empty conversation asks for no title at all", async () => {
  let called = false;
  const post = (async () => {
    called = true;
    return {};
  }) as never;
  const title = await summarizeConversationTopic(
    firstTurnFromView(view([])),
    { baseUrl: "http://x/v1", model: "m", timeoutMs: 10 },
    { post },
  );
  assert.equal(title, undefined);
  assert.equal(called, false);
});
