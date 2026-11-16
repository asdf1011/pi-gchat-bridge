import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { spawnSync } from "node:child_process";

import { inProcessSessionHost } from "../src/session-host/inprocess.js";
import type { BridgeHost } from "../src/durable/host.js";
import type { ArtifactEntryLike } from "../src/durable/artifacts.js";

interface Binding {
  conversationId: number;
  model: string;
  thinking?: string;
  name?: string;
  createdAt: number;
  /** Last use, for the recent list. Equal to `createdAt` until a turn is taken. */
  updatedAt?: number;
  /** Opening words, shown when there is no title yet. */
  preview?: string;
}

interface FakeOptions {
  /** Files the filesystem "saw" change, as the host would report them. */
  observed?: { path: string; at: number }[];
  bindings?: Record<string, Binding>;
  view?: unknown;
  entries?: readonly ArtifactEntryLike[];
  submitted?: unknown[];
  /** Conversations that exist. Anything else resolves to undefined. */
  conversations?: number[];
  /** Comments the store already holds, as `host.comments` reports them. */
  comments?: unknown[];
  /** What `host.addComment` was given, so a test can read the record that was written. */
  addedComments?: unknown[];
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
    recentConversations: async ({ limit, offset }: { limit?: number; offset?: number } = {}) =>
      Object.entries(options.bindings ?? {})
        .map(([chatKey, binding]) => ({ ...binding, chatKey }))
        .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))
        .slice(offset ?? 0, (offset ?? 0) + (limit ?? Number.MAX_SAFE_INTEGER)),
    touch: async () => {},
    setPreview: async () => {},
    observedFiles: async () => options.observed ?? [],
    recordObservedFiles: async () => {},
    awaitSubmission: async () => ({ status: "ok" }),
    bindingFor: async (name: string) => (options.bindings ?? {})[name],
    conversationFor: async (name: string, agent: { model: { provider: string; modelId: string } }) => ({
      binding: {
        conversationId: 7,
        model: `${agent.model.provider}/${agent.model.modelId}`,
        createdAt: 1000,
      },
      conversation: {},
    }),
    comments: async () => options.comments ?? [],
    addComment: async (_conversationId: number, comment: unknown) => {
      options.addedComments?.push(comment);
      return true;
    },
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

test("artifacts() adds files the filesystem saw, which no tool call named", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-seam-"));
  try {
    const written = path.join(root, "src/app.ts");
    const viaBash = path.join(root, "dist/bundle.js");
    fs.mkdirSync(path.dirname(written), { recursive: true });
    fs.mkdirSync(path.dirname(viaBash), { recursive: true });
    fs.writeFileSync(written, "export {};\n");
    fs.writeFileSync(viaBash, "// built\n");
    const seam = inProcessSessionHost({
      host: fakeHost({
        view: {
          entries: [
            { id: 3, model: [{ content: [{ type: "toolCall", name: "write", arguments: { path: written } }] }] },
          ],
          docs: {},
        },
        // `sed -i` and a build: real changes, no path the transcript can see.
        observed: [{ path: viaBash, at: Date.now() }],
      }),
      roots: [fs.realpathSync(root)],
    });
    const artifacts = await seam.artifacts(1);
    assert.ok(artifacts);
    assert.deepEqual(artifacts.map((a) => a.key), ["dist/bundle.js", "src/app.ts"]);
    // The tool call keeps its count; the observed file has none to claim.
    assert.equal(artifacts[1].wrote, 1);
    assert.equal(artifacts[0].wrote + artifacts[0].edited, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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

test("submit() passes an inline image through as a model block", async () => {
  const submitted: unknown[] = [];
  const seam = inProcessSessionHost({ host: fakeHost({ conversations: [1], submitted }), roots: [] });

  const result = await seam.submit(1, {
    content: [
      { type: "text", text: "look" },
      { type: "image", data: "aGk=", mimeType: "image/png" },
    ],
    whenBusy: "followUp",
  });
  assert.deepEqual(result, { submissionId: 42 });

  const draft = submitted[0] as { content: { type: string; data?: string; mimeType?: string }[] };
  assert.equal(draft.content[0].type, "text");
  assert.equal(draft.content[1].type, "image");
  assert.equal(draft.content[1].data, "aGk=");
  assert.equal(draft.content[1].mimeType, "image/png");
});

/** Whether PyMuPDF is installed, so a PDF test can be skipped rather than fail here. */
const hasPdf = spawnSync("python3", ["-c", "import pymupdf"]).status === 0;

/**
 * A 48x32 RGBA PNG, built here so a region comment has a real picture to crop.
 *
 * A rectangle has to be decoded to be cut out, so a fixture that is not a picture would
 * make the crop path untested while the comment path looked green.
 */
function rgbaPng(width: number, height: number): Buffer {
  const table: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const crc32 = (buffer: Buffer): number => {
    let crc = 0xffffffff;
    for (const byte of buffer) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff]!;
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const at = y * (width * 4 + 1);
    raw[at] = 0;
    for (let x = 0; x < width; x += 1) {
      raw[at + 1 + x * 4] = x * 5;
      raw[at + 2 + x * 4] = y * 7;
      raw[at + 5 + x * 4] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("a comment on part of a picture is stored as a rectangle, with no anchors", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-seam-image-"));
  try {
    const file = path.join(root, "shot.png");
    fs.writeFileSync(file, rgbaPng(48, 32));
    const added: unknown[] = [];
    const seam = inProcessSessionHost({
      host: fakeHost({
        conversations: [1],
        addedComments: added,
        view: {
          entries: [
            { id: 3, model: [{ content: [{ type: "toolCall", name: "write", arguments: { path: file } }] }] },
          ],
          docs: {},
        },
      }),
      // A repository, because `addComment` refuses every comment in a deployment that
      // does not version artifacts — an image comment included. It still writes no
      // anchors: a picture has no lines for jj to annotate.
      roots: [fs.realpathSync(root)],
      artifactRepoFor: () => fs.realpathSync(root),
    });

    const created = await seam.addComment(1, {
      file: "shot.png",
      selection: { region: { x: 4, y: 8, width: 16, height: 12, imageWidth: 48, imageHeight: 32 } },
      text: "this button is in the wrong place",
    });
    assert.ok("comment" in created, `expected a comment, got ${JSON.stringify(created)}`);
    assert.deepEqual(created.comment.anchors, []);
    assert.deepEqual(created.comment.region, { x: 4, y: 8, width: 16, height: 12, imageWidth: 48, imageHeight: 32 });
    assert.deepEqual(created.comment.positions, []);
    assert.equal(created.comment.state, "visible");
    // And the record is what was written: no line anchors invented for a picture.
    const stored = added[0] as { anchors: unknown[]; region: { x: number } };
    assert.deepEqual(stored.anchors, []);
    assert.equal(stored.region.x, 4);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a rectangle that is not one is refused, rather than stored as an unactionable anchor", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-seam-image-"));
  try {
    const file = path.join(root, "shot.png");
    fs.writeFileSync(file, rgbaPng(48, 32));
    const added: unknown[] = [];
    const seam = inProcessSessionHost({
      host: fakeHost({
        conversations: [1],
        addedComments: added,
        view: {
          entries: [
            { id: 3, model: [{ content: [{ type: "toolCall", name: "write", arguments: { path: file } }] }] },
          ],
          docs: {},
        },
      }),
      roots: [fs.realpathSync(root)],
      artifactRepoFor: () => fs.realpathSync(root),
    });

    // A tap: zero-sized, which is a click rather than a selection.
    const tapped = await seam.addComment(1, {
      file: "shot.png",
      selection: { region: { x: 4, y: 8, width: 0, height: 0, imageWidth: 48, imageHeight: 32 } },
      text: "here",
    });
    assert.ok("error" in tapped);
    assert.match(tapped.error, /not a rectangle inside the picture/);
    assert.equal(added.length, 0, "nothing was written");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the region a comment selected can be cropped, and an unlisted file cannot", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-seam-image-"));
  try {
    const file = path.join(root, "shot.png");
    fs.writeFileSync(file, rgbaPng(48, 32));
    const seam = inProcessSessionHost({
      host: fakeHost({
        conversations: [1],
        view: {
          entries: [
            { id: 3, model: [{ content: [{ type: "toolCall", name: "write", arguments: { path: file } }] }] },
          ],
          docs: {},
        },
      }),
      roots: [fs.realpathSync(root)],
    });

    const cropped = await seam.cropArtifactRegion(1, "shot.png", {
      x: 4, y: 8, width: 16, height: 12, imageWidth: 48, imageHeight: 32,
    });
    assert.ok(cropped);
    assert.equal(cropped.mimeType, "image/png");
    assert.equal(cropped.width, 16);
    assert.equal(cropped.height, 12);
    const bytes = Buffer.from(cropped.data, "base64");
    assert.equal(bytes.readUInt32BE(0), 0x89504e47, "a real PNG");

    // The allow-list, not the path: a file the conversation never wrote is not readable
    // through a comment's rectangle.
    assert.equal(
      await seam.cropArtifactRegion(1, "not-an-artifact.png", { x: 0, y: 0, width: 8, height: 8, imageWidth: 48, imageHeight: 32 }),
      undefined,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a region of a PDF is cropped from the page it names", { skip: !hasPdf && "pymupdf is not available" }, async () => {
  // The comment path for a document: the page is rendered and the rectangle cut from
  // *that* picture. Cropping the file's own bytes would cut into compressed structure
  // and produce noise, so this is the seam that has to render first.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-seam-pdf-"));
  try {
    const file = path.join(root, "resume.pdf");
    const made = spawnSync("python3", [
      "-c",
      [
        "import sys, pymupdf",
        "document = pymupdf.open()",
        "first = document.new_page()",
        "first.insert_text((72, 72), 'page one')",
        "second = document.new_page()",
        "second.insert_text((72, 72), 'page two')",
        "document.save(sys.argv[1])",
      ].join("\n"),
      file,
    ]);
    assert.equal(made.status, 0, "the fixture PDF was written");

    const seam = inProcessSessionHost({
      host: fakeHost({
        conversations: [1],
        view: {
          entries: [
            { id: 3, model: [{ content: [{ type: "toolCall", name: "write", arguments: { path: file } }] }] },
          ],
          docs: {},
        },
      }),
      roots: [fs.realpathSync(root)],
    });

    // Page 2's raster, cropped. The dimensions prove it was rendered rather than read.
    const cropped = await seam.cropArtifactRegion(1, "resume.pdf", {
      x: 40, y: 40, width: 200, height: 120, imageWidth: 1240, imageHeight: 1755, page: 2,
    });
    assert.ok(cropped, "the page was rendered and cropped");
    assert.equal(cropped.width, 200);
    assert.equal(cropped.height, 120);
    assert.equal(cropped.mimeType, "image/png");
    assert.equal(Buffer.from(cropped.data, "base64").readUInt32BE(0), 0x89504e47, "a real PNG");

    // A page the document does not have crops nothing, rather than page 1 by accident.
    assert.equal(
      await seam.cropArtifactRegion(1, "resume.pdf", {
        x: 40, y: 40, width: 200, height: 120, imageWidth: 1240, imageHeight: 1755, page: 9,
      }),
      undefined,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
