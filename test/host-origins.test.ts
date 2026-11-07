/**
 * Origins at the host: which surface an entry came from, recorded and read back.
 *
 * A fake would prove the plumbing; these drive a real harness on in-memory storage,
 * because the interesting part is *which entry* gets stamped — it is found, not
 * handed over, and "the newest user entry with no stamp yet" is the rule that has to
 * survive restarts and steers.
 *
 * The conservative reading is the point: an entry with no origin must come back as
 * no origin, never as a default. Everything downstream (`delivery-pass.ts`) decides
 * from the absence.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { BridgeHost } from "../src/durable/host.js";

async function memoryHost(): Promise<BridgeHost> {
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: createModels(), registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  harness.resume();
  const host = Object.create(BridgeHost.prototype) as BridgeHost;
  Object.assign(host, {
    harness,
    context: BACKGROUND_CONTEXT,
    modelRuntime: { getModel: () => undefined, getModels: () => [], getAllAvailable: async () => [] } as unknown as ModelRuntime,
    cwd: "/tmp",
    dbPath: ":memory:",
    pending: new Map(),
  });
  return host;
}

/** A conversation with one user entry, as a submission would leave it. */
async function withPrompt(host: BridgeHost, text = "can you check the build") {
  const created = await host.createNamed(`threads/${text.length}`, { model: { provider: "p", modelId: "m" } });
  await host.writeEntry(created.conversationId, {
    kind: "app.notice",
    data: {},
    model: [{ role: "user", content: text }],
  });
  return created.conversationId;
}

test("an entry with no stamp comes back with no origin, not a default", async () => {
  const host = await memoryHost();
  const conversationId = await withPrompt(host);
  const history = await host.history(conversationId, 10, 0);
  assert.equal(history?.length, 1);
  assert.equal(history?.[0]?.origin, undefined, "unknown must be absent, not 'mine'");
});

test("recording an origin stamps the newest unstamped user entry", async () => {
  const host = await memoryHost();
  const conversationId = await withPrompt(host);

  assert.equal(await host.recordOrigin(conversationId, 41, "webui"), true);
  const history = await host.history(conversationId, 10, 0);
  assert.equal(history?.[0]?.origin, "webui");

  // A second submission stamps the *next* entry, not the first one again — the rule
  // has to hold for a conversation that keeps talking.
  await host.writeEntry(conversationId, {
    kind: "app.notice",
    data: {},
    model: [{ role: "user", content: "and the tests" }],
  });
  assert.equal(await host.recordOrigin(conversationId, 42, "gchat"), true);
  const after = await host.history(conversationId, 10, 0);
  assert.deepEqual(after?.map((message) => message.origin), ["webui", "gchat"]);
});

test("two surfaces in one conversation are told apart", async () => {
  const host = await memoryHost();
  const conversationId = await withPrompt(host);
  await host.recordOrigin(conversationId, 51, "webui");

  await host.writeEntry(conversationId, {
    kind: "app.notice",
    data: {},
    model: [{ role: "assistant", content: [{ type: "text", text: "the build passes" }] }],
  });
  // The answer inherits the prompt's surface: it belongs to whoever asked, which is
  // not the same question as who is reading. `awaitSubmission` does this in
  // production; the write here is direct, so the stamp is called for directly too.
  const answerEntryId = (await host.history(conversationId, 10, 0))?.find(
    (message) => message.role === "assistant",
  )?.entryId;
  assert.ok(answerEntryId !== undefined, "the answer has an entry id");
  assert.equal(await host.recordAnswerOrigin(conversationId, answerEntryId, 51), true);
  await host.writeEntry(conversationId, {
    kind: "app.notice",
    data: {},
    model: [{ role: "user", content: "typing in chat now" }],
  });
  await host.recordOrigin(conversationId, 52, "gchat");

  const history = await host.history(conversationId, 10, 0);
  assert.deepEqual(
    history?.map((message) => [message.role, message.origin]),
    [
      ["user", "webui"],
      ["assistant", "webui"],
      ["user", "gchat"],
    ],
  );
});

test("a conversation with nothing to stamp reports false rather than throwing", async () => {
  const host = await memoryHost();
  const created = await host.createNamed("threads/empty", { model: { provider: "p", modelId: "m" } });
  assert.equal(await host.recordOrigin(created.conversationId, 61, "webui"), false);
  // And an unknown conversation is the same story, not an exception.
  assert.equal(await host.recordOrigin(999_999, 62, "webui"), false);
});

test("an answer with no recorded prompt surface is stamped, as unknown provenance", async () => {
  // The stamp does two jobs: which surface asked, and that this entry *is an answer*.
  // A turn's intermediate messages carry text too, so "is an answer" has to be
  // recorded rather than inferred — which means an answer is stamped even when the
  // prompt's surface was never recorded. The origin is then the literal `unknown`:
  // still an answer, of unknown provenance, and a reader can say both.
  const host = await memoryHost();
  const conversationId = await withPrompt(host);
  await host.writeEntry(conversationId, {
    kind: "app.notice",
    data: {},
    model: [{ role: "assistant", content: [{ type: "text", text: "the build passes" }] }],
  });
  const answerEntryId = (await host.history(conversationId, 10, 0))?.find(
    (message) => message.role === "assistant",
  )?.entryId;
  assert.ok(answerEntryId !== undefined);

  assert.equal(await host.recordAnswerOrigin(conversationId, answerEntryId, 999), true);
  const history = await host.history(conversationId, 10, 0);
  assert.deepEqual(
    history?.map((message) => [message.role, message.origin]),
    [
      ["user", undefined],
      ["assistant", "unknown"],
    ],
  );
});
