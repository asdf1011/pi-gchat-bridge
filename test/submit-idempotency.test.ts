/**
 * A retried submission is the same submission.
 *
 * This is the claim the API relies on for recovery — if the response to a `POST /submissions` is
 * lost, the caller retries with the same `requestId` rather than inventing a second mechanism to
 * find out what happened. It was documented from a code comment, so it is pinned here against a
 * real harness: same submission id back, and one entry, not two.
 *
 * It also pins the quieter half: a deduped retry must not make the origin stamper complain. It did
 * — "every user entry is stamped" on the second submit — which reads like damage when it is the
 * idempotency working.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { BridgeHost } from "../src/durable/host.js";
import { inProcessSessionHost } from "../src/session-host/inprocess.js";

async function harnessedHost() {
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
    modelRuntime: {
      getModel: () => undefined,
      getModels: () => [],
      getAllAvailable: async () => [],
    } as unknown as ModelRuntime,
    cwd: "/tmp",
    dbPath: ":memory:",
    pending: new Map(),
  });
  const seam = inProcessSessionHost({ host, roots: [] });
  const created = await host.createNamed("threads/A", { model: { provider: "p", modelId: "m" } });
  return { host, seam, conversationId: created.conversationId };
}

test("the same requestId returns the same submission and writes one entry", async () => {
  const { seam, conversationId } = await harnessedHost();
  const first = await seam.submit(conversationId, { content: "hello", origin: "cli", requestId: "req-1" });
  const second = await seam.submit(conversationId, { content: "hello", origin: "cli", requestId: "req-1" });

  assert.ok("submissionId" in first && "submissionId" in second);
  assert.equal(first.submissionId, second.submissionId, "a retry is the same submission");
  const entries = await seam.history(conversationId, { limit: 10 });
  assert.equal(entries?.length, 1, "and one entry, not two");
});

test("a different requestId is a different submission", async () => {
  const { seam, conversationId } = await harnessedHost();
  const first = await seam.submit(conversationId, { content: "one", origin: "cli", requestId: "req-a" });
  const second = await seam.submit(conversationId, { content: "two", origin: "cli", requestId: "req-b" });
  assert.ok("submissionId" in first && "submissionId" in second);
  assert.notEqual(first.submissionId, second.submissionId);
});

test("a deduped retry keeps the origin it recorded the first time", async () => {
  const { seam, conversationId } = await harnessedHost();
  await seam.submit(conversationId, { content: "hello", origin: "cli", requestId: "req-1" });
  await seam.submit(conversationId, { content: "hello", origin: "cli", requestId: "req-1" });
  const entries = await seam.history(conversationId, { limit: 10 });
  assert.deepEqual(entries?.map((entry) => entry.origin), ["cli"]);
});
