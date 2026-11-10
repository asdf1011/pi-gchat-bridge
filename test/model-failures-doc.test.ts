/**
 * The recorded-failure document: bounded, and cleared by a success.
 *
 * The document is what `/status` reads, so these check the two ways it could go
 * wrong in production rather than the happy path alone: growing without limit on
 * a misconfigured `models.json`, and reporting a stale failure after the problem
 * was fixed.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_PROVIDER_FAILURES,
  providerOf,
  withoutProviderFailure,
  withProviderFailure,
  type ProviderFailure,
} from "../src/durable/model-failures-doc.js";

function failure(provider: string, at: number): ProviderFailure {
  return {
    provider,
    kind: "balance",
    action: "top_up",
    summary: "Insufficient Balance",
    persistent: true,
    at,
    reason: "model_error",
  };
}

test("a recorded failure is readable under its provider", () => {
  const value = withProviderFailure(undefined, failure("deepseek", 1000));
  assert.equal(value.byProvider.deepseek?.kind, "balance");
});

test("a newer failure for the same provider replaces the older one", () => {
  let value = withProviderFailure(undefined, failure("deepseek", 1000));
  value = withProviderFailure(value, { ...failure("deepseek", 2000), summary: "still broke" });
  assert.equal(Object.keys(value.byProvider).length, 1);
  assert.equal(value.byProvider.deepseek?.summary, "still broke");
  assert.equal(value.byProvider.deepseek?.at, 2000);
});

test("a success clears that provider and leaves the others alone", () => {
  let value = withProviderFailure(undefined, failure("deepseek", 1000));
  value = withProviderFailure(value, failure("openai", 1500));
  value = withoutProviderFailure(value, "deepseek");
  assert.equal(value.byProvider.deepseek, undefined);
  // Clearing one must not clear the rest: they are independent accounts.
  assert.ok(value.byProvider.openai);
});

test("clearing an absent provider is a no-op rather than a throw", () => {
  const value = withoutProviderFailure(undefined, "deepseek");
  assert.deepEqual(value.byProvider, {});
});

test("the document is bounded, dropping the oldest providers first", () => {
  let value = withProviderFailure(undefined, failure("p0", 0));
  for (let i = 1; i <= MAX_PROVIDER_FAILURES + 5; i++) {
    value = withProviderFailure(value, failure(`p${i}`, i * 1000));
  }
  assert.equal(Object.keys(value.byProvider).length, MAX_PROVIDER_FAILURES);
  // The oldest went first; a recent one survived.
  assert.equal(value.byProvider.p0, undefined);
  assert.ok(value.byProvider[`p${MAX_PROVIDER_FAILURES + 5}`]);
});

test("withProviderFailure does not mutate the value it is given", () => {
  const before = withProviderFailure(undefined, failure("deepseek", 1000));
  const snapshot = JSON.stringify(before);
  withProviderFailure(before, failure("openai", 2000));
  assert.equal(JSON.stringify(before), snapshot);
});

test("a provider is the part before the first slash", () => {
  assert.equal(providerOf("deepseek/deepseek-flash"), "deepseek");
  // A vendor-qualified model id keeps the vendor in the model half.
  assert.equal(providerOf("openrouter/meta/llama-3"), "openrouter");
  assert.equal(providerOf(undefined), undefined);
  assert.equal(providerOf(""), undefined);
  assert.equal(providerOf("noprovider"), undefined);
});
