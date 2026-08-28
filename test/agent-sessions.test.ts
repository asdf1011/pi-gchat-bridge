import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  AgentRouter,
  contentText,
  readSessionEntries,
  truncate,
} from "../src/agent-sessions.js";

test("keyFor prefers an app-chosen threadKey", () => {
  assert.equal(AgentRouter.keyFor("spaces/s", "spaces/s/threads/t", "conv-1"), "spaces/s/conv-1");
});

test("keyFor falls back to the thread name when no threadKey", () => {
  assert.equal(AgentRouter.keyFor("spaces/s", "spaces/s/threads/t"), "spaces/s/threads/t");
});

test("keyFor falls back to the space for a non-threaded DM", () => {
  assert.equal(AgentRouter.keyFor("spaces/s"), "spaces/s");
});

test("contentText reads a string directly", () => {
  assert.equal(contentText("hello"), "hello");
});

test("contentText concatens text blocks", () => {
  assert.equal(contentText([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "ab");
});

test("contentText ignores non-text blocks", () => {
  assert.equal(contentText([{ type: "image" }, { type: "text", text: "x" }]), "x");
});

test("truncate collapses whitespace and trims", () => {
  assert.equal(truncate("  a   b  "), "a b");
});

test("truncate clips long strings to the max length", () => {
  assert.equal(truncate("x".repeat(20), 10), "xxxxxxxxx…");
});

test("readSessionEntries skips unparsable lines and returns parsed entries", async () => {
  const tmp = `/tmp/pi-gchat-session-${Date.now()}.jsonl`;
  fs.writeFileSync(tmp, "not json\n{\"type\":\"message\"}\n\n{\"type\":\"model_change\"}\n");
  const got: unknown[] = [];
  await readSessionEntries(tmp, (entry) => {
    got.push(entry);
    return false;
  });
  assert.deepEqual(got, [{ type: "message" }, { type: "model_change" }]);
  fs.rmSync(tmp);
});

test("readSessionEntries stops early when the callback returns true", async () => {
  const tmp = `/tmp/pi-gchat-session-${Date.now()}.jsonl`;
  fs.writeFileSync(tmp, "{\"type\":\"a\"}\n{\"type\":\"b\"}\n");
  const got: unknown[] = [];
  await readSessionEntries(tmp, (entry) => {
    got.push(entry);
    return true;
  });
  assert.deepEqual(got, [{ type: "a" }]);
  fs.rmSync(tmp);
});
