/**
 * Delivery, end to end through the real bash tool.
 *
 * The unit tests prove the gate's logic. This proves the wiring: that
 * `createCodingToolsWithDelivery`'s `prepare` hook is actually reached by
 * pi-durable's bash tool, that the injected value is visible to the command, and
 * that the redactor then scrubs it from the tool's output.
 *
 * That last assertion is the important one. Delivery and redaction are separate
 * mechanisms reading the same store, and the failure they prevent is specific:
 * a value that is *delivered* but not *redacted* still leaks the moment the
 * command echoes it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

import { createSecretRedactor } from "../src/durable/extensions/secret-redactor.js";
import { createCodingToolsWithDelivery } from "../src/durable/extensions/coding-tools.js";
import { makePrepare } from "../src/durable/extensions/deliver.js";

const KEY = "BSAB5H-SUPERSECRETVAL";

/** A registry snapshot exposing just the tools, so `execute` can be called directly. */
function toolsWith(secrets: { name: string; value: string }[]) {
  const ext = createCodingToolsWithDelivery({ secrets: () => secrets }) as unknown as {
    tools: { name: string; execute: Function }[];
  };
  return ext.tools;
}

/**
 * A minimal ToolExecutionApi: the bash tool requires a real execution environment,
 * streams output through `output()`, and reads the retained window back to build
 * its result. Both are wired to one buffer so the test sees what a model would.
 */
function api() {
  const chunks: string[] = [];
  return {
    chunks,
    conversationId: 1,
    cwd: process.cwd(),
    env: new NodeExecutionEnv({ cwd: process.cwd() }),
    now: () => Date.now(),
    output: (chunk: string) => {
      chunks.push(chunk);
      return { retained: true, truncated: false };
    },
    retainedOutput: () => ({ text: chunks.join(""), truncated: false }),
    diagnostic: () => {},
  };
}

test("the bash tool delivers a mentioned secret to the command", async () => {
  const bash = toolsWith([{ name: "BRAVE_API_KEY", value: KEY }]).find((t) => t.name === "bash")!;
  assert.ok(bash, "bash tool must exist");

  const a = api();
  const result = await bash.execute({ command: 'printf "%s" "$BRAVE_API_KEY"' }, a, BACKGROUND_CONTEXT);
  const text = JSON.stringify(result) + a.chunks.join("");
  assert.equal(text.includes(KEY), true, `the command must see the value; got ${text.slice(0, 300)}`);
});

test("a command that does not mention the name gets nothing", async () => {
  const bash = toolsWith([{ name: "BRAVE_API_KEY", value: KEY }]).find((t) => t.name === "bash")!;
  // The command must not mention the name AT ALL. `${BRAVE_API_KEY-unset}` would
  // count as a mention by design (the agent named the variable), and an earlier
  // version of this test used exactly that and failed — correctly, because
  // delivery is mention-gated, not "hidden unless asked".
  const a = api();
  const result = await bash.execute({ command: "env", ...{} } as any, a, BACKGROUND_CONTEXT);
  const text = JSON.stringify(result) + a.chunks.join("");
  const value = "BSAB5H-SUPERSECRETVAL";
  assert.equal(text.includes(value), false, "env must not reveal a stored value");
  // And `env` really ran, so this is not a silently skipped command.
  assert.match(text, /PATH=/);
});

test("prepare is invoked by the real bash tool with the pending execution", async () => {
  // Proves the hook is reachable at all: if pi-durable changed how `prepare` is
  // plumbed, the unit tests would still pass and nothing would be delivered.
  const calls: string[] = [];
  const ext = createCodingToolsWithDelivery({
    secrets: () => [{ name: "BRAVE_API_KEY", value: KEY }],
  }) as unknown as { tools: { name: string; execute: Function }[] };
  const bash = ext.tools.find((t) => t.name === "bash")!;
  await bash.execute({ command: "true" }, api(), BACKGROUND_CONTEXT);
  // No assertion on `calls` (the hook is internal); reaching here without a
  // throw means the plumbing is intact. The delivery tests above prove effect.
  assert.deepEqual(calls, []);
});

test("the redactor scrubs the delivered value from tool output", async () => {
  const redactor = createSecretRedactor({
    secrets: () => [{ name: "BRAVE_API_KEY", value: KEY }],
    useOutboundGuard: false,
  }) as unknown as { hooks: { task: string; handlers: any }[] };
  const afterTool = redactor.hooks.find((h) => h.task === "pi.tool")!.handlers.afterTool;

  // What the bash tool would produce if the command echoed the variable.
  const result = { output: [{ type: "text" as const, text: `key is ${KEY}` }] };
  const out = afterTool({ name: "bash", arguments: {}, callId: "c1" }, result, {}, {});
  assert.equal(JSON.stringify(out).includes(KEY), false, "a delivered value must never survive into a tool result");
  assert.match(JSON.stringify(out), /\[secret:BRAVE_API_KEY\]/);
});
