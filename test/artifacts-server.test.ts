import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

import { startArtifactsServer } from "../src/adapter/artifacts-server.js";
import { canonicalPath, type ArtifactEntryLike } from "../src/durable/artifacts.js";
import type { BridgeHost } from "../src/durable/host.js";

/**
 * A host stand-in: one conversation whose entries are the tool calls given.
 *
 * The fake is deliberately four fields wide (`harness.conversation` returning
 * something with `viewState`) because that is the whole contract this server
 * has with the harness — and a fake that matched less would mean the server was
 * reaching for more.
 */
function fakeHost(entries: readonly ArtifactEntryLike[], conversations = [1]): BridgeHost {
  return {
    context: {},
    harness: {
      conversation: async (id: number) =>
        conversations.includes(id)
          ? {
              viewState: async () => ({ value: { entries }, dispose() {} }),
            }
          : undefined,
    },
  } as unknown as BridgeHost;
}

function entry(id: number, name: string, args: Record<string, unknown>): ArtifactEntryLike {
  return { id, model: [{ content: [{ type: "toolCall", name, arguments: args }] }] };
}

interface Harness {
  base: string;
  close(): Promise<void>;
}

async function serve(
  root: string,
  files: string[],
  options: { maxBytes?: number; conversations?: number[] } = {},
): Promise<Harness> {
  const entries = files.map((file, index) => entry(index + 1, "write", { path: path.join(root, file), content: "x" }));
  const server = await startArtifactsServer({
    host: fakeHost(entries, options.conversations ?? [1]),
    port: 0,
    roots: [canonicalPath(root)],
    ...(options.maxBytes === undefined ? {} : { redact: undefined }),
  });
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifact-server-"));
}

test("the index lists the conversation's artifacts with links", async () => {
  const root = tempDir();
  const harness = await serve(root, ["notes.md", "src/app.ts"]);
  try {
    fs.writeFileSync(path.join(root, "notes.md"), "# hi\n");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "app.ts"), "export {};\n");

    const response = await fetch(`${harness.base}/c/1/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    // Every document is sandboxed, so nothing it renders can execute.
    assert.match(response.headers.get("content-security-policy") ?? "", /sandbox/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");

    const html = await response.text();
    assert.ok(html.includes('href="notes.md"'), html);
    assert.ok(html.includes('href="src/app.ts"'), html);
    assert.ok(html.includes("2 files"), html);
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a file is served as plain text, never as HTML", async () => {
  const root = tempDir();
  const harness = await serve(root, ["notes.md"]);
  try {
    fs.writeFileSync(path.join(root, "notes.md"), "# Title\n\nbody\n");
    const response = await fetch(`${harness.base}/c/1/notes.md`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/plain/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(await response.text(), "# Title\n\nbody\n");
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("?render turns markdown into an escaped document", async () => {
  const root = tempDir();
  const harness = await serve(root, ["notes.md"]);
  try {
    fs.writeFileSync(path.join(root, "notes.md"), "# Title\n\n<script>alert(1)</script>\n");
    const response = await fetch(`${harness.base}/c/1/notes.md?render`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    const html = await response.text();
    assert.ok(html.includes("<h1>Title</h1>"), html);
    assert.ok(!html.includes("<script>"), html);
    assert.ok(html.includes("&lt;script&gt;"), html);
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a path that is not an artifact of this conversation is refused", async () => {
  const root = tempDir();
  const harness = await serve(root, ["notes.md"]);
  try {
    fs.writeFileSync(path.join(root, "notes.md"), "ok\n");
    fs.writeFileSync(path.join(root, "secret.txt"), "nope\n");

    // Listed: served. Present on disk but never written by the conversation: not.
    assert.equal((await fetch(`${harness.base}/c/1/secret.txt`)).status, 404);
    // Traversal is not an error path to sanitise — it is simply a key that is
    // not in the list, which is what makes the allow-list structural.
    assert.equal((await fetch(`${harness.base}/c/1/${encodeURIComponent("../etc/passwd")}`)).status, 404);
    assert.equal((await fetch(`${harness.base}/c/1/notes.md`)).status, 200);
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an unknown conversation is a 404, and mutating methods a 405", async () => {
  const root = tempDir();
  const harness = await serve(root, ["notes.md"], { conversations: [1] });
  try {
    fs.writeFileSync(path.join(root, "notes.md"), "ok\n");
    assert.equal((await fetch(`${harness.base}/c/999/`)).status, 404);

    const posted = await fetch(`${harness.base}/c/1/notes.md`, { method: "POST", body: "x" });
    assert.equal(posted.status, 405);
    assert.equal(posted.headers.get("allow"), "GET, HEAD");
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("binary artifacts are reported rather than served", async () => {
  const root = tempDir();
  const harness = await serve(root, ["blob.bin"]);
  try {
    fs.writeFileSync(path.join(root, "blob.bin"), Buffer.from([0x00, 0x01, 0x02]));
    const response = await fetch(`${harness.base}/c/1/blob.bin`);
    assert.equal(response.status, 415);
    assert.match(await response.text(), /looks binary/);
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("healthz answers without touching a conversation", async () => {
  const root = tempDir();
  const harness = await serve(root, []);
  try {
    const response = await fetch(`${harness.base}/healthz`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
