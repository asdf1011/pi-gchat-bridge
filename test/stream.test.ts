import test from "node:test";
import assert from "node:assert/strict";
import { ReplyStream, splitMessage, toolStatusLine } from "../src/stream.js";

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

test("a patch in flight lands before the placeholder is deleted", async () => {
  // The chronic log line this is for: `PATCH … 403 "permission denied, or the resource doesn't
  // exist"`, about once a day. Neither was true — the placeholder had been deleted a moment earlier
  // by `finish()`, and a patch that was already in flight arrived afterwards.
  const calls: string[] = [];
  const patch = Promise.withResolvers<void>();
  const client = {
    sendMessage: async (_space: string, text: string) => {
      calls.push(`post:${text}`);
    },
    createMessage: async () => "messages/marker",
    updateMessage: async (_name: string, _text: string) => {
      calls.push("patch:start");
      await patch.promise;
      calls.push("patch:end");
      return true;
    },
    deleteMessage: async () => {
      calls.push("delete");
    },
  } as unknown as ConstructorParameters<typeof ReplyStream>[0];

  const stream = new ReplyStream(client, "spaces/S", undefined, "tester", { replaceOnFinish: true });
  // The placeholder is opened by `register()`'s timer (`MARKER_DELAY_MS`) and a patch without one is
  // a no-op — which is why the first three versions of this test saw no patch at all.
  stream.register("thread-1");
  await new Promise((resolve) => setTimeout(resolve, 3200));
  stream.onSnapshot("half an answer");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(calls.includes("patch:start"), calls.join(","));

  const finishing = stream.finish("the whole answer");
  assert.ok(!calls.includes("delete"), "the message is not deleted while a patch is in flight");

  patch.resolve();
  await finishing;
  const patchEnd = calls.indexOf("patch:end");
  const deleted = calls.indexOf("delete");
  assert.ok(patchEnd !== -1 && deleted > patchEnd, `patch landed first: ${calls.join(",")}`);
});
