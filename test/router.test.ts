/**
 * Router tests: the message → submission contract.
 *
 * These are the rules that used to be hand-maintained in `AgentRouter` plus
 * `state.ts` (dedupe) and `pendingSteers` (steering), so each one is pinned here:
 * the Chat message name is the requestId, a message always steers when busy, and
 * a notification is a write rather than a run.
 *
 * The host is a structural fake. pi-durable's own dedupe and steer semantics are
 * the harness's, and are exercised for real in the CLI smoke against a live
 * model; what is tested here is that this code asks for them.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Context } from "@earendil-works/chord";

import {
  buildContent,
  DurableRouter,
  messageSubmission,
  noticeSubmission,
  type IncomingChatMessage,
} from "../src/adapter/router.js";
import type { BridgeHost } from "../src/durable/host.js";

const message = (over: Partial<IncomingChatMessage> = {}): IncomingChatMessage => ({
  chatKey: "spaces/sAAA/threads/T1",
  messageName: "spaces/sAAA/messages/m1",
  text: "hello",
  ...over,
});

const image = { type: "image" as const, data: "aGk=", mimeType: "image/png" };

test("the Chat message name becomes the requestId", () => {
  const draft = messageSubmission(message());
  assert.equal(draft.type, "input");
  assert.equal(draft.requestId, "spaces/sAAA/messages/m1");
});

test("a plain message is a bare string, no content blocks", () => {
  assert.equal(buildContent("hello"), "hello");
});

test("an image message becomes content blocks, text first", () => {
  const content = buildContent("what is this", [image]);
  assert.deepEqual(content, [
    { type: "text", text: "what is this" },
    { type: "image", data: "aGk=", mimeType: "image/png" },
  ]);
});

test("an image-only message has no empty text block", () => {
  const content = buildContent("", [image]);
  assert.deepEqual(content, [{ type: "image", data: "aGk=", mimeType: "image/png" }]);
});

test("a message always asks to steer: pi-durable ignores whenBusy when idle", () => {
  assert.equal(messageSubmission(message()).whenBusy, "steer");
});

test("a notification is a write with model content, never a run", () => {
  const draft = noticeSubmission("disk is 94% full", 1_700_000_000_000);
  assert.equal(draft.type, "write");
  const entry = (draft as { entry: { kind: string; data: unknown; model: unknown } }).entry;
  assert.equal(entry.kind, "app.notice");
  assert.deepEqual(entry.data, { text: "disk is 94% full", at: 1_700_000_000_000 });
  // Model content is what makes a later reply see the notice; without it the
  // entry would be display-only and invisible to the model.
  assert.deepEqual(entry.model, [
    { role: "user", content: "[notification] disk is 94% full", timestamp: 1_700_000_000_000 },
  ]);
});

/** Minimal structural stand-ins so the router can be driven without a harness. */
function fakeHost() {
  const submitted: unknown[] = [];
  const created: { chatKey: string; agent: unknown }[] = [];
  const aborts: number[] = [];
  const conversation = {
    id: 7,
    async submit(draft: unknown) {
      submitted.push(draft);
      return { id: submitted.length };
    },
    async abort() {
      aborts.push(7);
    },
  };
  const host = {
    context: {} as Context,
    harness: { conversation: async () => conversation },
    async bindingFor(key: string) {
      return key === "bound" ? { conversationId: 7, model: "m", createdAt: 0 } : undefined;
    },
    async conversationFor(chatKey: string, agent: unknown) {
      created.push({ chatKey, agent });
      return { conversation, binding: { conversationId: 7, model: "llama-local/x", createdAt: 0 } };
    },
  };
  return {
    host: host as unknown as BridgeHost,
    submitted,
    created,
    aborts,
  };
}

test("deliver() creates the conversation on the message's key and submits on it", async () => {
  const fake = fakeHost();
  const router = new DurableRouter(fake.host, { model: { provider: "llama-local", modelId: "x" } });
  const { submission } = await router.deliver(message());
  assert.equal((submission as { id: number }).id, 1);
  assert.equal(fake.created[0]?.chatKey, "spaces/sAAA/threads/T1");
  assert.equal(fake.submitted.length, 1);
});

test("interrupt() aborts the bound conversation, and does nothing for an unknown key", async () => {
  const fake = fakeHost();
  const router = new DurableRouter(fake.host, { model: { provider: "llama-local", modelId: "x" } });
  assert.equal(await router.interrupt("nothing-here"), false);
  assert.equal(await router.interrupt("bound"), true);
  assert.deepEqual(fake.aborts, [7]);
});

test("notify() submits a write on the key's conversation", async () => {
  const fake = fakeHost();
  const router = new DurableRouter(fake.host, { model: { provider: "llama-local", modelId: "x" } });
  await router.notify("spaces/sAAA/threads/T1", "heads up");
  assert.equal((fake.submitted[0] as { type: string }).type, "write");
});
