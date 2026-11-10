/**
 * `/secret` — the card path that keeps a secret out of the conversation.
 *
 * The claim being tested is narrow and specific: **the value never becomes
 * message text**. It is typed into a card, arrives as `stringInputs`, and is
 * consumed by `runDurableCommand()` before `router.deliver()` is ever reached.
 * If any assertion here fails by finding the value in `sent`, the design has
 * collapsed into "paste your key into chat", which is the thing it exists to
 * avoid.
 *
 * The second claim is that no reply leaks it either: `/secret` listing shows a
 * tail and a name, and the confirmation names the secret without quoting it.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
// `Model` lives on the package root; `./models` only carries the registry.
import type { Model } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { BridgeHost } from "../src/durable/host.js";
import { inProcessSessionHost } from "../src/session-host/inprocess.js";
import { DurableRouter } from "../src/adapter/router.js";
import { runDurableCommand } from "../src/adapter/commands.js";
import { REMOVE_SECRET_ACTION, SECRET_ACTION, SET_SECRET_ACTION } from "../src/constants.js";
import { SecretStore } from "../src/secret-store.js";
import type { IncomingMessage } from "../src/types.js";

const SPACE = "spaces/S";
const THREAD = "spaces/S/threads/T";
const KEY = "sk-live-abcdefghijklmnop";

function modelRuntime(): ModelRuntime {
  const models: Record<string, Model<any>> = {
    "deepseek/flash": {
      provider: "deepseek",
      id: "flash",
      name: "flash",
      api: "openai-completions",
      baseUrl: "https://example.invalid",
      reasoning: true,
      input: ["text"],
      contextWindow: 1000,
      maxTokens: 100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    } as Model<any>,
  };
  return {
    getModel: (p: string, m: string) => models[`${p}/${m}`],
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
    cwd: "/tmp",
    // `/engine` reports the store path; the real host always has one.
    dbPath: path.join(os.tmpdir(), "bridge.sqlite"),
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bridge-secret-cmd-"));
  const secrets = new SecretStore(path.join(dir, "secrets.json"));

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

  const seam = inProcessSessionHost({ host, roots: [] });

  const router = new DurableRouter(seam, { model: { provider: "deepseek", modelId: "flash" } });
  const state = { setTopicCard() {} } as never;
  return { host, seam, router, client, state, secrets, sent, cards, dir };
}

/** A `/secret ...` typed as a message. */
function secretMessage(text: string): IncomingMessage {
  return {
    eventType: "MESSAGE",
    space: { name: SPACE },
    message: { name: `${SPACE}/messages/m1`, text, threadName: THREAD },
  };
}

/** The card submission carrying a value, as Chat delivers it. */
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

async function run(ctx: Awaited<ReturnType<typeof setup>>, incoming: IncomingMessage) {
  return runDurableCommand({
    client: ctx.client,
    seam: ctx.seam,
    router: ctx.router,
    state: ctx.state,
    secrets: ctx.secrets,
    incoming,
    chatKey: THREAD,
    actionKey: THREAD,
    spaceName: SPACE,
    threadName: THREAD,
    display: "alice@example.com",
    text: incoming.message.text ?? "",
  });
}

// --- Storing -----------------------------------------------------------------

test("a card submission stores the value without ever putting it in a reply", async () => {
  const ctx = await setup();
  const handled = await run(ctx, valueSubmission("STRIPE_KEY", KEY));
  assert.equal(handled, "ok");

  // Stored, readable by the registry...
  assert.deepEqual(ctx.secrets.registrySecrets(), [{ name: "STRIPE_KEY", value: KEY }]);
  // ...and absent from every outbound message and card.
  const outbound = JSON.stringify({ sent: ctx.sent, cards: ctx.cards });
  assert.equal(outbound.includes(KEY), false, "the value appeared in an outbound message");
});

test("the confirmation names the secret but does not quote it", async () => {
  const ctx = await setup();
  await run(ctx, valueSubmission("STRIPE_KEY", KEY));
  const last = ctx.cards.at(-1);
  assert.equal(JSON.stringify(last).includes("STRIPE_KEY"), true);
  assert.equal(JSON.stringify(last).includes(KEY), false);
});

test("a value too short to redact is refused, and nothing is stored", async () => {
  const ctx = await setup();
  await run(ctx, valueSubmission("PIN", "123"));
  assert.deepEqual(ctx.secrets.list(), []);
  assert.match(JSON.stringify(ctx.cards.at(-1)), /too short/);
});

test("a multi-line value is refused with the file workaround", async () => {
  const ctx = await setup();
  await run(ctx, valueSubmission("PEM_KEY", `-----BEGIN-----\nabc\n-----END-----`));
  assert.deepEqual(ctx.secrets.list(), []);
  assert.match(JSON.stringify(ctx.cards.at(-1)), /single-line/);
});

test("an unusable name is refused", async () => {
  const ctx = await setup();
  await run(ctx, valueSubmission("bad-name", KEY));
  assert.deepEqual(ctx.secrets.list(), []);
  assert.match(JSON.stringify(ctx.cards.at(-1)), /not a usable name/);
});

test("a hostile name cannot escape the store", async () => {
  const ctx = await setup();
  // Would be a path or an env var injection if it were accepted anywhere.
  for (const name of ["../../etc/passwd", "A;rm -rf /", "PATH"]) {
    await run(ctx, valueSubmission(name, KEY));
    assert.deepEqual(ctx.secrets.list(), [], name);
  }
});

test("without a store the command reports it rather than pretending", async () => {
  const ctx = await setup();
  const handled = await runDurableCommand({
    client: ctx.client,
    seam: ctx.seam,
    router: ctx.router,
    state: ctx.state,
    // no `secrets`
    incoming: valueSubmission("STRIPE_KEY", KEY),
    chatKey: THREAD,
    actionKey: THREAD,
    spaceName: SPACE,
    threadName: THREAD,
    display: "alice",
    text: "",
  });
  assert.equal(handled, "ok");
  assert.match(JSON.stringify(ctx.cards.at(-1)), /No secret store/);
});

// --- Listing and removing ----------------------------------------------------

test("/secret posts a card listing names and a tail, never a value", async () => {
  const ctx = await setup();
  await run(ctx, valueSubmission("STRIPE_KEY", KEY));

  await run(ctx, secretMessage("/secret"));
  // A card, not a text reply: a text listing looks like any other answer the
  // bot posts and gives no evidence that /secret is bridge-handled.
  const card = JSON.stringify(ctx.cards.at(-1));
  assert.match(card, /secret-panel/);
  assert.match(card, /STRIPE_KEY/);
  assert.match(card, /••••/);
  assert.equal(card.includes(KEY), false, "the value must not reach the panel");
});

test("/secret with nothing stored still posts the panel", async () => {
  const ctx = await setup();
  await run(ctx, secretMessage("/secret"));
  // The empty state must be a card too: the panel is how a value gets entered,
  // so hiding it when empty would leave no discoverable way in.
  const card = JSON.stringify(ctx.cards.at(-1));
  assert.match(card, /secret-panel/);
  assert.match(card, /No secrets stored yet/);
  assert.match(card, /secret_name/);
});

test("/secret set posts a value card", async () => {
  const ctx = await setup();
  await run(ctx, secretMessage("/secret set MY_TOKEN"));
  const card = JSON.stringify(ctx.cards.at(-1));
  assert.match(card, /MY_TOKEN/);
  assert.match(card, /secret_value/);
});

test("/secret set with an invalid name explains the rule", async () => {
  const ctx = await setup();
  await run(ctx, secretMessage("/secret set 9BAD"));
  assert.match(ctx.sent.join("\n"), /not a usable name/);
});

test("/secret remove deletes and reports", async () => {
  const ctx = await setup();
  await run(ctx, valueSubmission("STRIPE_KEY", KEY));
  await run(ctx, secretMessage("/secret remove STRIPE_KEY"));
  assert.deepEqual(ctx.secrets.list(), []);
  assert.match(ctx.sent.join("\n"), /Removed/);
});

test("/secret remove on a missing name says so, and is not an error", async () => {
  const ctx = await setup();
  await run(ctx, secretMessage("/secret remove NOPE"));
  assert.match(ctx.sent.join("\n"), /No stored secret/);
});

test("an unknown /secret verb shows usage instead of guessing", async () => {
  const ctx = await setup();
  await run(ctx, secretMessage("/secret frobnicate"));
  assert.match(ctx.sent.join("\n"), /Usage/);
});

// --- The card-action path ----------------------------------------------------

test("the add-card action re-renders the same message as a value card", async () => {
  const ctx = await setup();
  const incoming: IncomingMessage = {
    eventType: "CARD_CLICKED",
    space: { name: SPACE },
    message: { name: `${SPACE}/messages/card` },
    action: { actionMethodName: SECRET_ACTION, parameters: [{ key: "name", value: "my_token" }] },
  };
  await run(ctx, incoming);
  const card = JSON.stringify(ctx.cards.at(-1));
  // Normalised to upper case, and the value card is what comes back.
  assert.match(card, /MY_TOKEN/);
  assert.match(card, /secret_value/);
});

test("the add-card action rejects a reserved name", async () => {
  const ctx = await setup();
  const incoming: IncomingMessage = {
    eventType: "CARD_CLICKED",
    space: { name: SPACE },
    message: { name: `${SPACE}/messages/card` },
    action: { actionMethodName: SECRET_ACTION, parameters: [{ key: "name", value: "PATH" }] },
  };
  await run(ctx, incoming);
  assert.match(JSON.stringify(ctx.cards.at(-1)), /not a usable name/);
});

// --- Message formatting ------------------------------------------------------

/**
 * `sendMessage` sends `markupSyntax: MARKDOWN`, so HTML tags are rendered
 * literally. A `/secret` listing shipped with `<b>` and `<code>` in it and
 * arrived as the text "<b>Stored secrets</b>" in Chat — verified in a
 * screenshot before this test existed.
 *
 * Every other text command had the same bug, so the check covers the whole
 * command layer rather than just `/secret`.
 */
test("no text reply uses HTML tags, which Markdown mode renders literally", async () => {
  const ctx = await setup();
  await run(ctx, valueSubmission("STRIPE_KEY", KEY));
  await run(ctx, secretMessage("/secret"));
  await run(ctx, secretMessage("/secret set 9BAD"));
  await run(ctx, secretMessage("/session"));
  await run(ctx, secretMessage("/engine"));

  assert.ok(ctx.sent.length > 0, "expected some text replies");
  for (const text of ctx.sent) {
    assert.equal(
      /<\/?(b|i|code|br|u|s)\b/i.test(text),
      false,
      `HTML tag in a Markdown message: ${text.slice(0, 120)}`,
    );
  }
});

test("the panel explains that values bypass the model", async () => {
  const ctx = await setup();
  await run(ctx, secretMessage("/secret"));
  const card = JSON.stringify(ctx.cards.at(-1));
  // The operator-facing promise, stated where a key is about to be typed.
  assert.match(card, /never/);
  assert.match(card, /model/);
});

// --- The panel's own controls ------------------------------------------------

/** The panel's "Enter value on a card" button, name typed into the text input. */
function panelAdd(typedName: string): IncomingMessage {
  return {
    eventType: "CARD_CLICKED",
    space: { name: SPACE },
    message: { name: `${SPACE}/messages/card`, threadName: THREAD },
    action: {
      actionMethodName: SECRET_ACTION,
      formInputs: { secret_name: { stringInputs: { value: [typedName] } } },
    },
  };
}

function removeClick(picked?: string): IncomingMessage {
  return {
    eventType: "CARD_CLICKED",
    space: { name: SPACE },
    message: { name: `${SPACE}/messages/card`, threadName: THREAD },
    action: {
      actionMethodName: REMOVE_SECRET_ACTION,
      ...(picked ? { formInputs: { secret_remove_picker: { selectionInput: { selectedValues: [picked] } } } } : {}),
    },
  };
}

test("a name typed into the panel opens the value card", async () => {
  const ctx = await setup();
  await run(ctx, panelAdd("my_token"));
  const card = JSON.stringify(ctx.cards.at(-1));
  assert.match(card, /MY_TOKEN/);
  assert.match(card, /secret_value/);
});

test("the panel refuses a reserved name typed into it", async () => {
  const ctx = await setup();
  await run(ctx, panelAdd("PATH"));
  assert.match(JSON.stringify(ctx.cards.at(-1)), /not a usable name/);
});

test("the Remove button renders a picker without deleting anything", async () => {
  const ctx = await setup();
  await run(ctx, valueSubmission("STRIPE_KEY", KEY));
  await run(ctx, removeClick());
  const card = JSON.stringify(ctx.cards.at(-1));
  assert.match(card, /secret-remove/);
  assert.match(card, /STRIPE_KEY/);
  // Nothing removed yet — the button only opens the picker.
  assert.equal(
    ctx.secrets.list().some((s) => s.name === "STRIPE_KEY"),
    true,
  );
});

test("Remove with a picked name deletes it", async () => {
  const ctx = await setup();
  await run(ctx, valueSubmission("STRIPE_KEY", KEY));
  await run(ctx, removeClick("STRIPE_KEY"));
  assert.equal(
    ctx.secrets.list().some((s) => s.name === "STRIPE_KEY"),
    false,
  );
  assert.match(JSON.stringify(ctx.cards.at(-1)), /Removed/);
});

test("Remove of an unknown name reports rather than throwing", async () => {
  const ctx = await setup();
  await run(ctx, removeClick("NOPE"));
  assert.match(JSON.stringify(ctx.cards.at(-1)), /no such secret/);
});

test("Remove with nothing stored says so instead of an empty picker", async () => {
  const ctx = await setup();
  await run(ctx, removeClick());
  assert.match(JSON.stringify(ctx.cards.at(-1)), /No secrets stored/);
});
