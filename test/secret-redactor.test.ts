import test from "node:test";
import assert from "node:assert/strict";

import { SecretRegistry } from "../src/durable/extensions/redact.js";
import {
  createSecretRedactor,
  protectMessages,
  resetOutboundGuardForTests,
  secretsFromEnvironment,
} from "../src/durable/extensions/secret-redactor.js";

// --- Environment capture -----------------------------------------------------

test("reads values named by PI_SECRETS_NAMES", () => {
  const secrets = secretsFromEnvironment({
    PI_SECRETS_NAMES: "DEMO_KEY",
    DEMO_KEY: "abcdefgh",
  });
  assert.deepEqual(secrets, [{ name: "DEMO_KEY", value: "abcdefgh" }]);
});

test("ignores whitespace and empty entries in the name list", () => {
  const secrets = secretsFromEnvironment({
    PI_SECRETS_NAMES: " A , ,B, ",
    A: "aaaaaaaa",
    B: "bbbbbbbb",
  });
  assert.deepEqual(
    secrets.map((s) => s.name),
    ["A", "B"],
  );
});

test("a listed name with no value is skipped, not registered empty", () => {
  assert.deepEqual(secretsFromEnvironment({ PI_SECRETS_NAMES: "MISSING" }), []);
});

test("too-short values are skipped", () => {
  assert.deepEqual(secretsFromEnvironment({ PI_SECRETS_NAMES: "PIN", PIN: "123" }), []);
});

test("PI_SECRETS_VALUES_JSON supplies values for non-env-var names", () => {
  const secrets = secretsFromEnvironment({
    PI_SECRETS_VALUES_JSON: JSON.stringify({ "stripe/key": "abcdefgh", other: 42 }),
  });
  // Non-string values are ignored rather than coerced.
  assert.deepEqual(secrets, [{ name: "stripe/key", value: "abcdefgh" }]);
});

test("a name present both ways is registered once, env winning", () => {
  const secrets = secretsFromEnvironment({
    PI_SECRETS_NAMES: "DUPE",
    DUPE: "from-env",
    PI_SECRETS_VALUES_JSON: JSON.stringify({ DUPE: "from-json" }),
  });
  assert.deepEqual(secrets, [{ name: "DUPE", value: "from-env" }]);
});

test("malformed JSON still keeps the names that redact via the environment", () => {
  const secrets = secretsFromEnvironment({ PI_SECRETS_NAMES: "OK", OK: "abcdefgh", PI_SECRETS_VALUES_JSON: "{" });
  assert.deepEqual(secrets, [{ name: "OK", value: "abcdefgh" }]);
});

test("no environment at all yields no secrets", () => {
  assert.deepEqual(secretsFromEnvironment({}), []);
});

// --- protectMessages: the fail-closed contract -------------------------------

const KEY = "sk-live-abc123456789";
const registry = new SecretRegistry([{ name: "STRIPE_KEY", value: KEY }]);

test("redacts before the optional guard runs", async () => {
  let seenByGuard: unknown;
  const guard = async (messages: readonly any[]) => {
    seenByGuard = messages[0]?.content;
    return messages;
  };
  const out = await protectMessages([{ role: "user", content: `k=${KEY}` }], registry, guard);
  assert.equal(out[0]?.content, "k=[secret:STRIPE_KEY]");
  // The guard must never receive the real value.
  assert.equal(seenByGuard, "k=[secret:STRIPE_KEY]");
});

test("works with no guard installed", async () => {
  const out = await protectMessages([{ role: "user", content: KEY }], registry, null);
  assert.equal(out[0]?.content, "[secret:STRIPE_KEY]");
});

test("a throwing guard propagates, so the request is not sent clean", async () => {
  // prjct.app's contract: "throws if an indexed credential cannot be read, so
  // the caller must not retry with the unprotected data". Swallowing this would
  // send the unredacted prompt, which is the one unrecoverable outcome.
  const guard = async () => {
    throw new Error("keychain unavailable");
  };
  await assert.rejects(
    () => protectMessages([{ role: "user", content: "clean text" }], registry, guard),
    /keychain unavailable/,
  );
});

test("the thrown error does not carry the secret", async () => {
  const guard = async () => {
    throw new Error("boom");
  };
  try {
    await protectMessages([{ role: "user", content: KEY }], registry, guard);
    assert.fail("expected a rejection");
  } catch (error) {
    assert.equal(String((error as Error).message).includes(KEY), false);
  }
});

// --- Extension wiring --------------------------------------------------------

/**
 * Pull the two hooks out of the extension the way pi-durable's registry will.
 *
 * The real shape (verified against pi-durable 1.4.0) is
 * `{ name, hooks: [{ task: "pi.generation", handlers: { beforeRequest } }] }` —
 * the task is a registry key, not the task object, so match on that string.
 */
function handlersOf(extension: any) {
  const hooks: any[] = extension.hooks ?? [];
  return {
    hooks,
    generation: hooks.find((h) => h.task === "pi.generation")?.handlers,
    tool: hooks.find((h) => h.task === "pi.tool")?.handlers,
  };
}

test("registers generation and tool hooks", () => {
  const { hooks } = handlersOf(createSecretRedactor({ registry, useOutboundGuard: false }));
  assert.equal(hooks.length, 2);
});

test("beforeRequest returns undefined when nothing matched, preserving the cache", async () => {
  const { generation } = handlersOf(createSecretRedactor({ registry, useOutboundGuard: false }));
  const handler = generation.beforeRequest;
  const request = { messages: [{ role: "user", content: "clean" }] };
  assert.equal(await handler(request, fakeApi(), fakeContext()), undefined);
});

test("beforeRequest returns replacement messages when a secret is present", async () => {
  const { generation } = handlersOf(createSecretRedactor({ registry, useOutboundGuard: false }));
  const handler = generation.beforeRequest;
  const out = await handler({ messages: [{ role: "user", content: KEY }] }, fakeApi(), fakeContext());
  assert.equal(out?.messages[0]?.content, "[secret:STRIPE_KEY]");
});

test("afterTool redacts the model-facing output", () => {
  const { tool } = handlersOf(createSecretRedactor({ registry, useOutboundGuard: false }));
  const handler = tool.afterTool;
  const result = { output: [{ type: "text", text: `echo ${KEY}` }] };
  const out = handler({ name: "bash", arguments: {} }, result, fakeApi(), fakeContext());
  assert.deepEqual(out?.output, [{ type: "text", text: "echo [secret:STRIPE_KEY]" }]);
});

test("afterTool returns undefined for a clean result", () => {
  const { tool } = handlersOf(createSecretRedactor({ registry, useOutboundGuard: false }));
  const handler = tool.afterTool;
  const result = { output: [{ type: "text", text: "clean" }] };
  assert.equal(handler({ name: "bash", arguments: {} }, result, fakeApi(), fakeContext()), undefined);
});

test("afterTool leaves a result with no output alone", () => {
  const { tool } = handlersOf(createSecretRedactor({ registry, useOutboundGuard: false }));
  const handler = tool.afterTool;
  assert.equal(handler({ name: "bash", arguments: {} }, {}, fakeApi(), fakeContext()), undefined);
});

test("without the optional package the guard resolves to null, not an error", async () => {
  resetOutboundGuardForTests();
  const extension = createSecretRedactor({ registry });
  const { generation } = handlersOf(extension);
  const handler = generation.beforeRequest;
  // No @prjct.app/pi-secrets in this project: the request still goes through,
  // redacted by the built-in registry only.
  const out = await handler({ messages: [{ role: "user", content: KEY }] }, fakeApi(), fakeContext());
  assert.equal(out.messages[0].content, "[secret:STRIPE_KEY]");
});

function fakeApi(): any {
  return { taskId: 1, conversationId: 1, models: {}, memo: async () => undefined };
}

function fakeContext(): any {
  return {};
}
