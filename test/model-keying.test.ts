/**
 * `/model` thread keying — the one command whose behaviour depends on which
 * thread Chat says an event came from.
 *
 * The hazard is real and was hand-managed in the SDK host: a pick that *starts* a
 * conversation must bind it to the thread the user's **next message** will land
 * in. Bind it anywhere else and the conversation exists, answers nothing, and the
 * thread the user keeps typing in silently starts a second one on the default
 * model.
 *
 * Two facts make this subtle:
 *
 *   1. CARD_CLICKED often arrives **without** the message's thread, so the key
 *      computed from the event collapses to the space. The card's own `session`
 *      parameter is the reliable hint.
 *   2. A picker posted as a top-level message gives the card a thread of its own,
 *      which is *not* where the user's reply goes.
 *
 * So every case below runs twice where the distinction matters: once with the
 * event carrying a thread, once without. Those two shapes are what Chat actually
 * sends, and they are why this file exists.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { createModels, type Model } from "@earendil-works/pi-ai/models";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { BridgeHost } from "../src/durable/host.js";
import { inProcessSessionHost } from "../src/session-host/inprocess.js";
import { DurableRouter } from "../src/adapter/router.js";
import { runDurableCommand } from "../src/adapter/commands.js";
import { conversationStatus, startConversation } from "../src/adapter/queries.js";
import { MODEL_ACTION, THINKING_LEVELS_ACTION } from "../src/constants.js";
import type { IncomingMessage } from "../src/types.js";

const SPACE = "spaces/S";
const THREAD_A = "spaces/S/threads/A";
const THREAD_B = "spaces/S/threads/B";

function modelRuntime(): ModelRuntime {
  const models: Record<string, Model<any>> = {
    "deepseek/flash": { provider: "deepseek", id: "flash", name: "flash", api: "openai-completions", reasoning: true, input: ["text"], contextWindow: 1000, outputWindow: 100 } as Model<any>,
    "llama-local/small": { provider: "llama-local", id: "small", name: "small", api: "openai-completions", reasoning: false, input: ["text"], contextWindow: 1000, outputWindow: 100 } as Model<any>,
  };
  return {
    getModel: (p: string, m: string) => models[`${p}/${m}`],
    // The card paths list models, so the picker re-render needs this too.
    getAllAvailable: async () => Object.values(models).map((model) => ({ ...model, type: "chat" })),
  } as unknown as ModelRuntime;
}

async function setup() {
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: createModels(), registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  const host = Object.create(BridgeHost.prototype) as BridgeHost;
  Object.assign(host, {
    harness,
    context: BACKGROUND_CONTEXT,
    modelRuntime: modelRuntime(),
    // cwdPath is a getter over this field, so only the field is assigned.
    cwd: "/tmp",
  });
  const seam = inProcessSessionHost({ host, roots: [] });
  const router = new DurableRouter(host, { model: { provider: "deepseek", modelId: "flash" } });
  const sent: string[] = [];
  const cards: unknown[] = [];
  const client = {
    async sendMessage(_s: string, text: string) {
      sent.push(text);
    },
    async createCardMessage(_s: string, card: unknown) {
      cards.push(card);
      return `${SPACE}/messages/card`;
    },
    async updateMessageCards(_n: string, card: unknown) {
      cards.push(card);
    },
  } as never;
  const topicCards: { key: string; messageName: string }[] = [];
  const state = {
    setTopicCard(key: string, value: { messageName: string }) {
      topicCards.push({ key, messageName: value.messageName });
    },
  } as never;
  return { host, seam, router, client, state, sent, cards, topicCards };
}

/** A `/model` typed as a message. */
function modelCommand(threadName?: string): IncomingMessage {
  return {
    eventType: "MESSAGE",
    space: { name: SPACE },
    message: { name: `${SPACE}/messages/m1`, text: "/model", ...(threadName ? { threadName } : {}) },
  };
}

/**
 * A model pick. `eventThread` is the thread Chat reports on the click; pass
 * undefined for the common case where it reports none.
 */
function modelPick(options: {
  actionKey: string;
  eventThread?: string;
  picked?: string;
  action?: string;
  formInputs?: Record<string, unknown>;
}): IncomingMessage {
  return {
    eventType: "CARD_CLICKED",
    space: { name: SPACE },
    message: { name: `${SPACE}/messages/card`, ...(options.eventThread ? { threadName: options.eventThread } : {}) },
    action: {
      actionMethodName: options.action ?? MODEL_ACTION,
      parameters: [
        { key: "mode", value: "model" },
        { key: "session", value: options.actionKey },
      ],
      formInputs:
        (options.formInputs as never) ??
        ({
          model_picker: { selectionInput: { selectedValues: [options.picked ?? "deepseek|flash"] } },
        } as never),
    },
  };
}

async function run(ctx: Awaited<ReturnType<typeof setup>>, incoming: IncomingMessage, chatThread?: string) {
  const chatKey = chatThread ?? incoming.message.threadName ?? SPACE;
  const actionKey =
    incoming.action?.parameters?.find((p) => p.key === "session")?.value ?? chatKey;
  return runDurableCommand({
    client: ctx.client,
    seam: ctx.seam,
    router: ctx.router,
    state: ctx.state,
    incoming,
    chatKey,
    actionKey,
    spaceName: SPACE,
    threadName: chatThread,
    display: "test",
    text: incoming.message.text ?? "",
  });
}

const boundConversation = async (host: BridgeHost, key: string) => (await host.bindingFor(key))?.conversationId;

test("switching in an existing thread switches it and creates nothing", async () => {
  const ctx = await setup();
  const before = await startConversation(ctx.seam, THREAD_A, { model: { provider: "deepseek", modelId: "flash" } });

  await run(ctx, modelPick({ actionKey: THREAD_A, eventThread: THREAD_A, picked: "llama-local|small" }), THREAD_A);

  const status = await conversationStatus(ctx.seam, THREAD_A);
  assert.equal(status.conversationId, before.conversationId, "no new conversation");
  assert.equal(status.model, "llama-local/small");
});

test("a pick in a thread with no conversation starts it there, with or without an event thread", async () => {
  for (const eventThread of [THREAD_A, undefined]) {
    const ctx = await setup();
    await run(ctx, modelPick({ actionKey: THREAD_A, eventThread }), THREAD_A);

    const bound = await boundConversation(ctx.host, THREAD_A);
    assert.ok(bound, `bound to ${THREAD_A} (eventThread=${eventThread ?? "absent"})`);
    assert.equal(await boundConversation(ctx.host, SPACE), undefined, "must not fall back to the space");
    // The next message in that thread must find the conversation the pick started.
    const status = await conversationStatus(ctx.seam, THREAD_A);
    assert.equal(status.model, "deepseek/flash");
  }
});

test("a pick at top level (no thread) binds to the space", async () => {
  for (const eventThread of [undefined, SPACE]) {
    const ctx = await setup();
    // /model typed at top level, so the card carries the space key.
    await run(ctx, modelPick({ actionKey: SPACE, eventThread }), undefined);
    assert.ok(await boundConversation(ctx.host, SPACE), `bound to the space (eventThread=${eventThread ?? "absent"})`);
    assert.equal(await boundConversation(ctx.host, THREAD_A), undefined);
  }
});

test("switching one thread leaves its siblings alone", async () => {
  const ctx = await setup();
  const a = await startConversation(ctx.seam, THREAD_A, { model: { provider: "deepseek", modelId: "flash" } });
  const b = await startConversation(ctx.seam, THREAD_B, { model: { provider: "deepseek", modelId: "flash" } });

  await run(ctx, modelPick({ actionKey: THREAD_A, eventThread: THREAD_A, picked: "llama-local|small" }), THREAD_A);

  const afterA = await conversationStatus(ctx.seam, THREAD_A);
  const afterB = await conversationStatus(ctx.seam, THREAD_B);
  assert.equal(afterA.model, "llama-local/small");
  assert.equal(afterB.model, "deepseek/flash", "thread B keeps its model");
  assert.equal(afterB.conversationId, b.conversationId);
  assert.notEqual(a.conversationId, b.conversationId);
});

test("re-rendering the card for a new model never creates a conversation", async () => {
  const ctx = await setup();
  await run(
    ctx,
    modelPick({
      actionKey: THREAD_A,
      eventThread: THREAD_A,
      action: THINKING_LEVELS_ACTION,
      formInputs: { model_picker: { selectionInput: { selectedValues: ["llama-local|small"] } } },
    }),
    THREAD_A,
  );
  assert.equal(await boundConversation(ctx.host, THREAD_A), undefined);
  assert.equal(await boundConversation(ctx.host, SPACE), undefined);
  assert.equal(ctx.cards.length, 1, "the card was re-rendered in place");
});

test("a stale pick on an existing conversation still switches, not creates", async () => {
  const ctx = await setup();
  const existing = await startConversation(ctx.seam, THREAD_A, { model: { provider: "deepseek", modelId: "flash" } });
  // Clicked twice, as a user does when the first click seems not to take.
  await run(ctx, modelPick({ actionKey: THREAD_A, eventThread: THREAD_A, picked: "llama-local|small" }), THREAD_A);
  await run(ctx, modelPick({ actionKey: THREAD_A, eventThread: THREAD_A, picked: "deepseek|flash" }), THREAD_A);

  const status = await conversationStatus(ctx.seam, THREAD_A);
  assert.equal(status.conversationId, existing.conversationId);
  assert.equal(status.model, "deepseek/flash");
});

test("starting a conversation from the picker records the card for topic titling", async () => {
  const ctx = await setup();
  await run(ctx, modelPick({ actionKey: THREAD_A, eventThread: THREAD_A }), THREAD_A);
  assert.equal(ctx.topicCards.length, 1);
  assert.equal(ctx.topicCards[0]?.key, THREAD_A);
  assert.match(ctx.sent[0] ?? "", /Starting a new conversation/);
});
