import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { inProcessSessionHost } from "../src/session-host/inprocess.js";
import type { BridgeHost } from "../src/durable/host.js";
import type { ArtifactEntryLike } from "../src/durable/artifacts.js";

interface Binding {
  conversationId: number;
  model: string;
  thinking?: string;
  name?: string;
  createdAt: number;
}

interface FakeOptions {
  bindings?: Record<string, Binding>;
  view?: unknown;
  entries?: readonly ArtifactEntryLike[];
  submitted?: unknown[];
  /** Conversations that exist. Anything else resolves to undefined. */
  conversations?: number[];
}

/** A stand-in for the live host: five fields wide, which is all the seam touches. */
function fakeHost(options: FakeOptions = {}): BridgeHost {
  const conversations = options.conversations ?? [1];
  const counters = { disposed: 0, subscribed: 0 };
  const subscribers: ((value: unknown) => void)[] = [];
  (globalThis as Record<string, unknown>).__seamCounters = counters;
  (globalThis as Record<string, unknown>).__seamEmit = (value: unknown) => {
    for (const fn of subscribers) fn(value);
  };

  const host = {
    dbPath: "/tmp/fake-bridge.sqlite",
    cwdPath: "/workspace",
    context: {},
    bindings: async () => ({ byChatKey: options.bindings ?? {} }),
    bindingFor: async (name: string) => (options.bindings ?? {})[name],
    conversationFor: async (name: string, agent: { model: { provider: string; modelId: string } }) => ({
      binding: {
        conversationId: 7,
        model: `${agent.model.provider}/${agent.model.modelId}`,
        createdAt: 1000,
      },
      conversation: {},
    }),
    harness: {
      conversation: async (id: number) =>
        conversations.includes(id)
          ? {
              viewState: async () => ({
                value: options.view ?? {},
                subscribe: (fn: (value: unknown) => void) => {
                  counters.subscribed += 1;
                  subscribers.push(fn);
                },
                dispose: () => {
                  counters.disposed += 1;
                },
              }),
              submit: async (draft: unknown) => {
                options.submitted?.push(draft);
                return { id: 42 };
              },
            }
          : undefined,
    },
  };
  return host as unknown as BridgeHost;
}

function counters(): { disposed: number; subscribed: number } {
  return (globalThis as Record<string, unknown>).__seamCounters as { disposed: number; subscribed: number };
}

function emit(value: unknown): void {
  ((globalThis as Record<string, unknown>).__seamEmit as (value: unknown) => void)(value);
}

test("the seam file imports no library types", () => {
  // The contract is only a contract if an adapter cannot reach past it through a
  // shared type. This is the check the doc calls the success criterion.
  const source = fs.readFileSync(new URL("../src/session-host/api.ts", import.meta.url), "utf8");
  assert.ok(!source.includes("@earendil-works/pi-durable"), "api.ts must not import pi-durable");
  assert.ok(!source.includes("@earendil-works/chord"), "api.ts must not import chord");
});

test("list() maps bindings to plain conversations, newest first", async () => {
  const seam = inProcessSessionHost({
    host: fakeHost({
      bindings: {
        "threads/a": { conversationId: 1, model: "deepseek/flash", createdAt: 1000 },
        "threads/b": { conversationId: 2, model: "local/lfm", name: "notes", createdAt: 2000 },
      },
    }),
    roots: ["/workspace"],
  });

  const listed = await seam.list();
  assert.deepEqual(listed.map((c) => c.conversationId), [2, 1]);
  assert.equal(listed[0].label, "notes");
  assert.equal(listed[1].label, undefined);
  assert.equal(listed[1].model, "deepseek/flash");
});

test("resolve() is undefined for a name the host has never seen", async () => {
  const seam = inProcessSessionHost({ host: fakeHost(), roots: [] });
  assert.equal(await seam.resolve("threads/nope"), undefined);
});

test("getOrCreate() returns the binding the host created", async () => {
  const seam = inProcessSessionHost({ host: fakeHost(), roots: [] });
  const created = await seam.getOrCreate("threads/new", { model: { provider: "deepseek", modelId: "flash" } });
  assert.equal(created.conversationId, 7);
  assert.equal(created.model, "deepseek/flash");
  assert.equal(created.name, "threads/new");
});

test("snapshot() returns a projection, not a transcript", async () => {
  const seam = inProcessSessionHost({
    host: fakeHost({
      view: {
        entries: [{ id: 1, model: [{ role: "assistant", content: [{ type: "text", text: "hello" }] }] }],
        docs: {},
      },
    }),
    roots: [],
  });
  const snapshot = await seam.snapshot(1);
  assert.ok(snapshot);
  assert.equal(typeof snapshot.liveText, "string");
  assert.ok(Array.isArray(snapshot.tools));
  // The transcript must not travel: this shape is bounded regardless of history.
  assert.equal("entries" in snapshot, false);
  assert.equal(counters().disposed, 1, "the view subscription must be disposed");
});

test("attach() delivers the current state first, then frames, and detaches once", async () => {
  const seam = inProcessSessionHost({
    host: fakeHost({ view: { entries: [], docs: {} } }),
    roots: [],
  });
  const frames: unknown[] = [];
  const handle = await seam.attach(1, (view) => frames.push(view));
  assert.ok(handle);
  assert.equal(typeof handle.snapshot.liveText, "string");

  // Contract: the current state is the first frame, so a caller never has to
  // paint a snapshot separately (and cannot paint a stale one over a new frame).
  assert.equal(frames.length, 1, "the snapshot arrives as the first frame");

  emit({ entries: [], docs: {} });
  assert.equal(frames.length, 2);

  handle.detach();
  handle.detach();
  emit({ entries: [], docs: {} });
  assert.equal(frames.length, 2, "no frame after detach");
  assert.equal(counters().disposed, 1, "detach is idempotent");
});

test("attach() and snapshot() are undefined for a conversation that is gone", async () => {
  const seam = inProcessSessionHost({ host: fakeHost({ conversations: [1] }), roots: [] });
  assert.equal(await seam.snapshot(999), undefined);
  assert.equal(await seam.attach(999, () => {}), undefined);
});

test("artifacts() derives host-side from the transcript", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-seam-"));
  try {
    const file = path.join(root, "notes.md");
    fs.writeFileSync(file, "# hi\n");
    const seam = inProcessSessionHost({
      host: fakeHost({
        view: {
          entries: [
            { id: 3, model: [{ content: [{ type: "toolCall", name: "write", arguments: { path: file } }] }] },
          ],
          docs: {},
        },
      }),
      roots: [fs.realpathSync(root)],
    });
    const artifacts = await seam.artifacts(1);
    assert.ok(artifacts);
    assert.deepEqual(artifacts.map((a) => a.key), ["notes.md"]);
    assert.equal(artifacts[0].wrote, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("submit() maps content, defaults whenBusy, and reports a bad conversation", async () => {
  const submitted: unknown[] = [];
  const seam = inProcessSessionHost({
    host: fakeHost({ conversations: [1], submitted }),
    roots: [],
  });

  assert.deepEqual(await seam.submit(999, { content: "hi" }), { error: "no such conversation: 999" });
  assert.deepEqual(await seam.submit(1, { content: "   " }), { error: "empty message" });

  assert.deepEqual(await seam.submit(1, { content: "hi", requestId: "chat/msg/1" }), { submissionId: 42 });
  const draft = submitted[0] as { type: string; content: unknown; whenBusy: string; requestId: string };
  assert.equal(draft.type, "input");
  assert.equal(draft.content, "hi");
  assert.equal(draft.whenBusy, "steer");
  assert.equal(draft.requestId, "chat/msg/1");
});

test("submit() reads image parts from disk instead of carrying bytes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-seam-img-"));
  try {
    const file = path.join(root, "pic.png");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    fs.writeFileSync(file, bytes);

    const submitted: unknown[] = [];
    const seam = inProcessSessionHost({
      host: fakeHost({ conversations: [1], submitted }),
      roots: [],
    });

    const result = await seam.submit(1, {
      content: [
        { type: "text", text: "look" },
        { type: "image", path: file, mimeType: "image/png" },
      ],
      whenBusy: "followUp",
    });
    assert.deepEqual(result, { submissionId: 42 });

    const draft = submitted[0] as { content: { type: string; data?: string; mimeType?: string }[] };
    assert.equal(draft.content[0].type, "text");
    assert.equal(draft.content[1].type, "image");
    assert.equal(draft.content[1].data, bytes.toString("base64"));
    assert.equal(draft.content[1].mimeType, "image/png");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
