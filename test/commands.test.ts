import test from "node:test";
import assert from "node:assert/strict";
import { runCommand } from "../src/commands.js";
import { MODEL_ACTION, SETTINGS_ACTION, SET_DEFAULT_MODEL_ACTION, THINKING_LEVELS_ACTION } from "../src/constants.js";
import type { AgentRouter, ConversationSettingsRequest } from "../src/agent-sessions.js";
import type { ChatClient } from "../src/chat-client.js";
import type { IncomingMessage } from "../src/types.js";

const MODELS = [
  { provider: "deepseek", id: "deepseek-flash", label: "DeepSeek Flash (deepseek)" },
  { provider: "llama-local", id: "lfm3-vl-2b-q8", label: "LFM3 VL (llama-local)" },
];

/** Capture what the bridge sent/updated and what it asked the router to do. */
function harness(overrides: Partial<Record<string, unknown>> = {}) {
  const sent: { threadName?: string; cards?: unknown[]; text: string }[] = [];
  const updated: { name: string; cards?: unknown[]; text: string }[] = [];
  const settingsCalls: ConversationSettingsRequest[] = [];
  const defaultsCalls: ConversationSettingsRequest[] = [];

  const client = {
    sendMessage: async (_space: string, text: string, threadName?: string) => {
      sent.push({ text, threadName });
    },
    createCardMessage: async (_space: string, cards: unknown[], text: string, threadName?: string) => {
      sent.push({ cards, text, threadName });
    },
    updateMessageCards: async (name: string, cards: unknown[], text: string) => {
      updated.push({ name, cards, text });
    },
  } as unknown as ChatClient;

  const router = {
    listModels: async () => MODELS,
    hasSession: () => true,
    isBusy: () => false,
    defaultSettings: () => ({
      provider: "deepseek",
      modelId: "deepseek-flash",
      modelLabel: "DeepSeek Flash (deepseek)",
      thinkingLevel: "medium",
    }),
    currentModel: async () => "DeepSeek Flash (deepseek)",
    currentModelValue: async () => "deepseek|deepseek-flash",
    currentThinkingLevel: async () => "high",
    availableThinkingLevels: () => ["off", "high", "max"],
    // Stand-in for pi's per-model rule: the local 2B model has no reasoning at all.
    thinkingLevelsForModel: (_provider: string, modelId: string) =>
      modelId === "lfm3-vl-2b-q8" ? ["off"] : ["off", "high", "max"],
    applyConversationSettings: async (_key: string, req: ConversationSettingsRequest) => {
      settingsCalls.push(req);
      return {
        ok: true,
        modelLabel: "DeepSeek Flash (deepseek)",
        thinkingLevel: req.thinkingLevel && req.thinkingLevel !== "keep" ? req.thinkingLevel : "high",
      };
    },
    setDefaults: async (req: ConversationSettingsRequest) => {
      defaultsCalls.push(req);
      return { ok: true, modelLabel: "DeepSeek Flash (deepseek)", thinkingLevel: req.thinkingLevel ?? "medium" };
    },
    ...overrides,
  } as unknown as AgentRouter;

  return { client, router, sent, updated, settingsCalls, defaultsCalls };
}

function click(
  actionMethodName: string,
  formInputs: Record<string, string>,
  params: { key: string; value: string }[] = [],
): IncomingMessage {
  return {
    eventType: "CARD_CLICKED",
    space: { name: "spaces/S" },
    message: { name: "spaces/S/messages/M" },
    action: {
      actionMethodName,
      parameters: params,
      formInputs: Object.fromEntries(
        Object.entries(formInputs).map(([k, v]) => [k, { selectionInput: { selectedValues: [v] } }]),
      ),
    },
  } as IncomingMessage;
}

function ctx(
  client: ChatClient,
  router: AgentRouter,
  incoming: IncomingMessage,
  text = "",
) {
  return {
    client,
    router,
    incoming,
    sessionKey: "spaces/S/threads/T",
    actionKey: "spaces/S/threads/T",
    spaceName: "spaces/S",
    threadName: "spaces/S/threads/T",
    display: "tester",
    text,
  };
}

test("/model posts a card with both dropdowns", async () => {
  const h = harness();
  const res = await runCommand(
    ctx(h.client, h.router, { eventType: "MESSAGE", space: { name: "spaces/S" }, message: { name: "m" } }, "/model"),
  );
  assert.equal(res, "ok");
  const payload = JSON.stringify(h.sent[0].cards);
  assert.match(payload, /"model_picker"/);
  assert.match(payload, /"thinking_picker"/);
  // The card no longer points at the retired /defaultmodel command.
  assert.doesNotMatch(payload, /\/defaultmodel/);
});

test("/model on a fresh conversation points at /settings for defaults", async () => {
  const h = harness({ hasSession: () => false });
  await runCommand(
    ctx(h.client, h.router, { eventType: "MESSAGE", space: { name: "spaces/S" }, message: { name: "m" } }, "/model"),
  );
  const payload = JSON.stringify(h.sent[0].cards);
  assert.match(payload, /\/settings/);
  assert.match(payload, /Start conversation/);
});

test("a model-card click applies model AND thinking level", async () => {
  const h = harness();
  const res = await runCommand(
    ctx(
      h.client,
      h.router,
      click(MODEL_ACTION, {
        model_picker: "deepseek|deepseek-flash",
        thinking_picker: "high",
      }, [{ key: "session", value: "spaces/S/threads/T" }]),
    ),
  );
  assert.equal(res, "ok");
  assert.deepEqual(h.settingsCalls, [
    { provider: "deepseek", modelId: "deepseek-flash", thinkingLevel: "high" },
  ]);
  assert.match(h.updated[0].text, /high/);
});

test("a model-card click with keep-current leaves the level to the router", async () => {
  const h = harness();
  await runCommand(
    ctx(
      h.client,
      h.router,
      click(MODEL_ACTION, {
        model_picker: "deepseek|deepseek-flash",
        thinking_picker: "keep",
      }),
    ),
  );
  assert.equal(h.settingsCalls[0].thinkingLevel, "keep");
});

test("a model-card click without the thinking dropdown (old card) still switches", async () => {
  const h = harness();
  await runCommand(
    ctx(h.client, h.router, click(MODEL_ACTION, { model_picker: "deepseek|deepseek-flash" })),
  );
  assert.equal(h.settingsCalls[0].modelId, "deepseek-flash");
  assert.equal(h.settingsCalls[0].thinkingLevel, undefined);
});

test("changing the model dropdown re-renders the card with that model's levels", async () => {
  const h = harness();
  const res = await runCommand(
    ctx(
      h.client,
      h.router,
      click(THINKING_LEVELS_ACTION, { model_picker: "llama-local|lfm3-vl-2b-q8" }, [
        { key: "mode", value: "model" },
        { key: "session", value: "spaces/S/threads/T" },
      ]),
    ),
  );
  assert.equal(res, "ok");
  const widgets = JSON.parse(JSON.stringify(h.updated[0].cards))[0].card.sections[0].widgets;
  const model = widgets.find((w: any) => w.selectionInput?.name === "model_picker").selectionInput;
  const thinking = widgets.find((w: any) => w.selectionInput?.name === "thinking_picker").selectionInput;
  // The picked model stays selected, and only its levels are offered.
  assert.equal(model.items.find((i: any) => i.value === "llama-local|lfm3-vl-2b-q8").selected, true);
  assert.deepEqual(thinking.items.map((i: any) => i.value), ["off"]);
  // Nothing was applied — a re-render must not switch the conversation.
  assert.equal(h.settingsCalls.length, 0);
});

test("changing the default-model dropdown re-renders the settings card", async () => {
  const h = harness();
  await runCommand(
    ctx(h.client, h.router, click(THINKING_LEVELS_ACTION, { default_model_picker: "llama-local|lfm3-vl-2b-q8" }, [
      { key: "mode", value: "settings" },
    ])),
  );
  const widgets = JSON.parse(JSON.stringify(h.updated[0].cards))[0].card.sections[0].widgets;
  const thinking = widgets.find((w: any) => w.selectionInput?.name === "default_thinking_picker").selectionInput;
  assert.deepEqual(thinking.items.map((i: any) => i.value), ["off"]);
  assert.equal(h.defaultsCalls.length, 0);
});

test("a change event with no readable value leaves the card alone", async () => {
  const h = harness();
  await runCommand(ctx(h.client, h.router, click(THINKING_LEVELS_ACTION, {}, [{ key: "mode", value: "model" }])));
  assert.equal(h.updated.length, 0);
  assert.equal(h.settingsCalls.length, 0);
});

test("/settings posts the defaults card at the top level", async () => {
  const h = harness();
  await runCommand(
    ctx(h.client, h.router, { eventType: "MESSAGE", space: { name: "spaces/S" }, message: { name: "m" } }, "/settings"),
  );
  assert.equal(h.sent[0].threadName, undefined);
  const payload = JSON.stringify(h.sent[0].cards);
  assert.match(payload, /"default_model_picker"/);
  assert.match(payload, /"default_thinking_picker"/);
});

test("/defaultmodel is still an alias for /settings", async () => {
  const h = harness();
  await runCommand(
    ctx(h.client, h.router, { eventType: "MESSAGE", space: { name: "spaces/S" }, message: { name: "m" } }, "/defaultmodel"),
  );
  assert.match(JSON.stringify(h.sent[0].cards), /"default_thinking_picker"/);
});

test("a settings-card click saves model AND level (and the legacy action id still works)", async () => {
  for (const action of [SETTINGS_ACTION, SET_DEFAULT_MODEL_ACTION]) {
    const h = harness();
    await runCommand(
      ctx(
        h.client,
        h.router,
        click(action, {
          default_model_picker: "deepseek|deepseek-flash",
          default_thinking_picker: "low",
        }),
      ),
    );
    assert.deepEqual(h.defaultsCalls, [
      { provider: "deepseek", modelId: "deepseek-flash", thinkingLevel: "low" },
    ]);
  }
});

test("a settings click without a model reports it instead of saving", async () => {
  const h = harness();
  await runCommand(ctx(h.client, h.router, click(SETTINGS_ACTION, {})));
  assert.equal(h.defaultsCalls.length, 0);
  assert.match(h.updated[0].text, /No model/i);
});
