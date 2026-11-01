/**
 * Query tests: the per-conversation facts behind `/status` and `/model`.
 *
 * These run against a real Harness on MemoryStorage — no model is ever called,
 * because configuring an agent and reading a view are pure storage operations.
 * The point is the semantics the cards depend on: clamping a thinking level the
 * model lacks, keeping the binding and the agent in step, and totalling usage.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { createModels, type Model } from "@earendil-works/pi-ai/models";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { BridgeHost } from "../src/durable/host.js";
import {
  applyModelPick,
  clampThinkingLevel,
  conversationStatus,
  listConversations,
  rebind,
  renameConversation,
  startConversation,
  supportedThinkingLevels,
  switchModel,
  totalUsage,
} from "../src/adapter/queries.js";

/**
 * Model lookaside for the query layer. The Harness gets a real (empty) pi-ai
 * `Models` — it has to be a genuine collection, because pi-durable wraps it for
 * provider identity — while the queries only ever ask this stub to resolve a
 * model for its thinking levels.
 */
function fakeModelRuntime(): ModelRuntime {
  const models: Record<string, Model<any>> = {
    "llama-local/small": { provider: "llama-local", id: "small", name: "small", api: "openai-completions", reasoning: false, input: ["text"], contextWindow: 1000, outputWindow: 100 } as Model<any>,
    "deepseek/flash": { provider: "deepseek", id: "flash", name: "flash", api: "openai-completions", reasoning: true, input: ["text"], contextWindow: 1000, outputWindow: 100 } as Model<any>,
  };
  return { getModel: (provider: string, modelId: string) => models[`${provider}/${modelId}`] } as unknown as ModelRuntime;
}

async function host() {
  const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
  // BridgeHost's constructor is private; open() would build a real ModelRuntime.
  // Tests only need the harness plus a model lookaside, which is what the query
  // layer touches.
  const fake = Object.create(BridgeHost.prototype) as BridgeHost;
  Object.assign(fake, { harness, context: BACKGROUND_CONTEXT, modelRuntime: fakeModelRuntime() });
  return fake;
}

test("a non-reasoning model supports only 'off'", () => {
  const models = { getModel: () => ({ reasoning: false }) } as unknown as ModelRuntime;
  assert.deepEqual(supportedThinkingLevels(models, "llama-local", "small"), ["off"]);
});

test("an unknown model has no level list at all", () => {
  const models = { getModel: () => undefined } as unknown as ModelRuntime;
  assert.equal(supportedThinkingLevels(models, "x", "y"), undefined);
});

test("clampThinkingLevel keeps a supported level and falls back to the lowest otherwise", () => {
  assert.equal(clampThinkingLevel(["off", "low", "high"], "low"), "low");
  assert.equal(clampThinkingLevel(["off", "low", "high"], "high"), "high");
  assert.equal(clampThinkingLevel(["off", "low"], "max"), "low");
  assert.equal(clampThinkingLevel(["off"], "high"), "off");
  assert.equal(clampThinkingLevel(["off", "high"], undefined), "off");
  assert.equal(clampThinkingLevel(["off", "high"], "nonsense"), "off");
});

test("totalUsage sums every model a conversation has used", () => {
  const totals = totalUsage({
    models: {
      "deepseek/deepseek-flash": { input: 100, output: 20, totalTokens: 120, cost: { total: 0.5 } },
      "llama-local/small": { input: 10, output: 5, totalTokens: 15, cost: { total: 0 } },
    },
  });
  assert.deepEqual(totals, { input: 110, output: 25, total: 135, cost: 0.5 });
  assert.equal(totalUsage({}), undefined);
  assert.equal(totalUsage(undefined), undefined);
  assert.equal(totalUsage({ models: { a: { input: 0, output: 0, totalTokens: 0 } } }), undefined);
});

test("an unbound Chat key reports itself as new", async () => {
  const h = await host();
  const status = await conversationStatus(h, "spaces/sAAA/threads/new");
  assert.deepEqual(status, { isNew: true });
});

test("starting a conversation binds it, and status reflects the configured agent", async () => {
  const h = await host();
  const binding = await startConversation(h, "spaces/sAAA/threads/T1", {
    model: { provider: "deepseek", modelId: "flash" },
    thinkingLevel: "high",
  });
  assert.equal(binding.model, "deepseek/flash");

  const status = await conversationStatus(h, "spaces/sAAA/threads/T1");
  assert.equal(status.isNew, false);
  assert.equal(status.model, "deepseek/flash");
  assert.equal(status.thinkingLevel, "high");
  assert.equal(status.conversationId, binding.conversationId);
});

test("switchModel writes the agent and the binding together", async () => {
  const h = await host();
  await startConversation(h, "spaces/sAAA/threads/T1", { model: { provider: "deepseek", modelId: "flash" } });

  const switched = await switchModel(h, "spaces/sAAA/threads/T1", "llama-local", "small", "high");
  // The local model has no reasoning, so "high" clamps to "off" rather than the
  // card claiming a level the model cannot run.
  assert.equal(switched.thinkingLevel, "off");

  const status = await conversationStatus(h, "spaces/sAAA/threads/T1");
  assert.equal(status.model, "llama-local/small");
  assert.equal(status.thinkingLevel, "off");
  const binding = await h.bindingFor("spaces/sAAA/threads/T1");
  assert.equal(binding?.model, "llama-local/small");
  assert.equal(binding?.thinking, "off");
});

test("switchModel refuses a key with no conversation", async () => {
  const h = await host();
  await assert.rejects(() => switchModel(h, "nobody", "deepseek", "flash"), /no conversation/);
});

test("listConversations returns newest first", async () => {
  const h = await host();
  await startConversation(h, "k1", { model: { provider: "deepseek", modelId: "flash" } });
  await new Promise((r) => setTimeout(r, 2));
  await startConversation(h, "k2", { model: { provider: "deepseek", modelId: "flash" } });
  const list = await listConversations(h);
  assert.deepEqual(list.map((entry) => entry.chatKey), ["k2", "k1"]);
});

test("applyModelPick starts a conversation when the thread has none", async () => {
  const h = await host();
  const result = await applyModelPick(h, "spaces/sAAA/threads/pick1", {
    provider: "deepseek",
    modelId: "flash",
    thinkingLevel: "high",
  });
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.thinkingLevel, "high");

  const status = await conversationStatus(h, "spaces/sAAA/threads/pick1");
  assert.equal(status.model, "deepseek/flash");
});

test("applyModelPick switches an existing conversation and clamps the level", async () => {
  const h = await host();
  await startConversation(h, "k", { model: { provider: "deepseek", modelId: "flash" } });
  const result = await applyModelPick(h, "k", {
    provider: "llama-local",
    modelId: "small",
    thinkingLevel: "high",
  });
  assert.equal(result.ok, true);
  assert.equal(result.created, undefined);
  // The local model has no reasoning levels, so the level clamps to "off"
  // rather than the card claiming "high".
  assert.equal(result.thinkingLevel, "off");
});

test("applyModelPick rejects an unknown model without touching the binding", async () => {
  const h = await host();
  const before = await h.bindingFor("k");
  const result = await applyModelPick(h, "k", { provider: "nope", modelId: "nope" });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Unknown model/);
  assert.deepEqual(await h.bindingFor("k"), before);
});

test("renameConversation stores a display name without touching the agent", async () => {
  const h = await host();
  await startConversation(h, "k", { model: { provider: "deepseek", modelId: "flash" } });
  assert.equal(await renameConversation(h, "k", "deploy postmortem"), true);
  assert.equal((await h.bindingFor("k"))?.name, "deploy postmortem");
  assert.equal(await renameConversation(h, "missing", "x"), false);
  // The name is a Chat-side label: /status must not report it as a model change.
  assert.equal((await conversationStatus(h, "k")).model, "deepseek/flash");
});

test("rebind points a key at another conversation and keeps the display name", async () => {
  const h = await host();
  const first = await startConversation(h, "k", { model: { provider: "deepseek", modelId: "flash" } });
  await renameConversation(h, "k", "old thread");
  const other = await startConversation(h, "other", { model: { provider: "llama-local", modelId: "small" } });

  assert.equal(await rebind(h, "k", other.conversationId), true);
  const binding = await h.bindingFor("k");
  assert.equal(binding?.conversationId, other.conversationId);
  assert.equal(binding?.model, "llama-local/small");
  assert.equal(binding?.name, "old thread");
  assert.notEqual(binding?.conversationId, first.conversationId);
  assert.equal(await rebind(h, "k", 99_999), false);
});
