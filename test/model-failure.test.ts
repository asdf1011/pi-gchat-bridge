/**
 * Model failures must be classified into something the bridge can act on.
 *
 * These exist because of a real outage: DeepSeek ran out of credit, every turn
 * settled `unanswered` with `reason=model_error` and a 402 in `detail`, and the
 * bridge — and `/healthz` — reported itself perfectly healthy the whole time.
 * The only trace was a log line, and the notice told the user to "send it again",
 * which could never work. The cases below are the distinctions that fix it:
 * retrying a balance problem is futile, retrying a throttle is correct.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { classifyModelFailure, describeModelFailure } from "../src/durable/model-failure.js";

/** The detail the durable engine actually produced for the real 402. */
const REAL_402 =
  '402: {"message":"Insufficient Balance (request_id: 6420546f-2c8f-430b-80ae-b087e21bda7f)","type":"insufficient_balance_error","param":null,"code":"invalid_request_error"}';

test("the real 402 is a balance failure, not a transient one", () => {
  const failure = classifyModelFailure("model_error", REAL_402);
  assert.ok(failure);
  assert.equal(failure.kind, "balance");
  assert.equal(failure.action, "top_up");
  // The whole point: retrying cannot fix it.
  assert.equal(failure.persistent, true);
});

test("the provider's own message survives classification, without the JSON envelope", () => {
  const failure = classifyModelFailure("model_error", REAL_402);
  assert.ok(failure);
  assert.match(failure.summary, /Insufficient Balance/);
  // The request id is noise to a reader; the envelope must not leak through.
  assert.doesNotMatch(failure.summary, /request_id/);
  assert.doesNotMatch(failure.summary, /^\s*402/);
  assert.doesNotMatch(failure.summary, /^\{/);
});

test("a 401 is an auth problem and needs a human", () => {
  const failure = classifyModelFailure("model_error", '401: {"message":"Invalid API key"}');
  assert.ok(failure);
  assert.equal(failure.kind, "auth");
  assert.equal(failure.action, "fix_config");
  assert.equal(failure.persistent, true);
});

test("a 429 is worth retrying after a wait, and is not persistent", () => {
  const failure = classifyModelFailure("model_error", '429: {"message":"Rate limit reached"}');
  assert.ok(failure);
  assert.equal(failure.kind, "rate_limit");
  assert.equal(failure.action, "retry_later");
  assert.equal(failure.persistent, false);
});

test("a context overflow suggests compacting rather than retrying", () => {
  const failure = classifyModelFailure(
    "model_error",
    "400: This model's maximum context length is 16384 tokens",
  );
  assert.ok(failure);
  assert.equal(failure.kind, "context");
  assert.equal(failure.action, "compact");
});

test("an unreadable provider error stays retryable rather than being guessed at", () => {
  const failure = classifyModelFailure("model_error", "Model response ended with stop reason error");
  assert.ok(failure);
  assert.equal(failure.kind, "unknown");
  assert.equal(failure.action, "retry");
  assert.equal(failure.persistent, false);
});

test("an abort is not a model failure", () => {
  assert.equal(classifyModelFailure("aborted", undefined), undefined);
});

test("a reset is not a model failure", () => {
  assert.equal(classifyModelFailure("reset", undefined), undefined);
});

test("no reason at all is not a model failure", () => {
  assert.equal(classifyModelFailure(undefined, REAL_402), undefined);
});

test("a message-less failure still produces a usable summary", () => {
  const failure = classifyModelFailure("model_error", undefined);
  assert.ok(failure);
  assert.equal(failure.kind, "unknown");
  assert.notEqual(failure.summary, "");
});

test("a structured detail object is summarised the same as a string", () => {
  const failure = classifyModelFailure("model_error", {
    status: 402,
    message: "Insufficient Balance",
  });
  assert.ok(failure);
  // The classification only sees the flattened text; `message` is hoisted out.
  assert.match(failure.summary, /Insufficient Balance/);
});

test("a very long provider message is truncated so it cannot take over a message", () => {
  const failure = classifyModelFailure("model_error", "500: " + "x".repeat(5000));
  assert.ok(failure);
  assert.ok(failure.summary.length <= 160, `summary was ${failure.summary.length} chars`);
  assert.match(failure.summary, /…$/);
});

test("the log description says whether it is worth waiting on", () => {
  const balance = classifyModelFailure("model_error", REAL_402);
  assert.ok(balance);
  assert.match(describeModelFailure(balance), /balance \(needs attention\)/);

  const throttle = classifyModelFailure("model_error", "429: too many requests");
  assert.ok(throttle);
  assert.match(describeModelFailure(throttle), /may be transient/);
});
