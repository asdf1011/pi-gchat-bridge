/**
 * Projection tests: the Chat-facing reading of a pi-durable view.
 *
 * The view values here are hand-written on purpose. They are the contract with
 * pi-durable that the bridge cannot compile-check (the shape arrives as JSON at
 * runtime), so a change in `pi.live` or entry shapes should fail here rather than
 * as an empty reply in Chat.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  activeTool,
  messageText,
  projectView,
  toolCallsOf,
  type EntryLike,
} from "../src/session-host/projection.js";

const assistant = (text: string, toolCalls: { id: string; name: string; arguments: unknown }[] = []): EntryLike => ({
  kind: "pi.assistant",
  model: [
    {
      role: "assistant",
      content: [
        ...(text ? [{ type: "text", text }] : []),
        ...toolCalls.map((call) => ({ type: "toolCall", ...call })),
      ],
    },
  ],
});

const user = (text: string): EntryLike => ({
  kind: "pi.user",
  model: [{ role: "user", content: [{ type: "text", text }] }],
});

test("messageText joins text blocks and ignores tool calls and thinking", () => {
  assert.equal(messageText(assistant("hello ").model?.[0]), "hello ");
  assert.equal(
    messageText({
      content: [
        { type: "thinking", text: "hidden" },
        { type: "text", text: "a" },
        { type: "toolCall", id: "c1", name: "bash" },
        { type: "text", text: "b" },
      ],
    }),
    "ab",
  );
  assert.equal(messageText(undefined), "");
});

test("toolCallsOf indexes calls by id for the status line", () => {
  const calls = toolCallsOf(
    assistant("", [
      { id: "c1", name: "bash", arguments: { command: "ls" } },
      { id: "c2", name: "read", arguments: { path: "x" } },
    ]).model?.[0],
  );
  assert.deepEqual([...calls.keys()], ["c1", "c2"]);
  assert.deepEqual(calls.get("c1"), { name: "bash", arguments: { command: "ls" } });
});

test("projectView reads the in-flight answer from pi.live.generation.message", () => {
  const projected = projectView({
    entries: [user("hi")],
    docs: { "pi.live": { run: { taskId: 1 }, generation: { message: assistant("partial answ").model?.[0] } } },
  });
  assert.equal(projected.liveText, "partial answ");
  assert.equal(projected.busy, true);
  assert.equal(projected.lastAssistantText, "");
});

test("projectView treats a conversation with no run as idle", () => {
  const projected = projectView({ entries: [user("hi"), assistant("done")], docs: {} });
  assert.equal(projected.busy, false);
  assert.equal(projected.liveText, "");
  assert.equal(projected.lastAssistantText, "done");
});

test("projectView joins tool arguments from the newest tool-calling entry", () => {
  const projected = projectView({
    entries: [
      user("list files"),
      assistant("", [{ id: "c1", name: "bash", arguments: { command: "ls -la" } }]),
    ],
    docs: {
      "pi.live": {
        run: { taskId: 1 },
        tools: [
          { callId: "c1", name: "bash", status: "running", output: "total 0\n" },
          { callId: "c2", name: "read", status: "pending" },
        ],
      },
    },
  });
  assert.deepEqual(projected.tools, [
    { callId: "c1", name: "bash", status: "running", output: "total 0\n", arguments: { command: "ls -la" } },
    { callId: "c2", name: "read", status: "pending" },
  ]);
});

test("projectView survives a view with no docs or entries at all", () => {
  assert.deepEqual(projectView(undefined), {
    liveText: "",
    tools: [],
    busy: false,
    lastAssistantText: "",
  });
});

test("activeTool prefers the newest unfinished tool, including pending ones", () => {
  const tools = [
    { callId: "c1", name: "bash", status: "done" as const },
    { callId: "c2", name: "read", status: "pending" as const },
  ];
  assert.equal(activeTool(tools)?.callId, "c2");
  assert.equal(activeTool([]), undefined);
  assert.equal(activeTool([{ callId: "c1", name: "bash", status: "done" }]), undefined);
});
