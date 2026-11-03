import test from "node:test";
import assert from "node:assert/strict";

import {
  marker,
  MIN_SECRET_LENGTH,
  redactContent,
  redactMessages,
  redactToolOutput,
  SecretRegistry,
  variantsOf,
} from "../src/durable/extensions/redact.js";

const KEY = "sk-live-abc123456789";
const reg = new SecretRegistry([{ name: "STRIPE_KEY", value: KEY }]);

test("replaces the literal value with a name marker", () => {
  assert.equal(reg.redact(`token is ${KEY} ok`), "token is [secret:STRIPE_KEY] ok");
});

test("the marker carries the name, never the value", () => {
  const out = reg.redact(KEY);
  assert.equal(out, marker("STRIPE_KEY"));
  assert.equal(out.includes("sk-live"), false);
});

test("redacts more than one occurrence", () => {
  assert.equal(reg.redact(`${KEY} and ${KEY}`), "[secret:STRIPE_KEY] and [secret:STRIPE_KEY]");
});

test("leaves text with no secret untouched and identical", () => {
  const text = "nothing to see here";
  assert.equal(reg.redact(text), text);
});

test("matches() reports presence without exposing the value", () => {
  assert.equal(reg.matches(`x ${KEY}`), true);
  assert.equal(reg.matches("x"), false);
});

test("values shorter than the minimum are not registered", () => {
  const short = new SecretRegistry([{ name: "PIN", value: "1".repeat(MIN_SECRET_LENGTH - 1) }]);
  assert.equal(short.size, 0);
  assert.equal(short.redact("123"), "123");
});

test("a value at the minimum length is registered", () => {
  const at = new SecretRegistry([{ name: "PIN", value: "1".repeat(MIN_SECRET_LENGTH) }]);
  assert.equal(at.size > 0, true);
});

test("variants include the raw value and at least one base64 form", () => {
  const variants = variantsOf("correct-horse-battery");
  assert.equal(variants.includes("correct-horse-battery"), true);
  assert.equal(variants.some((v) => /^[A-Za-z0-9+/_-]+=*$/.test(v) && v !== "correct-horse-battery"), true);
});

test("a longer secret containing a shorter one is replaced whole", () => {
  // Sorted longest-first: the short needle must not shred the long value.
  const overlapping = new SecretRegistry([{ name: "LONG", value: "abcdefghijkl" }]);
  // A value that is a prefix of another must not leave a tail behind.
  const out = overlapping.redact("abcdefghijkl");
  assert.equal(out, "[secret:LONG]");
});

test("two names with the same value keep exactly one marker", () => {
  const dup = new SecretRegistry([
    { name: "FIRST", value: "same-value-here" },
    { name: "SECOND", value: "same-value-here" },
  ]);
  assert.equal(dup.redact("same-value-here"), "[secret:FIRST]");
});

test("redacts a string content value", () => {
  assert.equal(redactContent(`k=${KEY}`, reg), "k=[secret:STRIPE_KEY]");
});

test("redacts text blocks and preserves the block type", () => {
  const content = [{ type: "text", text: `k=${KEY}` }];
  const out = redactContent(content, reg);
  assert.deepEqual(out, [{ type: "text", text: "k=[secret:STRIPE_KEY]" }]);
});

test("returns the same array instance when nothing matched", () => {
  const content = [{ type: "text", text: "clean" }];
  assert.equal(redactContent(content, reg), content);
});

test("does not touch image blocks", () => {
  // Base64 images look like base64 variants of arbitrary strings; redacting
  // them would corrupt the image.
  const content = [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }];
  assert.equal(redactContent(content, reg), content);
});

test("does not touch thinking blocks", () => {
  const content = [{ type: "thinking", thinking: "secret-ish text", thinkingSignature: "sig" }];
  assert.equal(redactContent(content, reg), content);
});

test("redacts every message of a history", () => {
  const messages = [
    { role: "user", content: `my key ${KEY}` },
    { role: "assistant", content: [{ type: "text", text: "noted" }] },
    { role: "toolResult", content: [{ type: "text", text: `echo ${KEY}` }] },
  ];
  const out = redactMessages(messages, reg);
  assert.equal(out[0]?.content, "my key [secret:STRIPE_KEY]");
  assert.deepEqual(out[2]?.content, [{ type: "text", text: "echo [secret:STRIPE_KEY]" }]);
});

test("a clean history is returned by identity, not copied", () => {
  // Copying on every turn would look like a change and can invalidate a
  // provider's cached prompt prefix.
  const messages = [{ role: "user", content: "clean" }];
  assert.equal(redactMessages(messages, reg), messages);
});

test("redactToolOutput handles the pi-durable output shape", () => {
  const output = [{ type: "text", text: `AKIA-ish ${KEY}` }];
  assert.deepEqual(redactToolOutput(output, reg), [{ type: "text", text: "AKIA-ish [secret:STRIPE_KEY]" }]);
});

test("an empty registry changes nothing", () => {
  const empty = new SecretRegistry([]);
  const text = `plain ${KEY}`;
  assert.equal(empty.redact(text), text);
  assert.equal(empty.matches(text), false);
});
