import test from "node:test";
import assert from "node:assert/strict";
import { splitMessage, toolStatusLine } from "../src/stream.js";

test("splitMessage keeps short text as one chunk", () => {
  assert.deepEqual(splitMessage("hello", 10), ["hello"]);
});

test("splitMessage cuts at the cap and preserves every character", () => {
  const text = "abcdefghijklmnopqrstuvwxyz"; // 26 chars
  assert.deepEqual(splitMessage(text, 10), ["abcdefghij", "klmnopqrst", "uvwxyz"]);
  assert.equal(splitMessage(text, 10).join(""), text);
});

test("splitMessage returns no chunks for an empty reply", () => {
  assert.deepEqual(splitMessage("", 10), []);
});

test("toolStatusLine prefers the command over the path", () => {
  assert.equal(toolStatusLine("bash", { command: "npm test", path: "/x" }), "_Running:_ `npm test`");
});

test("toolStatusLine falls back to the tool name when there is no command", () => {
  assert.equal(toolStatusLine("read", { path: "/tmp/a.ts" }), "_Running read:_ `/tmp/a.ts`");
});

test("toolStatusLine strips backticks so the code span can't break", () => {
  assert.equal(toolStatusLine("bash", { command: "echo `x`" }), "_Running:_ `echo x`");
});

test("splitMessage prefers a newline boundary", () => {
  const text = "aaaa\nbbbb\ncccc"; // 14 chars
  assert.deepEqual(splitMessage(text, 10), ["aaaa\nbbbb", "cccc"]);
});

test("splitMessage closes and reopens a fenced code block across the cut", () => {
  const text = ["```", "line one", "line two", "line three", "```"].join("\n");
  const chunks = splitMessage(text, 20);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    const fences = chunk.split("\n").filter((l) => l.trim() === "```").length;
    assert.equal(fences % 2, 0, `unbalanced fence in ${JSON.stringify(chunk)}`);
  }
  const codeLines = chunks.join("\n").split("\n").filter((l) => l.trim() !== "```");
  assert.deepEqual(codeLines, ["line one", "line two", "line three"]);
});
