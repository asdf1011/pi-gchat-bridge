import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { modelPickerCard, settingsCard, statusCard } from "../src/cards.js";
import { MODEL_ACTION, SETTINGS_ACTION, THINKING_KEEP, THINKING_LEVELS, THINKING_LEVELS_ACTION } from "../src/constants.js";
import type { ModelInfo } from "../src/session-host/api.js";
import { clampToSupported, supportedThinkingLevels } from "../src/settings.js";

const MODELS: ModelInfo[] = [
  { provider: "deepseek", id: "deepseek-flash", label: "DeepSeek Flash (deepseek)" },
  { provider: "llama-local", id: "lfm3-vl-2b-q8", label: "LFM3 VL (llama-local)" },
];

/** Walk a card payload and collect widget objects of a given kind. */
function widgets(card: unknown[], kind: "selectionInput" | "buttonList"): any[] {
  const found: any[] = [];
  const walk = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node[kind]) found.push(node[kind]);
    Object.values(node).forEach(walk);
  };
  walk(card);
  return found;
}

test("model picker carries both dropdowns and a keep-current thinking option", () => {
  const card = modelPickerCard(MODELS, "key", "DeepSeek Flash (deepseek)", {
    thinkingLevel: "high",
  });
  const selects = widgets(card, "selectionInput");
  assert.equal(selects.length, 2);
  assert.equal(selects[0].name, "model_picker");
  assert.equal(selects[1].name, "thinking_picker");
  // keep-current first, then every level with the active one pre-selected.
  assert.equal(selects[1].items[0].value, THINKING_KEEP);
  assert.deepEqual(
    selects[1].items.slice(1).map((i: any) => i.value),
    [...THINKING_LEVELS],
  );
  assert.equal(selects[1].items.find((i: any) => i.value === "high").selected, true);
  assert.equal(widgets(card, "buttonList")[0].buttons[0].onClick.action.function, MODEL_ACTION);
});

test("model picker on a new conversation defaults to keep-current (no level yet)", () => {
  const card = modelPickerCard(MODELS, "key", undefined, { newConversation: true });
  const thinking = widgets(card, "selectionInput")[1];
  assert.equal(thinking.items[0].value, THINKING_KEEP);
  assert.equal(thinking.items[0].selected, true);
  assert.equal(
    thinking.items.filter((i: any) => i.selected).length,
    1,
    "exactly one option pre-selected",
  );
  assert.equal(widgets(card, "buttonList")[0].buttons[0].onClick.action.function, MODEL_ACTION);
});

test("model picker reports the current model's supported levels when known", () => {
  const card = modelPickerCard(MODELS, "key", undefined, { supportedLevels: ["off"] });
  assert.match(JSON.stringify(card), /Thinking levels for this model: <b>off<\/b>/);
  // Only supported levels are offered (plus keep), so nothing can be clamped.
  const levels = widgets(card, "selectionInput")[1].items.map((i: any) => i.value);
  assert.deepEqual(levels, [THINKING_KEEP, "off"]);
});

test("the model dropdown asks Chat to re-render the card on change", () => {
  const card = modelPickerCard(MODELS, "key", undefined, { currentValue: "deepseek|deepseek-flash" });
  const model = widgets(card, "selectionInput")[0];
  assert.equal(model.onChangeAction.function, THINKING_LEVELS_ACTION);
  assert.deepEqual(model.onChangeAction.parameters, [
    { key: "mode", value: "model" },
    { key: "session", value: "key" },
  ]);
  // A re-render must keep the picked model selected.
  assert.equal(model.items.find((i: any) => i.value === "deepseek|deepseek-flash").selected, true);
});

test("keep-current is dropped when the model doesn't support the current level", () => {
  const card = modelPickerCard(MODELS, "key", undefined, {
    thinkingLevel: "high",
    supportedLevels: ["off"],
  });
  const thinking = widgets(card, "selectionInput")[1];
  assert.deepEqual(thinking.items.map((i: any) => i.value), ["off"]);
  assert.match(JSON.stringify(card), /doesn't support <b>high<\/b>/);
});

test("the settings dropdown asks Chat to re-render the defaults card on change", () => {
  const card = settingsCard(MODELS, { provider: "deepseek", modelId: "deepseek-flash", thinkingLevel: "high" });
  assert.deepEqual(widgets(card, "selectionInput")[0].onChangeAction.parameters, [
    { key: "mode", value: "settings" },
  ]);
});

test("settings card exposes both default dropdowns and preselects the current default", () => {
  const card = settingsCard(MODELS, {
    provider: "deepseek",
    modelId: "deepseek-flash",
    modelLabel: "DeepSeek Flash (deepseek)",
    thinkingLevel: "medium",
  });
  const selects = widgets(card, "selectionInput");
  assert.deepEqual(
    selects.map((s) => s.name),
    ["default_model_picker", "default_thinking_picker"],
  );
  assert.equal(selects[0].items.find((i: any) => i.value === "deepseek|deepseek-flash").selected, true);
  assert.equal(selects[1].items.find((i: any) => i.value === "medium").selected, true);
  assert.equal(widgets(card, "buttonList")[0].buttons[0].onClick.action.function, SETTINGS_ACTION);
});

test("an unsupported current level pre-selects the level pi would clamp to", () => {
  // deepseek-flash-like: off / high / max, so medium clamps UP to high (not down to off).
  const card = modelPickerCard(MODELS, "key", undefined, {
    thinkingLevel: "medium",
    supportedLevels: ["off", "high", "max"],
  });
  const thinking = widgets(card, "selectionInput")[1];
  assert.deepEqual(thinking.items.map((i: any) => i.value), ["off", "high", "max"]);
  assert.equal(thinking.items.find((i: any) => i.value === "high").selected, true);
});

test("supportedThinkingLevels follows pi's reasoning + thinkingLevelMap rule", () => {
  assert.deepEqual(supportedThinkingLevels({ reasoning: false }), ["off"]);
  // xhigh/max exist only when explicitly mapped, so a plain reasoning model
  // offers off → high.
  assert.deepEqual(supportedThinkingLevels({ reasoning: true }), ["off", "minimal", "low", "medium", "high"]);
  assert.deepEqual(
    supportedThinkingLevels({
      reasoning: true,
      thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: "max" },
    }),
    ["off", "high", "max"],
  );
  // xhigh/max exist only when explicitly mapped.
  assert.deepEqual(
    supportedThinkingLevels({ reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } }),
    [...THINKING_LEVELS],
  );
});

test("clampToSupported clamps up before down, like pi", () => {
  assert.equal(clampToSupported(["off", "high", "max"], "medium"), "high");
  assert.equal(clampToSupported(["off", "low"], "high"), "low");
  assert.equal(clampToSupported(["off"], "max"), "off");
  assert.equal(clampToSupported(["off", "high"], "high"), "high");
  assert.equal(clampToSupported(["off"], undefined), undefined);
});

test("status card shows the thinking level for a conversation and for the defaults", () => {
  const convo = JSON.stringify(statusCard({ model: "Flash (deepseek)", thinkingLevel: "high" }));
  assert.match(convo, /Thinking: <b>high<\/b>/);

  const fresh = JSON.stringify(
    statusCard({ defaultModel: "Flash (deepseek)", defaultThinkingLevel: "medium" }),
  );
  assert.match(fresh, /Thinking: <b>medium<\/b>/);
});
