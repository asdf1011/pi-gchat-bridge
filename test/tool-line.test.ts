/**
 * The tool status sentence, which two surfaces show.
 *
 * It existed twice: Chat's Markdown version capped at 140 characters and stripped backticks, the web
 * pane's plain version capped at 90 and did not. The drift was already visible in the numbers and
 * would eventually have shown in *what* each one chose to display.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { toolSummary } from "../src/shared/tool-line.js";
import { toolStatusLine } from "../src/stream.js";

test("the command wins over the path, and a tool with neither is named", () => {
  assert.deepEqual(toolSummary("bash", { command: "npm test", path: "/x" }), {
    label: "Running",
    detail: "npm test",
  });
  assert.deepEqual(toolSummary("read", { path: "/tmp/a.ts" }), { label: "Running read", detail: "/tmp/a.ts" });
  assert.deepEqual(toolSummary("todo_write", {}), { label: "Running todo_write", detail: "" });
});

test("backticks are stripped once, in the shared part, so no renderer has to remember", () => {
  // Chat wraps the detail in a code span: a stray backtick closes it early and turns the rest of the
  // message into garbage, which is why this cannot live in the renderer.
  assert.equal(toolSummary("bash", { command: "echo `x`" }).detail, "echo x");
});

test("a long command is capped, and whitespace is collapsed", () => {
  const long = "rg   -n   " + "x".repeat(400);
  const { detail } = toolSummary("bash", { command: long });
  assert.equal(detail.length, 120);
  assert.ok(!detail.includes("  "), "newlines and runs of spaces become one space");
});

test("the Chat rendering wraps the shared sentence in markdown", () => {
  assert.equal(toolStatusLine("bash", { command: "npm test" }), "_Running:_ `npm test`");
  assert.equal(toolStatusLine("read", { path: "/tmp/a.ts" }), "_Running read:_ `/tmp/a.ts`");
  assert.equal(toolStatusLine("todo_write", {}), "_Running todo_write_…");
});
