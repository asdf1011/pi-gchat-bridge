import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  artifactKeyFor,
  canonicalPath,
  deriveArtifacts,
  isInsideRoot,
  readArtifact,
  type ArtifactEntryLike,
} from "../src/durable/artifacts.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifacts-"));
}

/** A transcript entry carrying one tool call, which is all the derivation reads. */
function entry(
  id: number,
  name: string,
  args: Record<string, unknown>,
): ArtifactEntryLike {
  return { id, model: [{ content: [{ type: "toolCall", name, arguments: args }] }] };
}

test("a write then an edit of the same file is one artifact, counted", () => {
  const root = tempDir();
  try {
    const file = path.join(root, "notes.md");
    const artifacts = deriveArtifacts(
      [
        entry(1, "write", { path: file, content: "one" }),
        entry(2, "edit", { path: file, edits: [{ oldText: "one", newText: "two" }] }),
        entry(3, "edit", { path: file, edits: [{ oldText: "two", newText: "three" }] }),
      ],
      [canonicalPath(root)],
    );
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].key, "notes.md");
    assert.equal(artifacts[0].wrote, 1);
    assert.equal(artifacts[0].edited, 2);
    // The newest touch wins, so a view can link back to the latest turn.
    assert.equal(artifacts[0].entryId, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("two spellings of one file collapse to a single artifact", () => {
  const root = tempDir();
  try {
    const real = path.join(root, "real");
    fs.mkdirSync(real);
    const target = path.join(real, "doc.md");
    fs.writeFileSync(target, "x");
    const viaLink = path.join(root, "link");
    fs.symlinkSync(real, viaLink);

    // This is the deployment's own shape: /workspace/pi-chat-bridge is a symlink
    // to /workspace/pi-gchat-bridge, and conversations use both spellings.
    const artifacts = deriveArtifacts(
      [
        entry(1, "write", { path: path.join(viaLink, "doc.md"), content: "x" }),
        entry(2, "edit", { path: target, edits: [{ oldText: "x", newText: "y" }] }),
      ],
      [canonicalPath(root)],
    );
    assert.equal(artifacts.length, 1, `expected one artifact, got ${JSON.stringify(artifacts.map((a) => a.key))}`);
    assert.equal(artifacts[0].wrote, 1);
    assert.equal(artifacts[0].edited, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("paths outside every root are not artifacts", () => {
  const root = tempDir();
  try {
    const artifacts = deriveArtifacts(
      [
        entry(1, "write", { path: path.join(root, "inside.md"), content: "x" }),
        entry(2, "write", { path: "/etc/passwd", content: "x" }),
      ],
      [canonicalPath(root)],
    );
    assert.deepEqual(artifacts.map((a) => a.key), ["inside.md"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("only tools that name their file count: bash and reads do not", () => {
  const root = tempDir();
  try {
    const artifacts = deriveArtifacts(
      [
        entry(1, "bash", { command: "sed -i s/a/b/ notes.md" }),
        entry(2, "read", { path: path.join(root, "notes.md") }),
        entry(3, "write", { path: path.join(root, "notes.md"), content: "x" }),
      ],
      [canonicalPath(root)],
    );
    assert.deepEqual(artifacts.map((a) => a.key), ["notes.md"]);
    assert.equal(artifacts[0].wrote, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the longest matching root wins, so a nested root gives the shorter key", () => {
  const outer = tempDir();
  try {
    const inner = path.join(outer, "repo");
    fs.mkdirSync(inner);
    const file = path.join(inner, "src", "a.ts");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "x");

    const keyed = artifactKeyFor(file, [canonicalPath(outer), canonicalPath(inner)]);
    assert.deepEqual(keyed, { root: canonicalPath(inner), key: "src/a.ts" });
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test("isInsideRoot refuses the root itself and escaping paths", () => {
  assert.equal(isInsideRoot("/a/b", "/a/b"), false);
  assert.equal(isInsideRoot("/a/b", "/a/b/c"), true);
  assert.equal(isInsideRoot("/a/b", "/a/bc"), false);
  assert.equal(isInsideRoot("/a/b", "/a/b/../c"), false);
});

test("a deleted file keeps its key, so the list does not lose entries", () => {
  const root = tempDir();
  try {
    const file = path.join(root, "gone.md");
    const artifacts = deriveArtifacts([entry(1, "write", { path: file, content: "x" })], [canonicalPath(root)]);
    assert.deepEqual(artifacts.map((a) => a.key), ["gone.md"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reading truncates at the cap and says so", () => {
  const root = tempDir();
  try {
    const file = path.join(root, "long.txt");
    fs.writeFileSync(file, "0123456789");
    const artifacts = deriveArtifacts([entry(1, "write", { path: file, content: "x" })], [canonicalPath(root)]);
    const read = readArtifact(artifacts[0], { maxBytes: 4 });
    assert.equal(read.content, "0123");
    assert.equal(read.truncated, true);
    assert.equal(read.size, 10);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("binary files are reported, not served as mojibake", () => {
  const root = tempDir();
  try {
    const file = path.join(root, "blob.bin");
    fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x00, 0x47]));
    const artifacts = deriveArtifacts([entry(1, "write", { path: file, content: "x" })], [canonicalPath(root)]);
    const read = readArtifact(artifacts[0]);
    assert.equal(read.binary, true);
    assert.equal(read.content, "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a path that escaped its root between listing and reading is refused", () => {
  const root = tempDir();
  const outside = tempDir();
  try {
    const secret = path.join(outside, "secret.txt");
    fs.writeFileSync(secret, "top secret");
    // A file inside the root that now resolves out of it: the reason containment
    // is re-checked at read time rather than trusted from the listing.
    const link = path.join(root, "innocent.txt");
    fs.symlinkSync(secret, link);

    const artifacts = deriveArtifacts([entry(1, "write", { path: link, content: "x" })], [canonicalPath(root)]);
    const listed = artifacts[0] ?? { key: "innocent.txt", root: canonicalPath(root), path: link, wrote: 1, edited: 0 };
    assert.throws(() => readArtifact({ ...listed, path: link }), /outside its root/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("redaction is applied on the way out", () => {
  const root = tempDir();
  try {
    const file = path.join(root, "env.txt");
    fs.writeFileSync(file, "KEY=sk-secret-value\n");
    const artifacts = deriveArtifacts([entry(1, "write", { path: file, content: "x" })], [canonicalPath(root)]);
    const read = readArtifact(artifacts[0], { redact: (text) => text.replace("sk-secret-value", "[secret:KEY]") });
    assert.equal(read.content, "KEY=[secret:KEY]\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
