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
import { createModels } from "@earendil-works/pi-ai/models";
// `Model` lives on the package root; `./models` only carries the registry.
import type { Model } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { BridgeHost, totalUsage } from "../src/durable/host.js";
import { inProcessSessionHost } from "../src/session-host/inprocess.js";
import type { SessionHost } from "../src/session-host/api.js";
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
} from "../src/adapter/queries.js";

/**
 * Model lookaside for the query layer. The Harness gets a real (empty) pi-ai
 * `Models` — it has to be a genuine collection, because pi-durable wraps it for
 * provider identity — while the queries only ever ask this stub to resolve a
 * model for its thinking levels.
 */
function fakeModelRuntime(): ModelRuntime {
  const models: Record<string, Model<any>> = {
    "llama-local/small": { provider: "llama-local", id: "small", name: "small", api: "openai-completions", baseUrl: "https://example.invalid", reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as Model<any>,
    "deepseek/flash": { provider: "deepseek", id: "flash", name: "flash", api: "openai-completions", baseUrl: "https://example.invalid", reasoning: true, input: ["text"], contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as Model<any>,
  };
  return {
    getModel: (provider: string, modelId: string) => models[`${provider}/${modelId}`],
    // /model lists models, so the picker needs the collection too.
    getAllAvailable: async () => Object.values(models).map((model) => ({ ...model, type: "chat" })),
  } as unknown as ModelRuntime;
}

async function host() {
  const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
  // BridgeHost's constructor is private; open() would build a real ModelRuntime.
  // Tests only need the harness plus a model lookaside, which is what the query
  // layer touches.
  const fake = Object.create(BridgeHost.prototype) as BridgeHost;
  Object.assign(fake, { harness, context: BACKGROUND_CONTEXT, modelRuntime: fakeModelRuntime(), cwd: "/tmp", dbPath: ":memory:" });
  return fake;
}

/** The seam over that host: what the query layer actually talks to. */
function seamOf(host: BridgeHost): SessionHost {
  return inProcessSessionHost({ host, roots: [] });
}

test("a non-reasoning model supports only 'off'", () => {
  const models = [{ provider: "llama-local", id: "small", label: "small", thinkingLevels: ["off"] }];
  assert.deepEqual(supportedThinkingLevels(models, "llama-local", "small"), ["off"]);
});

test("an unknown model has no level list at all", () => {
  assert.equal(supportedThinkingLevels([], "x", "y"), undefined);
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
      "deepseek/deepseek-flash": {
        input: 100,
        output: 20,
        cacheRead: 1000,
        cacheWrite: 40,
        totalTokens: 1160,
        cost: { total: 0.5 },
      },
      "llama-local/small": { input: 10, output: 5, cacheRead: 7, totalTokens: 22, cost: { total: 0 } },
    },
  });
  assert.deepEqual(totals, {
    input: 110,
    output: 25,
    cacheRead: 1007,
    cacheWrite: 40,
    total: 1182,
    cost: 0.5,
  });
  assert.equal(totalUsage({}), undefined);
  assert.equal(totalUsage(undefined), undefined);
  assert.equal(totalUsage({ models: { a: { input: 0, output: 0, totalTokens: 0 } } }), undefined);
});

test("an unbound Chat key reports itself as new", async () => {
  const h = await host();
  const seam = seamOf(h);
  const status = await conversationStatus(seam, "spaces/sAAA/threads/new");
  assert.deepEqual(status, { isNew: true });
});

test("starting a conversation binds it, and status reflects the configured agent", async () => {
  const h = await host();
  const seam = seamOf(h);
  const binding = await startConversation(seam, "spaces/sAAA/threads/T1", {
    model: { provider: "deepseek", modelId: "flash" },
    thinkingLevel: "high",
  });
  assert.equal(binding.model, "deepseek/flash");

  const status = await conversationStatus(seam, "spaces/sAAA/threads/T1");
  assert.equal(status.isNew, false);
  assert.equal(status.model, "deepseek/flash");
  assert.equal(status.thinkingLevel, "high");
  assert.equal(status.conversationId, binding.conversationId);
});

test("switchModel writes the agent and the binding together", async () => {
  const h = await host();
  const seam = seamOf(h);
  await startConversation(seam, "spaces/sAAA/threads/T1", { model: { provider: "deepseek", modelId: "flash" } });

  const switched = await switchModel(seam, "spaces/sAAA/threads/T1", "llama-local", "small", "high");
  // The local model has no reasoning, so "high" clamps to "off" rather than the
  // card claiming a level the model cannot run.
  assert.equal(switched.thinkingLevel, "off");

  const status = await conversationStatus(seam, "spaces/sAAA/threads/T1");
  assert.equal(status.model, "llama-local/small");
  assert.equal(status.thinkingLevel, "off");
  const binding = await h.bindingFor("spaces/sAAA/threads/T1");
  assert.equal(binding?.model, "llama-local/small");
  assert.equal(binding?.thinking, "off");
});

test("switchModel refuses a key with no conversation", async () => {
  const h = await host();
  const seam = seamOf(h);
  await assert.rejects(() => switchModel(seam, "nobody", "deepseek", "flash"), /no conversation/);
});

test("listConversations returns newest first", async () => {
  const h = await host();
  const seam = seamOf(h);
  await startConversation(seam, "k1", { model: { provider: "deepseek", modelId: "flash" } });
  await new Promise((r) => setTimeout(r, 2));
  await startConversation(seam, "k2", { model: { provider: "deepseek", modelId: "flash" } });
  const list = await listConversations(seam);
  assert.deepEqual(list.map((entry) => entry.name), ["k2", "k1"]);
});

test("applyModelPick starts a conversation when the thread has none", async () => {
  const h = await host();
  const seam = seamOf(h);
  const result = await applyModelPick(seam, "spaces/sAAA/threads/pick1", {
    provider: "deepseek",
    modelId: "flash",
    thinkingLevel: "high",
  });
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.thinkingLevel, "high");

  const status = await conversationStatus(seam, "spaces/sAAA/threads/pick1");
  assert.equal(status.model, "deepseek/flash");
});

test("applyModelPick switches an existing conversation and clamps the level", async () => {
  const h = await host();
  const seam = seamOf(h);
  await startConversation(seam, "k", { model: { provider: "deepseek", modelId: "flash" } });
  const result = await applyModelPick(seam, "k", {
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
  const seam = seamOf(h);
  const before = await h.bindingFor("k");
  const result = await applyModelPick(seam, "k", { provider: "nope", modelId: "nope" });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Unknown model/);
  assert.deepEqual(await h.bindingFor("k"), before);
});

test("renameConversation stores a display name without touching the agent", async () => {
  const h = await host();
  const seam = seamOf(h);
  await startConversation(seam, "k", { model: { provider: "deepseek", modelId: "flash" } });
  assert.equal(await renameConversation(seam, "k", "deploy postmortem"), true);
  assert.equal((await h.bindingFor("k"))?.name, "deploy postmortem");
  assert.equal(await renameConversation(seam, "missing", "x"), false);
  // The name is a Chat-side label: /status must not report it as a model change.
  assert.equal((await conversationStatus(seam, "k")).model, "deepseek/flash");
});

test("rebind points a key at another conversation and keeps the display name", async () => {
  const h = await host();
  const seam = seamOf(h);
  const first = await startConversation(seam, "k", { model: { provider: "deepseek", modelId: "flash" } });
  await renameConversation(seam, "k", "old thread");
  const other = await startConversation(seam, "other", { model: { provider: "llama-local", modelId: "small" } });

  assert.equal(await rebind(seam, "k", other.conversationId), true);
  const binding = await h.bindingFor("k");
  assert.equal(binding?.conversationId, other.conversationId);
  assert.equal(binding?.model, "llama-local/small");
  assert.equal(binding?.name, "old thread");
  assert.notEqual(binding?.conversationId, first.conversationId);
  assert.equal(await rebind(seam, "k", 99_999), false);
});
