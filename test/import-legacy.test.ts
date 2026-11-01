/**
 * Legacy-import tests: the one-shot migration of a thread's history.
 *
 * Worth pinning because it runs exactly once, at cutover, against files nobody
 * wants to re-derive by hand: a parser that silently drops every assistant
 * message would produce an empty handoff and no error.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildHandoff, readLegacyMessages } from "../src/durable/import-legacy.js";

function writeSession(lines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "import-"));
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, lines.join("\n"));
  return file;
}

const header = JSON.stringify({ type: "session", version: 3, cwd: "/workspace" });

test("reads the user and assistant messages of a legacy session, oldest first", () => {
  const file = writeSession([
    header,
    JSON.stringify({ type: "model_change", provider: "deepseek", modelId: "flash" }),
    JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }),
    JSON.stringify({
      type: "message",
      message: { role: "assistant", content: [{ type: "thinking", text: "hidden" }, { type: "text", text: "hi there" }] },
    }),
  ]);
  assert.deepEqual(readLegacyMessages(file), [
    { role: "user", text: "hello" },
    { role: "assistant", text: "hi there" },
  ]);
});

test("skips tool results, non-message entries and a truncated final line", () => {
  const file = writeSession([
    header,
    JSON.stringify({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "output" }] } }),
    JSON.stringify({ type: "message", message: { role: "user", content: "real question" } }),
    '{"type":"message","message":{"role":"assistant","content":[{"type":"te',
  ]);
  assert.deepEqual(readLegacyMessages(file), [{ role: "user", text: "real question" }]);
});

test("a handoff keeps the tail and says how much it dropped", () => {
  const messages = Array.from({ length: 20 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    text: `message ${index}`,
  }));
  const handoff = buildHandoff(messages, { tail: 4, perMessageChars: 1_000 });
  assert.match(handoff, /16 messages\) is not included/);
  assert.match(handoff, /message 19/);
  assert.doesNotMatch(handoff, /message 15/, "the tail starts after the kept window");
});

test("a short conversation claims nothing was dropped", () => {
  const handoff = buildHandoff([{ role: "user", text: "only one" }], { tail: 12, perMessageChars: 1_000 });
  assert.doesNotMatch(handoff, /not included/);
  assert.match(handoff, /\*\*User:\*\* only one/);
});

test("long messages are truncated per message, not dropped", () => {
  const long = "x".repeat(3_000);
  const handoff = buildHandoff([{ role: "assistant", text: long }], { tail: 1, perMessageChars: 100 });
  assert.match(handoff, /\*\*Assistant:\*\* x{100}…/);
  assert.ok(!handoff.includes("x".repeat(200)), "the middle of the message is elided");
});

test("blank messages are ignored so a handoff is not mostly whitespace", () => {
  const handoff = buildHandoff(
    [
      { role: "user", text: "first" },
      { role: "assistant", text: "   " },
      { role: "user", text: "second" },
    ],
    { tail: 12, perMessageChars: 1_000 },
  );
  assert.match(handoff, /first/);
  assert.match(handoff, /second/);
  assert.doesNotMatch(handoff, /\*\*Assistant:\*\* {3}/);
});
