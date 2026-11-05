/**
 * `history()` at the host, where the walk over the transcript lives.
 *
 * A fake seam would test the delegation and nothing else, so this one drives a
 * real harness on in-memory storage: write submissions append the messages, then
 * `history()` bounds and truncates them the way a viewer needs.
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

test("history() returns the last messages with text, newest last", async () => {
  const host = await memoryHost();
  const created = await host.createNamed("threads/A", { model: { provider: "p", modelId: "m" } });

  await host.writeEntry(created.conversationId, {
    kind: "app.notice",
    data: {},
    model: [{ role: "user", content: "first question" }],
  });
  await host.writeEntry(created.conversationId, {
    kind: "app.notice",
    data: {},
    model: [{ role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "first answer" }] }],
  });
  await host.writeEntry(created.conversationId, {
    kind: "app.notice",
    data: {},
    model: [{ role: "assistant", content: [{ type: "text", text: "second answer" }] }],
  });

  const rows = await host.history(created.conversationId);
  assert.deepEqual(rows?.map((m) => `${m.role}:${m.text}`), [
    "user:first question",
    "assistant:first answer",
    "assistant:second answer",
  ]);

  // `limit` keeps the newest, which is what a viewer opening a long thread needs.
  assert.deepEqual((await host.history(created.conversationId, 1))?.map((m) => m.text), ["second answer"]);
  assert.equal(await host.history(999_999), undefined);
  await host.harness.close(BACKGROUND_CONTEXT);
});

test("offset pages backwards from the newest message, and the last page is short", async () => {
  const host = await memoryHost();
  const created = await host.createNamed("threads/O", { model: { provider: "p", modelId: "m" } });
  for (let i = 0; i < 10; i++) {
    await host.writeEntry(created.conversationId, {
      kind: "app.notice",
      data: {},
      model: [{ role: i % 2 === 0 ? "user" : "assistant", content: "m" + i }],
    });
  }

  // offset counts back from the *newest*, so the window slides towards the start
  // as it grows — which is the direction the pane pages in.
  assert.deepEqual((await host.history(created.conversationId, 3, 0))?.map((m) => m.text), ["m7", "m8", "m9"]);
  assert.deepEqual((await host.history(created.conversationId, 3, 3))?.map((m) => m.text), ["m4", "m5", "m6"]);
  assert.deepEqual((await host.history(created.conversationId, 3, 6))?.map((m) => m.text), ["m1", "m2", "m3"]);

  // The final page runs into the beginning and comes back short: that, and not an
  // error, is how a caller learns there is nothing older.
  assert.deepEqual((await host.history(created.conversationId, 3, 9))?.map((m) => m.text), ["m0"]);
  assert.deepEqual((await host.history(created.conversationId, 3, 12)), []);

  // The pages tile the transcript exactly: no message is skipped or repeated,
  // which is the failure that would be invisible in a pane but wrong.
  const paged: string[] = [];
  for (let offset = 0; offset < 10; offset += 3) {
    paged.unshift(...((await host.history(created.conversationId, 3, offset)) ?? []).map((m) => m.text));
  }
  assert.deepEqual(paged, ["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9"]);
  await host.harness.close(BACKGROUND_CONTEXT);
});

test("an image-only message is kept, with its entry id so the bytes can be fetched", async () => {
  const host = await memoryHost();
  const created = await host.createNamed("threads/C", { model: { provider: "p", modelId: "m" } });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
  await host.writeEntry(created.conversationId, {
    kind: "app.notice",
    data: {},
    model: [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          { type: "image", data: png, mimeType: "image/png" },
        ],
      },
    ],
  });

  const rows = await host.history(created.conversationId);
  assert.equal(rows?.length, 1);
  assert.equal(rows?.[0].text, "what is this");
  assert.deepEqual(rows?.[0].images, [{ mimeType: "image/png" }], "the image is announced, not inlined");
  assert.ok(rows?.[0].entryId, "the entry id is what the image URL is built from");

  // And the bytes come back when asked for by that id.
  const found = await host.image(created.conversationId, rows![0].entryId!, 0);
  assert.equal(found?.mimeType, "image/png");
  assert.equal(found?.data, png);
  assert.equal(await host.image(created.conversationId, rows![0].entryId!, 7), undefined);
  await host.harness.close(BACKGROUND_CONTEXT);
});

test("the first message's opening words are kept as a preview, once", async () => {
  const host = await memoryHost();
  const created = await host.createNamed("threads/P", { model: { provider: "p", modelId: "m" } });

  await host.setPreview(created.conversationId, "  how   do I shrink a disk image without losing the partition table  ".repeat(2));
  const rows = await host.recentConversations();
  const row = rows.find((entry) => entry.conversationId === created.conversationId);
  assert.ok(row?.preview, "a conversation with no title still has something to show");
  // Fifteen words, then an ellipsis: the count is the promise, not the marker.
  assert.equal(row!.preview!.replace(/…$/, "").trim().split(" ").length, 15);
  assert.match(row!.preview!, /…$/, "a truncated preview says so");

  // Written once: a later message does not rewrite the opening.
  await host.setPreview(created.conversationId, "a completely different second message");
  const again = (await host.recentConversations()).find((entry) => entry.conversationId === created.conversationId);
  assert.equal(again?.preview, row!.preview);
  await host.harness.close(BACKGROUND_CONTEXT);
});

test("history() truncates one huge message instead of shipping it", async () => {
  const host = await memoryHost();
  const created = await host.createNamed("threads/B", { model: { provider: "p", modelId: "m" } });
  await host.writeEntry(created.conversationId, {
    kind: "app.notice",
    data: {},
    model: [{ role: "assistant", content: [{ type: "text", text: "x".repeat(9000) }] }],
  });

  const rows = await host.history(created.conversationId);
  assert.equal(rows?.[0].text.length, 4000, "one message cannot swamp the pane");
  await host.harness.close(BACKGROUND_CONTEXT);
});
