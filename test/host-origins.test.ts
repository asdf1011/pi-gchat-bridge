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
import { LegacyOriginsDoc, MAX_ORIGINS_PER_CONVERSATION } from "../src/durable/origins-doc.js";

/** The harness a `memoryHost()` built, for tests that must write a document directly. */
function hostTestHarness(host: BridgeHost): Harness {
  return (host as unknown as { harness: Harness }).harness;
}

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

test("one conversation's stamps are its own, so another cannot evict them", async () => {
  // The reason the document is conversation-scoped: a session-wide map with one cap
  // meant a busy thread could spend another thread's retention. Here a conversation
  // is stamped, a second conversation is filled past the per-conversation cap, and the
  // first one's stamp is still there afterwards.
  const host = await memoryHost();
  const quiet = await withPrompt(host, "quiet thread");
  assert.equal(await host.recordOrigin(quiet, 71, "webui"), true);

  const busy = await withPrompt(host, "busy thread");
  const before = (await host.history(quiet, 10, 0))?.find((message) => message.role === "user")?.entryId;
  assert.ok(before !== undefined);
  assert.equal((await host.history(quiet, 10, 0))?.[0]?.origin, "webui");

  // Past MAX_ORIGINS_PER_CONVERSATION in *the other* conversation — the point at
  // which the old session-wide cap would have started evicting the quiet thread's
  // stamp, having already spent its budget on the busy one.
  // The point is *locality*, not the number: the old session-wide cap could spend a
  // quiet thread's retention on a busy one, and 60 stamps here is enough writes to have
  // done that. (Stamping the cap's worth instead costs ~5 ms each in commits and proves
  // the same thing.) The cap itself is per conversation, so it cannot be spent across.
  const over = 60;
  for (let index = 0; index < over; index += 1) {
    await host.writeEntry(busy, {
      kind: "app.notice",
      data: {},
      model: [{ role: "user", content: `prompt ${index}` }],
    });
    await host.recordOrigin(busy, 1_000 + index, "gchat");
  }

  const after = await host.history(quiet, 10, 0);
  assert.equal(after?.[0]?.entryId, before);
  assert.equal(after?.[0]?.origin, "webui", "the quiet conversation keeps its stamp");
});

test("stamps written before the split are copied into each conversation", async () => {
  // Version 1 was one session-scoped map keyed `"<conversationId>:<entryId>"`. The new
  // document is conversation-scoped, so `migrate()` cannot reach the old value at all —
  // no document of this kind exists at the new scope to load. `backfillOrigins` is the
  // step that does it, and this drives it against a real harness.
  const host = await memoryHost();
  const first = await withPrompt(host, "first thread");
  const second = await withPrompt(host, "second thread");
  const firstEntry = (await host.history(first, 10, 0))?.[0]?.entryId;
  const secondEntry = (await host.history(second, 10, 0))?.[0]?.entryId;
  assert.ok(firstEntry !== undefined && secondEntry !== undefined);

  // Write the old shape directly: this is what the store holds today.
  await hostTestHarness(host).commit(async (tx) => {
    const doc = await tx.doc(LegacyOriginsDoc);
    doc.byEntry = {
      [`${first}:${firstEntry}`]: { origin: "gchat", submission: 101, at: 1 },
      [`${second}:${secondEntry}`]: { origin: "webui", submission: 102, at: 2 },
    };
  }, BACKGROUND_CONTEXT);

  assert.deepEqual(await host.backfillOrigins(), { conversations: 2, stamps: 2 });

  assert.equal((await host.history(first, 10, 0))?.[0]?.origin, "gchat");
  assert.equal((await host.history(second, 10, 0))?.[0]?.origin, "webui");

  // Idempotent: a second run finds conversations that already have stamps and writes
  // nothing, so a restart cannot duplicate or reorder anything.
  assert.deepEqual(await host.backfillOrigins(), { conversations: 0, stamps: 0 });
  assert.equal((await host.history(first, 10, 0))?.[0]?.origin, "gchat");
});

test("a conversation already stamped under the new scope is left alone", async () => {
  // The stamp recorded by a live turn is fresher than anything the old map remembers,
  // so a backfill must never overwrite it — otherwise restarting the bridge would
  // silently rewrite recent provenance with week-old records.
  const host = await memoryHost();
  const conversationId = await withPrompt(host);
  const entryId = (await host.history(conversationId, 10, 0))?.[0]?.entryId;
  assert.ok(entryId !== undefined);

  assert.equal(await host.recordOrigin(conversationId, 201, "webui"), true);
  await hostTestHarness(host).commit(async (tx) => {
    const doc = await tx.doc(LegacyOriginsDoc);
    doc.byEntry = { [`${conversationId}:${entryId}`]: { origin: "gchat", submission: 201, at: 1 } };
  }, BACKGROUND_CONTEXT);

  assert.deepEqual(await host.backfillOrigins(), { conversations: 0, stamps: 0 });
  assert.equal((await host.history(conversationId, 10, 0))?.[0]?.origin, "webui");
});
