/**
 * Delivery: injecting a stored secret into a child process, and nowhere else.
 *
 * The gate being tested is "mention": only a name the command mentions as a
 * whole word is injected. That single rule is what separates a credential store
 * from an environment dump — without it, `env` or `printenv` would hand the model
 * every stored value in one tool result, and the redaction layer would faithfully
 * render them as `[secret:NAME]` while the model had already learned which
 * variables exist and could ask for each one directly.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  countMentions,
  envForCommand,
  makePrepare,
  mentions,
  selectForCommand,
  toRegistered,
  type DeliverableSecret,
} from "../src/durable/extensions/deliver.js";

const BRAVE: DeliverableSecret = { name: "BRAVE_API_KEY", value: "BSAB5H-xxx" };
const ZAI: DeliverableSecret = { name: "ZAI_API_KEY", value: "84d0b595xxx" };
const SCOPED: DeliverableSecret = { name: "STRIPE_KEY", value: "sk-live-xxx", scopes: ["7"] };

// --- The mention gate --------------------------------------------------------

test("a $NAME reference counts as a mention", () => {
  assert.equal(mentions('curl -H "Authorization: Bearer $BRAVE_API_KEY"', "BRAVE_API_KEY"), true);
});

test("a bare NAME counts as a mention", () => {
  assert.equal(mentions("printenv BRAVE_API_KEY", "BRAVE_API_KEY"), true);
});

test("a name as a substring of a longer identifier is not a mention", () => {
  // The dangerous false positive: injecting because the *prefix* matched.
  assert.equal(mentions("echo $BRAVE_API_KEY_OLD", "BRAVE_API_KEY"), false);
  assert.equal(mentions("echo $MY_BRAVE_API_KEY", "BRAVE_API_KEY"), false);
});

test("a name in a path or filename is a mention, because the command named it", () => {
  // Not a value leak: the file is named, so mentioning it is the operator's
  // intent being followed. Documented rather than blocked.
  assert.equal(mentions("cat /tmp/BRAVE_API_KEY.txt", "BRAVE_API_KEY"), true);
});

test("an empty name never matches", () => {
  assert.equal(mentions("anything", ""), false);
});

test("regex metacharacters in a name are escaped", () => {
  // Names are validated elsewhere, but a store edited by hand must not be able
  // to turn this into a wildcard.
  assert.equal(mentions("echo aXb", "a.b"), false);
  assert.equal(mentions("echo a.b", "a.b"), true);
});

// --- Selection ---------------------------------------------------------------

test("only mentioned secrets are delivered", () => {
  const selected = selectForCommand('curl -H "X-Key: $BRAVE_API_KEY"', [BRAVE, ZAI], 7);
  assert.deepEqual(
    selected.map((s) => s.name),
    ["BRAVE_API_KEY"],
  );
});

test("env and printenv deliver nothing", () => {
  // The whole point of the gate. If this test ever fails, the store is an
  // environment dump.
  for (const command of ["env", "printenv", "export -p", "set"]) {
    assert.deepEqual(envForCommand(command, [BRAVE, ZAI], 7), {}, command);
  }
});

test("a command mentioning two secrets gets both", () => {
  const env = envForCommand("echo $BRAVE_API_KEY $ZAI_API_KEY", [BRAVE, ZAI], 7);
  assert.deepEqual(env, { BRAVE_API_KEY: "BSAB5H-xxx", ZAI_API_KEY: "84d0b595xxx" });
});

test("an unscoped secret is delivered in any conversation", () => {
  assert.deepEqual(envForCommand("echo $BRAVE_API_KEY", [BRAVE], 99), {
    BRAVE_API_KEY: "BSAB5H-xxx",
  });
});

test("a scoped secret is delivered only in its conversation", () => {
  assert.deepEqual(envForCommand("echo $STRIPE_KEY", [SCOPED], 7), { STRIPE_KEY: "sk-live-xxx" });
  assert.deepEqual(envForCommand("echo $STRIPE_KEY", [SCOPED], 8), {});
});

test("a scoped secret is not delivered when there is no conversation context", () => {
  // Fail closed: unknown context cannot satisfy a scope.
  assert.deepEqual(envForCommand("echo $STRIPE_KEY", [SCOPED], undefined), {});
});

test("scope matching is by conversation id, as a string", () => {
  assert.deepEqual(envForCommand("echo $STRIPE_KEY", [SCOPED], "7"), { STRIPE_KEY: "sk-live-xxx" });
});

test("an empty store delivers nothing", () => {
  assert.deepEqual(envForCommand("echo $BRAVE_API_KEY", [], 7), {});
});

// --- The prepare hook --------------------------------------------------------

test("prepare merges into the existing environment rather than replacing it", () => {
  // The bash tool builds PATH and the PI_* session variables; clobbering
  // execution.env would break every command.
  const prepare = makePrepare({ secrets: () => [BRAVE] });
  const execution = { command: "echo $BRAVE_API_KEY $PATH", env: { PATH: "/usr/bin" } };
  prepare(execution, { conversationId: 7 });
  assert.deepEqual(execution.env, { PATH: "/usr/bin", BRAVE_API_KEY: "BSAB5H-xxx" });
});

test("prepare does nothing for a command with no mentions", () => {
  const prepare = makePrepare({ secrets: () => [BRAVE] });
  const execution = { command: "ls", env: {} };
  prepare(execution, { conversationId: 7 });
  assert.deepEqual(execution.env, {});
});

test("prepare reads the store per call, so a new capture applies immediately", () => {
  let secrets: DeliverableSecret[] = [];
  const prepare = makePrepare({ secrets: () => secrets });
  const first = { command: "echo $BRAVE_API_KEY", env: {} };
  prepare(first, { conversationId: 7 });
  assert.deepEqual(first.env, {});

  // A secret captured mid-session: no restart, no hook rebuild.
  secrets = [BRAVE];
  const second = { command: "echo $BRAVE_API_KEY", env: {} };
  prepare(second, { conversationId: 7 });
  assert.deepEqual(second.env, { BRAVE_API_KEY: "BSAB5H-xxx" });
});

test("prepare tolerates a missing api argument", () => {
  const prepare = makePrepare({ secrets: () => [BRAVE] });
  const execution = { command: "echo $BRAVE_API_KEY", env: {} };
  prepare(execution);
  // Unscoped secrets still apply; only scoped ones need the id.
  assert.deepEqual(execution.env, { BRAVE_API_KEY: "BSAB5H-xxx" });
});

test("countMentions reports how many names a command touched", () => {
  assert.equal(countMentions("echo $A $B", [
    { name: "A", value: "1" },
    { name: "B", value: "2" },
    { name: "C", value: "3" },
  ]), 2);
});

test("toRegistered produces the redaction shape from the same source", () => {
  // One read feeds both consumers, so they cannot disagree about which values
  // exist — a value that is delivered but not redacted would leak on echo.
  assert.deepEqual(toRegistered([BRAVE]), [{ name: "BRAVE_API_KEY", value: "BSAB5H-xxx" }]);
});

// --- File-backed secrets deliver the same way ---------------------------------

test("a file-backed secret is delivered by mention, like a value-backed one", () => {
  // Delivery does not care where the bytes came from: `prepare` receives an
  // already-resolved value. This asserts the seam holds for the PEM/JSON case,
  // which is the whole reason the file form exists.
  const pem = "-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----\n";
  const env = envForCommand("curl --cert $PEM_KEY", [{ name: "PEM_KEY", value: pem }], 7);
  assert.equal(env.PEM_KEY, pem);
});
