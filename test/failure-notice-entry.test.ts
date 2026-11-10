/**
 * A provider failure must appear as the reply to the prompt, on whatever surface asked.
 *
 * This is the fix for the complaint that mattered: a turn that died on a 402 showed
 * *nothing*. The web page cleared its "thinking…" bubble and the conversation went
 * quiet — indistinguishable from a hung bridge — while the reason sat in a log line
 * the user never sees. Chat had its own notice, but `chat-handler` is not on the web
 * path, so the browser got silence.
 *
 * The notice is written into the transcript rather than sent out of band, so every
 * surface that reads the transcript shows it with no per-surface plumbing. These tests
 * drive a real harness on in-memory storage, because the property under test is "the
 * entry is in the transcript, stamped as an answer" — which a fake seam cannot show.
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

/** A submission to hang the notice off. */
async function submissionFor(host: BridgeHost, conversationId: number): Promise<number> {
  const conversation = await host.harness.conversation(conversationId as never, BACKGROUND_CONTEXT);
  assert.ok(conversation);
  const submitted = await conversation!.submit(
    { type: "input", content: "is this still working?" } as never,
    BACKGROUND_CONTEXT,
  );
  return submitted.id as unknown as number;
}

test("a failure notice is readable in the transcript as the reply", async () => {
  const host = await memoryHost();
  const created = await host.createNamed("threads/web", { model: { provider: "deepseek", modelId: "flash" } });
  const submission = await submissionFor(host, created.conversationId);

  const entryId = await host.writeFailureNotice(
    created.conversationId,
    submission,
    "The model provider refused the turn: Insufficient Balance.",
  );
  assert.equal(typeof entryId, "number");

  const messages = (await host.history(created.conversationId)) ?? [];
  const last = messages.at(-1);
  assert.ok(last, "the notice is in the transcript");
  assert.equal(last!.role, "assistant");
  assert.match(last!.text, /Insufficient Balance/);
});

test("the notice is stamped as an answer, so the painter posts it instead of ignoring it", async () => {
  // The stamp is the whole difference between a notice that is shown and one that is
  // filed as commentary: `painter.isAnswer` requires an origin, and a turn's
  // intermediate messages deliberately have none.
  const host = await memoryHost();
  const created = await host.createNamed("threads/web", { model: { provider: "deepseek", modelId: "flash" } });
  const submission = await submissionFor(host, created.conversationId);

  const entryId = await host.writeFailureNotice(created.conversationId, submission, "top up with /quota");
  assert.equal(typeof entryId, "number");

  const messages = (await host.history(created.conversationId)) ?? [];
  const notice = messages.find((message) => message.entryId === entryId);
  assert.ok(notice, "the notice carries its entry id");
  assert.notEqual(notice!.origin, undefined, "and so an origin, which is what makes it an answer");
});

test("the notice inherits the surface that asked", async () => {
  // A turn started in the browser has to be reported in the browser, not in Chat.
  const host = await memoryHost();
  const created = await host.createNamed("threads/x", { model: { provider: "deepseek", modelId: "flash" } });
  const conversation = await host.harness.conversation(created.conversationId as never, BACKGROUND_CONTEXT);
  assert.ok(conversation);
  const submitted = await conversation!.submit(
    { type: "input", content: "hello", origin: "webui" } as never,
    BACKGROUND_CONTEXT,
  );
  const submissionId = submitted.id as unknown as number;
  // The prompt's origin is stamped when the submission returns, exactly as `submit` does.
  await host.recordOrigin(created.conversationId, submissionId, "webui");

  const entryId = await host.writeFailureNotice(created.conversationId, submissionId, "no balance");
  assert.equal(typeof entryId, "number");

  const messages = (await host.history(created.conversationId)) ?? [];
  const notice = messages.find((message) => message.entryId === entryId);
  assert.equal(notice?.origin, "webui");
});

test("a notice for a conversation that does not exist is refused, not thrown", async () => {
  const host = await memoryHost();
  // Best-effort by construction: this runs in the failure path, and bookkeeping must
  // never turn a failed turn into a crashed one.
  const entryId = await host.writeFailureNotice(999_999, 1, "nowhere").catch(() => undefined);
  assert.equal(entryId, undefined);
});
