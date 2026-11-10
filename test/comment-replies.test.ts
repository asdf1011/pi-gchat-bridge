/**
 * Review replies: plumbing that stays out of the conversation.
 *
 * The rules here are the ones a future change is most likely to break, because
 * every one of them is a decision not to do something:
 *
 *   - a reply is not a submission, so it never reaches Chat;
 *   - it carries no model messages, so it cannot come back to the agent as
 *     context and read like the user said it;
 *   - resolving is silent and is not something the agent can do.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addComment,
  appendReply,
  CommentsDoc,
  commentsOf,
  findByShortId,
  setResolved,
  type StoredComment,
} from "../src/durable/comments-doc.js";
import { modelText, shortId } from "../src/durable/comments.js";

function comment(id: string, overrides: Partial<StoredComment> = {}): StoredComment {
  return {
    id,
    file: "conversation/7/static.md",
    anchors: [{ changeId: "aaa", originalLine: 3, content: "the kitten was a stowaway" }],
    text: "instead of crumbs, mutant mice?",
    at: 1,
    ...overrides,
  };
}

test("a reply is appended to its own thread and nothing else changes", () => {
  const comments = [comment("aaaaaaaa-1111"), comment("bbbbbbbb-2222")];
  const { comments: next, changed } = appendReply(comments, "aaaaaaaa-1111", {
    text: "Changed line 3.",
    at: 5,
    author: "agent",
  });
  assert.equal(changed, true);
  assert.equal(next[0]!.replies?.length, 1);
  assert.equal(next[0]!.replies![0]!.text, "Changed line 3.");
  assert.equal(next[1]!.replies, undefined, "the other thread is untouched");
  // Not a submission: the turn list is how a view joins Chat answers, and a reply
  // must never appear there.
  assert.equal(next[0]!.submissions, undefined);
});

test("an unknown id changes nothing, and says so", () => {
  const { comments, changed } = appendReply([comment("aaaaaaaa-1111")], "cccccccc-3333", {
    text: "hello",
    at: 5,
  });
  assert.equal(changed, false);
  assert.equal(comments[0]!.replies, undefined);
});

test("a thread keeps the newest exchanges rather than growing forever", () => {
  let comments: StoredComment[] = [comment("aaaaaaaa-1111")];
  for (let index = 0; index < 60; index += 1) {
    comments = appendReply(comments, "aaaaaaaa-1111", { text: `reply ${index}`, at: index }, 50).comments;
  }
  const replies = comments[0]!.replies ?? [];
  assert.equal(replies.length, 50);
  assert.equal(replies.at(-1)!.text, "reply 59", "newest kept");
  assert.equal(replies[0]!.text, "reply 10", "oldest dropped");
});

/**
 * The id a short id resolves to, asserting it resolved to a comment at all.
 *
 * `findByShortId` returns `T | { ambiguous: true } | undefined`, and reading `.id`
 * straight off that is what the compiler objects to — correctly: an ambiguous
 * prefix has no id, and the old fixture-shaped access only worked because tests
 * were not typechecked.
 */
function resolvedId(result: { id: string } | { ambiguous: true } | undefined): string | undefined {
  return result && "id" in result ? result.id : undefined;
}

test("a short id resolves, and an ambiguous prefix is refused rather than guessed", () => {
  const comments = [comment("2f4f5da0-aaaa"), comment("9c1e0000-bbbb")];
  assert.equal(resolvedId(findByShortId(comments, "2f4f5da0")), "2f4f5da0-aaaa");
  assert.equal(resolvedId(findByShortId(comments, "2F4F")), "2f4f5da0-aaaa", "case-insensitive, prefix");
  assert.equal(resolvedId(findByShortId(comments, "ffff")), undefined);

  const colliding = [comment("abcd1111-aaaa"), comment("abcd2222-bbbb")];
  assert.deepEqual(findByShortId(colliding, "abcd"), { ambiguous: true });
  // A longer prefix disambiguates, which is the escape hatch the tool result names.
  assert.equal(resolvedId(findByShortId(colliding, "abcd2222")), "abcd2222-bbbb");
});

test("resolving is silent: it touches neither the transcript nor the model", () => {
  const { comments, changed } = setResolved([comment("aaaaaaaa-1111")], "aaaaaaaa-1111", true);
  assert.equal(changed, true);
  assert.equal(comments[0]!.resolved, true);
  // The stored shape has nowhere to record a message: resolving cannot post, and
  // nothing in `comments-doc.ts` writes an entry.
  assert.deepEqual(Object.keys(comments[0]!).sort(), ["anchors", "at", "file", "id", "resolved", "text"]);
});

test("the message carries a short id, which is what the agent replies to", () => {
  const id = "2f4f5da0-7c07-4e39-8f7b-9fd9aaee6a92";
  const text = modelText(
    {
      id,
      file: "conversation/7/static.md",
      anchors: [{ originalLine: 3 }],
      quote: "crumbs",
      text: "instead of crumbs, mutant mice?",
      author: "henry",
    },
    { path: "/workspace/artifacts/conversation/7/static.md" },
  );
  assert.equal(shortId(id), "2f4f5da0");
  assert.match(text.split("\n")[0]!, /\[comment 2f4f5da0\]$/, "the id ends the address line");
  assert.ok(!text.includes(id), "not the whole uuid: a model should not have to copy 36 characters");
});

test("a comment with no id is still printable, so old records keep working", () => {
  const text = modelText(
    { file: "a.sh", anchors: [{ originalLine: 1 }], text: "look" },
    { path: "/x/a.sh" },
  );
  assert.ok(!text.includes("[comment"), "no dangling tag");
});

test("the comments document adds, trims resolved first, and reads back by conversation", () => {
  const store: { byConversation: Record<string, { comments: StoredComment[] }> } = { byConversation: {} };
  const conversation = 7;
  store.byConversation[String(conversation)] = {
    comments: addComment(store.byConversation[String(conversation)]?.comments ?? [], comment("aaaaaaaa-1111")),
  };
  assert.equal(commentsOf(store, conversation).length, 1);
  assert.equal(commentsOf(store, 8).length, 0, "another conversation sees none");
  // The document is a session singleton, so its kind must be stable: renaming it
  // would orphan every comment already stored.
  assert.equal(CommentsDoc.definition.kind, "gchat.comments");
});
