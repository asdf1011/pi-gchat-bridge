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
  noticeEntry,
  type IncomingChatMessage,
} from "../src/adapter/router.js";
import type { SessionHost, SubmitRequest } from "../src/session-host/api.js";

const message = (over: Partial<IncomingChatMessage> = {}): IncomingChatMessage => ({
  chatKey: "spaces/sAAA/threads/T1",
  messageName: "spaces/sAAA/messages/m1",
  text: "hello",
  ...over,
});

const image = { type: "image" as const, data: "aGk=", mimeType: "image/png" };

test("a plain message is a bare string, no content blocks", () => {
  assert.equal(buildContent("hello"), "hello");
});

test("an image message becomes content blocks, text first", () => {
  const content = buildContent("what is this", [image]);
  assert.deepEqual(content, [
    { type: "text", text: "what is this" },
    // Chat hands images over as base64. The seam's reference form is for bytes
    // already on disk; an attachment is described here and read by the host.
    { type: "text", text: "[image: image/png]" },
  ]);
});

test("an image-only message has no empty text block", () => {
  const content = buildContent("", [image]);
  assert.deepEqual(content, [{ type: "text", text: "[image: image/png]" }]);
});

test("a notification is a write with model content, never a run", () => {
  const entry = noticeEntry("disk is 94% full", 1_700_000_000_000);
  assert.equal(entry.kind, "app.notice");
  assert.deepEqual(entry.data, { text: "disk is 94% full", at: 1_700_000_000_000 });
  // Model content is what makes a later reply see the notice; without it the
  // entry would be display-only and invisible to the model.
  assert.deepEqual(entry.model, [
    { role: "user", content: "[notification] disk is 94% full", timestamp: 1_700_000_000_000 },
  ]);
});

/** A seam stand-in: four operations wide, which is all the router uses. */
function fakeSeam() {
  const submitted: SubmitRequest[] = [];
  const written: unknown[] = [];
  const created: { chatKey: string; agent: unknown }[] = [];
  const seam = {
    info: () => ({ dbPath: ":memory:", cwd: "/tmp", startedAt: 0 }),
    list: async () => [],
    resolve: async (key: string) =>
      key === "bound" ? { conversationId: 7, name: key, model: "m", createdAt: 0 } : undefined,
    getOrCreate: async (chatKey: string, agent: unknown) => {
      created.push({ chatKey, agent });
      return { conversationId: 7, name: chatKey, model: "llama-local/x", createdAt: 0 };
    },
    submit: async (_id: number, request: SubmitRequest) => {
      submitted.push(request);
      return { submissionId: submitted.length };
    },
    write: async (_id: number, entry: unknown) => {
      written.push(entry);
      return 1;
    },
  } as unknown as SessionHost;
  return { seam, submitted, written, created };
}

test("deliver() creates the conversation on the message's key and submits on it", async () => {
  const fake = fakeSeam();
  const router = new DurableRouter(fake.seam, { model: { provider: "llama-local", modelId: "x" } });
  const delivered = await router.deliver(message());
  assert.equal(delivered.submissionId, 1);
  assert.equal(delivered.conversationId, 7);
  assert.equal(fake.created[0]?.chatKey, "spaces/sAAA/threads/T1");
  assert.equal(fake.submitted.length, 1);
});

test("the Chat message name becomes the requestId, and a message always steers", async () => {
  const fake = fakeSeam();
  const router = new DurableRouter(fake.seam, { model: { provider: "llama-local", modelId: "x" } });
  await router.deliver(message());
  // The name is the dedupe key: a Pub/Sub redelivery asks for the same
  // submission instead of running the turn twice.
  assert.equal(fake.submitted[0].requestId, "spaces/sAAA/messages/m1");
  // pi-durable ignores whenBusy when idle, so "steer" is safe unconditionally.
  assert.equal(fake.submitted[0].whenBusy, "steer");
});

test("notify() writes an entry on the key's conversation", async () => {
  const fake = fakeSeam();
  const router = new DurableRouter(fake.seam, { model: { provider: "llama-local", modelId: "x" } });
  await router.notify("spaces/sAAA/threads/T1", "heads up");
  assert.equal((fake.written[0] as { kind: string }).kind, "app.notice");
  assert.equal(fake.submitted.length, 0, "a notice is a write, not a run");
});
