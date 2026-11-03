/**
 * Who is allowed to reach the secret store.
 *
 * Two separate gates, because they cover different frontends and the audit that
 * prompted this file found the first one open:
 *
 *   1. The Pub/Sub receiver checked `ALLOWED_USERS` only on MESSAGE events. A
 *      CARD_CLICKED was bounded by space alone, on the assumption that clicking
 *      a card the bridge posted runs no tools — true before `/secret` existed,
 *      false after, because a click now opens a card that stores a secret.
 *   2. `/secret` itself had no operator gate. Anyone who could talk to the bot
 *      could list secret names and tails.
 *
 * The `/web` path matters here: a browser submission has no Chat sender at all
 * (Cloudflare injects an email and that is the whole identity), so a receiver
 * check alone would leave `/secret` open over the tunnel.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { createModels, type Model } from "@earendil-works/pi-ai/models";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { BridgeHost } from "../src/durable/host.js";
import { DurableRouter } from "../src/adapter/router.js";
import { runDurableCommand } from "../src/adapter/commands.js";
import { SECRET_ACTION, SET_SECRET_ACTION } from "../src/constants.js";
import { SecretStore } from "../src/secret-store.js";
import type { IncomingMessage } from "../src/types.js";

const SPACE = "spaces/S";
const THREAD = "spaces/S/threads/T";
const KEY = "sk-live-abcdefghijklmnop";
const OPERATOR = "users/operator";
const STRANGER = "users/stranger";

function modelRuntime(): ModelRuntime {
  const models: Record<string, Model<any>> = {
    "deepseek/flash": {
      provider: "deepseek",
      id: "flash",
      name: "flash",
      api: "openai-completions",
      reasoning: true,
      input: ["text"],
      contextWindow: 1000,
      outputWindow: 100,
    } as Model<any>,
  };
  return {
    getModel: (p: string, m: string) => models[`${p}/${m}`],
    getAllAvailable: async () => Object.values(models).map((model) => ({ ...model, type: "chat" })),
  } as unknown as ModelRuntime;
}

async function setup(secretUsers?: string[]) {
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: createModels(), registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  const host = Object.create(BridgeHost.prototype) as BridgeHost;
  Object.assign(host, { harness, context: BACKGROUND_CONTEXT, modelRuntime: modelRuntime(), cwd: "/tmp" });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bridge-secret-auth-"));
  const secrets = new SecretStore(path.join(dir, "secrets.json"));
  secrets.set("EXISTING_KEY", "existing-value-here", "operator@example.com");

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

  const router = new DurableRouter(host, { model: { provider: "deepseek", modelId: "flash" } });
  return { host, router, client, secrets, sent, cards, secretUsers };
}

async function run(
  ctx: Awaited<ReturnType<typeof setup>>,
  incoming: IncomingMessage,
  display: string,
) {
  return runDurableCommand({
    client: ctx.client,
    host: ctx.host,
    router: ctx.router,
    state: {} as never,
    secrets: ctx.secrets,
    secretUsers: ctx.secretUsers,
    incoming,
    chatKey: THREAD,
    actionKey: THREAD,
    spaceName: SPACE,
    threadName: THREAD,
    display,
    text: incoming.message.text ?? "",
  });
}

function message(text: string): IncomingMessage {
  return {
    eventType: "MESSAGE",
    space: { name: SPACE },
    message: { name: `${SPACE}/messages/m1`, text, threadName: THREAD },
  };
}

function valueSubmission(name: string, value: string): IncomingMessage {
  return {
    eventType: "CARD_CLICKED",
    space: { name: SPACE },
    message: { name: `${SPACE}/messages/card`, threadName: THREAD },
    action: {
      actionMethodName: SET_SECRET_ACTION,
      parameters: [{ key: "name", value: name }],
      formInputs: { secret_value: { stringInputs: { value: [value] } } },
    },
  };
}

function addClick(name: string): IncomingMessage {
  return {
    eventType: "CARD_CLICKED",
    space: { name: SPACE },
    message: { name: `${SPACE}/messages/card` },
    action: { actionMethodName: SECRET_ACTION, parameters: [{ key: "name", value: name }] },
  };
}

// --- /secret slash command ---------------------------------------------------

test("an empty SECRET_USERS list places no extra restriction", async () => {
  const ctx = await setup([]);
  await run(ctx, message("/secret"), STRANGER);
  assert.match(JSON.stringify(ctx.cards.at(-1)), /EXISTING_KEY/);
});

test("an authorised operator can list", async () => {
  const ctx = await setup([OPERATOR]);
  await run(ctx, message("/secret"), OPERATOR);
  assert.match(JSON.stringify(ctx.cards.at(-1)), /EXISTING_KEY/);
});

test("an unauthorised user is refused and learns nothing about the store", async () => {
  const ctx = await setup([OPERATOR]);
  await run(ctx, message("/secret"), STRANGER);
  const reply = ctx.sent.join("\n");
  assert.match(reply, /not allowed/);
  // No names, no tails, no counts: the refusal must not be an inventory leak.
  assert.equal(reply.includes("EXISTING_KEY"), false);
  assert.equal(reply.includes("••••"), false);
});

test("an unauthorised user cannot store a value through the command", async () => {
  const ctx = await setup([OPERATOR]);
  await run(ctx, message("/secret set NEW_KEY"), STRANGER);
  assert.equal(ctx.cards.length, 0, "a value card must not be posted to a stranger");
  assert.match(ctx.sent.join("\n"), /not allowed/);
});

test("an authorised operator can post a value card", async () => {
  const ctx = await setup([OPERATOR]);
  await run(ctx, message("/secret set NEW_KEY"), OPERATOR);
  assert.match(JSON.stringify(ctx.cards.at(-1)), /secret_value/);
});

test("an unauthorised user cannot remove a secret", async () => {
  const ctx = await setup([OPERATOR]);
  await run(ctx, message("/secret remove EXISTING_KEY"), STRANGER);
  // Still there.
  assert.deepEqual(
    ctx.secrets.list().map((s) => s.name),
    ["EXISTING_KEY"],
  );
});

test("the gate matches on the trailing id, like every other allow-list", async () => {
  const ctx = await setup(["operator"]);
  await run(ctx, message("/secret"), "users/operator");
  assert.match(JSON.stringify(ctx.cards.at(-1)), /EXISTING_KEY/);
});

// --- Card actions ------------------------------------------------------------

test("an unauthorised click on the add button is refused", async () => {
  const ctx = await setup([OPERATOR]);
  await run(ctx, addClick("NEW_KEY"), STRANGER);
  const card = JSON.stringify(ctx.cards.at(-1));
  assert.match(card, /Not allowed/);
  // Crucially, the value card was not rendered — no input to type into.
  assert.equal(card.includes("secret_value"), false);
});

test("an unauthorised value submission stores nothing", async () => {
  const ctx = await setup([OPERATOR]);
  await run(ctx, valueSubmission("NEW_KEY", KEY), STRANGER);
  const names = ctx.secrets.list().map((s) => s.name);
  assert.equal(names.includes("NEW_KEY"), false);
  assert.match(JSON.stringify(ctx.cards.at(-1)), /Not allowed/);
});

test("an authorised click on the add button renders the value card", async () => {
  const ctx = await setup([OPERATOR]);
  await run(ctx, addClick("NEW_KEY"), OPERATOR);
  assert.match(JSON.stringify(ctx.cards.at(-1)), /secret_value/);
});

test("an authorised value submission stores the secret", async () => {
  const ctx = await setup([OPERATOR]);
  await run(ctx, valueSubmission("NEW_KEY", KEY), OPERATOR);
  assert.equal(
    ctx.secrets.list().some((s) => s.name === "NEW_KEY"),
    true,
  );
});

test("the web path is gated too: a Cloudflare email is the whole identity", async () => {
  // A `/web` submission never has a Chat sender, so a receiver-only check
  // would leave this open over the tunnel. `display` is the email.
  const ctx = await setup(["operator@example.com"]);
  await run(ctx, message("/secret"), "stranger@example.com");
  assert.match(ctx.sent.join("\n"), /not allowed/);
  await run(ctx, message("/secret"), "operator@example.com");
  assert.match(JSON.stringify(ctx.cards.at(-1)), /EXISTING_KEY/);
});
