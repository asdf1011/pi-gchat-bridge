/**
 * One answer, one Chat message.
 *
 * The bug these pin down is a real one from production, not a hypothetical:
 * four messages queued behind a stuck tool in one thread all settled with the
 * *same* assistant entry (`answer 8789`), and the bridge posted that answer once
 * per submission — four identical 2533-character replies in the thread. Two more
 * messages in another thread shared `answer 8742` and produced a double.
 *
 * `requestId` dedupe could not see this: the messages are genuinely different, so
 * the model ran once and every waiting submission was handed the same answer. The
 * duplication lived in the last inch — turning a settled answer into a Chat post —
 * which is what `claimAnswer` guards.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { BridgeHost } from "../src/durable/host.js";
import { claimAnswer, lastPostedAnswer, releaseAnswer } from "../src/durable/posted-doc.js";

/** A host over in-memory storage: enough for the claim, no model needed. */
async function memoryHost(): Promise<BridgeHost> {
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: createModels(), registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  const fake = Object.create(BridgeHost.prototype) as BridgeHost;
  Object.assign(fake, { harness, context: BACKGROUND_CONTEXT, modelRuntime: {} as ModelRuntime });
  return fake;
}

const THREAD = "spaces/sPA7FKAAAAE/threads/SVOTSljRnvw";
const OTHER = "spaces/sPA7FKAAAAE/threads/8Xay0xgO-TI";

test("four submissions that share one answer produce exactly one post", async () => {
  const host = await memoryHost();
  // The production shape: four handlers wake from the same settled answer at
  // roughly the same moment.
  const wins = await Promise.all([1, 2, 3, 4].map(() => claimAnswer(host, THREAD, 8789)));
  assert.equal(wins.filter(Boolean).length, 1, `exactly one claim may win, got ${JSON.stringify(wins)}`);
  assert.equal(wins[0], true, "the first caller posts");
});

test("a sequential repeat of the same answer is refused too", async () => {
  const host = await memoryHost();
  assert.equal(await claimAnswer(host, THREAD, 8742), true);
  assert.equal(await claimAnswer(host, THREAD, 8742), false);
  assert.equal((await lastPostedAnswer(host, THREAD))?.answerId, 8742);
});

test("the next answer in the same thread is delivered normally", async () => {
  const host = await memoryHost();
  assert.equal(await claimAnswer(host, THREAD, 8742), true);
  assert.equal(await claimAnswer(host, THREAD, 8789), true, "a newer answer must not be blocked");
});

test("an older answer can never be posted after a newer one", async () => {
  const host = await memoryHost();
  assert.equal(await claimAnswer(host, THREAD, 8789), true);
  // A late-settling submission carrying a stale answer must not resurrect it.
  assert.equal(await claimAnswer(host, THREAD, 8742), false);
});

test("threads are independent: the same answer in another thread still posts", async () => {
  const host = await memoryHost();
  assert.equal(await claimAnswer(host, THREAD, 8789), true);
  assert.equal(await claimAnswer(host, OTHER, 8789), true);
});

test("a released claim can be taken by the next handler", async () => {
  const host = await memoryHost();
  assert.equal(await claimAnswer(host, THREAD, 8789), true);
  // The post failed outright, so the reply is still owed to the thread.
  await releaseAnswer(host, THREAD, 8789);
  assert.equal(await lastPostedAnswer(host, THREAD), undefined);
  assert.equal(await claimAnswer(host, THREAD, 8789), true);
});

test("releasing a claim that has been superseded leaves the newer one alone", async () => {
  const host = await memoryHost();
  assert.equal(await claimAnswer(host, THREAD, 8789), true);
  assert.equal(await claimAnswer(host, THREAD, 8801), true);
  await releaseAnswer(host, THREAD, 8789);
  assert.equal((await lastPostedAnswer(host, THREAD))?.answerId, 8801);
});

/**
 * The claim is what makes a crash before ack harmless. Pub/Sub redelivers, the
 * done submission is found again by `requestId`, and the answer must not be posted
 * a second time — which only holds if the claim outlives the process.
 */
test("a claim survives a restart", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bridge-posted-"));
  const dbPath = path.join(dir, "bridge.sqlite");
  try {
    const first = await BridgeHost.open({
      dbPath,
      cwd: process.cwd(),
      modelRuntime: createModels() as unknown as ModelRuntime,
      context: BACKGROUND_CONTEXT,
    });
    assert.equal(await claimAnswer(first, THREAD, 8789), true);
    await first.close();

    const second = await BridgeHost.open({
      dbPath,
      cwd: process.cwd(),
      modelRuntime: createModels() as unknown as ModelRuntime,
      context: BACKGROUND_CONTEXT,
    });
    try {
      assert.equal(await claimAnswer(second, THREAD, 8789), false, "the answer was already delivered");
      assert.equal((await lastPostedAnswer(second, THREAD))?.answerId, 8789);
    } finally {
      await second.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
