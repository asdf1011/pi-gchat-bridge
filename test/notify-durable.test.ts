/**
 * Durable /notify tests: the parts that must not regress when the engine
 * changes — idempotency, and the promise that a rejected candidate is never
 * posted.
 *
 * The model-driven validation run is deliberately not exercised here (it needs a
 * provider); the verdict record is pre-seeded instead, which is exactly the state
 * a previous run leaves behind and the input the retry path reads.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { BridgeHost } from "../src/durable/host.js";
import { handleDurableNotify, VerdictsDoc } from "../src/durable/notify.js";
import type { DurableRouter } from "../src/adapter/router.js";

function fakeClient() {
  const posted: string[] = [];
  return {
    posted,
    client: {
      async createMessageWithThreadKey(_space: string, text: string, key: string) {
        posted.push(text);
        return { name: `spaces/s/messages/${posted.length}`, threadName: `spaces/s/threads/${key}` };
      },
      async createMessage(_space: string, text: string) {
        posted.push(text);
        return `spaces/s/messages/${posted.length}`;
      },
    } as never,
  };
}

/** Records what would be written into the conversation, without a harness write. */
function fakeRouter() {
  const notices: { chatKey: string; text: string }[] = [];
  return {
    notices,
    router: {
      async notify(chatKey: string, text: string) {
        notices.push({ chatKey, text });
      },
      async deliver() {
        throw new Error("validation should not reach the model in these tests");
      },
    } as unknown as DurableRouter,
  };
}

async function host() {
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: createModels(), registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  const fake = Object.create(BridgeHost.prototype) as BridgeHost;
  Object.assign(fake, { harness, context: BACKGROUND_CONTEXT, modelRuntime: {} as ModelRuntime });
  return fake;
}

const agent = { model: { provider: "llama-local", modelId: "small" } };

async function seedVerdict(h: BridgeHost, chatKey: string, entry: Record<string, unknown>) {
  await h.harness.commit(async (tx) => {
    const doc = await tx.doc(VerdictsDoc);
    doc.byThreadKey[chatKey] = { at: Date.now(), ...entry };
  }, h.context);
}

test("a plain notification is posted and recorded as conversation context", async () => {
  const h = await host();
  const { client, posted } = fakeClient();
  const { router, notices } = fakeRouter();

  const result = await handleDurableNotify(
    { client, host: h, router, defaultAgent: agent },
    { space: "spaces/s", text: "disk is 94% full", threadKey: "t1", title: "Disk alert" },
    undefined,
  );

  assert.equal(result.status, 200);
  assert.equal(result.json.status, "posted");
  assert.equal(result.json.seeded, true);
  assert.deepEqual(posted, ["disk is 94% full"]);
  // Seeded as a write on the thread's conversation, title included as context.
  assert.equal(notices.length, 1);
  assert.equal(notices[0]?.chatKey, "spaces/s/t1");
  assert.match(notices[0]?.text ?? "", /Disk alert/);
});

test("a plain notification without a threadKey is posted but not seeded", async () => {
  const h = await host();
  const { client, posted } = fakeClient();
  const { router, notices } = fakeRouter();

  const result = await handleDurableNotify(
    { client, host: h, router, defaultAgent: agent },
    { space: "spaces/s", text: "hello" },
    undefined,
  );

  assert.equal(result.status, 200);
  assert.equal(result.json.seeded, false);
  assert.equal(posted.length, 1);
  assert.equal(notices.length, 0);
});

test("a recorded NO verdict is never posted again", async () => {
  const h = await host();
  const { client, posted } = fakeClient();
  const { router } = fakeRouter();
  await seedVerdict(h, "spaces/s/t9", { verdict: "NO", reason: "not an invitation" });

  const result = await handleDurableNotify(
    { client, host: h, router, defaultAgent: agent },
    { space: "spaces/s", text: "candidate", threadKey: "t9", validation: { prompt: "is this an invitation?" } },
    undefined,
  );

  assert.equal(result.status, 200);
  assert.equal(result.json.status, "skipped");
  assert.equal(result.json.verdict, "NO");
  assert.equal(posted.length, 0, "a rejected candidate must not reach Chat");
});

test("an already-posted verdict does not post twice", async () => {
  const h = await host();
  const { client, posted } = fakeClient();
  const { router } = fakeRouter();
  await seedVerdict(h, "spaces/s/t8", { verdict: "YES", notificationPosted: true, messageName: "spaces/s/messages/1" });

  const result = await handleDurableNotify(
    { client, host: h, router, defaultAgent: agent },
    { space: "spaces/s", text: "candidate", threadKey: "t8", validation: { prompt: "is this an invitation?" } },
    undefined,
  );

  assert.equal(result.status, 200);
  assert.equal(result.json.status, "already_posted");
  assert.equal(result.json.messageName, "spaces/s/messages/1");
  assert.equal(posted.length, 0);
});

test("validation requires a threadKey, and bad auth is rejected", async () => {
  const h = await host();
  const { client } = fakeClient();
  const { router } = fakeRouter();

  const missingKey = await handleDurableNotify(
    { client, host: h, router, defaultAgent: agent },
    { space: "spaces/s", text: "x", validation: { prompt: "p" } },
    undefined,
  );
  assert.equal(missingKey.status, 400);

  const badAuth = await handleDurableNotify(
    { client, host: h, router, defaultAgent: agent, notifyToken: "secret" },
    { space: "spaces/s", text: "x" },
    "Bearer wrong",
  );
  assert.equal(badAuth.status, 401);

  const okAuth = await handleDurableNotify(
    { client, host: h, router, defaultAgent: agent, notifyToken: "secret" },
    { space: "spaces/s", text: "x" },
    "Bearer secret",
  );
  assert.equal(okAuth.status, 200);
});
