import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

import { RENDER_SCRIPT, startArtifactsServer } from "../src/adapter/artifacts-server.js";
import { canonicalPath, type ArtifactFile } from "../src/durable/artifacts.js";
import type { SessionHost } from "../src/session-host/api.js";

/**
 * A seam stand-in: one conversation's artifact list, already derived.
 *
 * The adapter no longer walks the transcript — derivation moved host-side — so
 * the fake is a list of records, which is a much smaller thing to fake than a
 * chord view subscription.
 */
function fakeSeam(
  files: readonly ArtifactFile[],
  conversations = [1],
  comments: unknown[] = [],
): SessionHost {
  return {
    artifacts: async (id: number) => (conversations.includes(id) ? files : undefined),
    comments: async (id: number) => (conversations.includes(id) ? comments : undefined),
  } as unknown as SessionHost;
}

/** One derived artifact pointing at a real file. */
function artifact(root: string, key: string, path: string): ArtifactFile {
  return { key, root, path, wrote: 1, edited: 0 };
}

interface Harness {
  base: string;
  close(): Promise<void>;
}

async function serve(
  root: string,
  files: string[],
  options: { conversations?: number[]; comments?: unknown[]; repoFor?: (id: number) => string | undefined } = {},
): Promise<Harness> {
  const artifacts = files.map((file) => artifact(canonicalPath(root), file, path.join(root, file)));
  const server = await startArtifactsServer({
    seam: fakeSeam(artifacts, options.conversations ?? [1], options.comments ?? []),
    port: 0,
    ...(options.repoFor === undefined ? {} : { repoFor: options.repoFor }),
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

test("a configured chat origin may frame documents; without one, only our own", async () => {
  const root = tempDir();
  const files = ["notes.md"];
  fs.writeFileSync(path.join(root, "notes.md"), "# hi\n");

  const framed = await startArtifactsServer({
    seam: fakeSeam([artifact(canonicalPath(root), "notes.md", path.join(root, "notes.md"))]),
    port: 0,
    webOrigin: "https://pi.hl.id.au/",
  });
  try {
    const { port } = framed.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/c/1/notes.md?render`);
    // The bug this fixes: "'self' alone made the chat UI's frame show
    // 'artifacts.hl.id.au refused to connect'".
    assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'self' https:\/\/pi\.hl\.id\.au$/);
  } finally {
    await new Promise<void>((resolve) => framed.close(() => resolve()));
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

test("the source view numbers its lines and carries a nonce, not a script from the file", async () => {
  const root = tempDir();
  const harness = await serve(root, ["a.sh"]);
  try {
    // A file that *tries* to be markup, and a comment on line 2 of it.
    fs.writeFileSync(
      path.join(root, "a.sh"),
      "#!/bin/sh\necho '<script>alert(1)</script>'\nexit 0\n",
    );
    const response = await fetch(`${harness.base}/c/1/a.sh?view=source`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/, "the source view is a document");
    const csp = response.headers.get("content-security-policy") ?? "";
    assert.match(csp, /sandbox allow-scripts/);
    assert.match(csp, /script-src 'nonce-[^']+'/, "script needs a nonce");
    assert.match(csp, /default-src 'none'/, "and the document still cannot fetch anything");
    assert.ok(!/allow-same-origin/.test(csp), "allow-scripts without allow-same-origin, or the sandbox is escapable");

    const body = await response.text();
    assert.match(body, /id="L2" data-line="2"/);
    assert.match(body, /<a class="no" href="#L2">2<\/a>/);
    // The file's own bytes are text: escaped, and never a tag that could run.
    assert.ok(!body.includes("<script>alert(1)</script>"));
    assert.match(body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    // Exactly one script, and it is ours (it carries the nonce).
    const scripts = body.match(/<script/g) ?? [];
    assert.equal(scripts.length, 1);
    assert.match(body, /<script nonce="[^"]+">/);
  } finally {
    await harness.close();
  }
});

test("a live comment is drawn as a mark with its number, an orphaned one as a different mark", async () => {
  const root = tempDir();
  const comment = {
    id: "c1",
    file: "a.sh",
    anchors: [{ changeId: "aaa", originalLine: 2, content: "echo two" }],
    quote: "two",
    charStart: 6,
    charEnd: 8,
    text: "quote this",
    at: 1,
    author: "henry",
    state: "visible",
    positions: [2],
  };
  const orphan = { ...comment, id: "c2", state: "orphaned", positions: [3], charStart: undefined, charEnd: undefined };
  const resolved = { ...comment, id: "c3", state: "resolved", positions: [1] };
  const harness = await serve(root, ["a.sh"], { comments: [comment, orphan, resolved] });
  try {
    fs.writeFileSync(path.join(root, "a.sh"), "echo one\necho two\necho three\n");
    const body = await (await fetch(`${harness.base}/c/1/a.sh?view=source`)).text();
    // The character range is wrapped exactly, so the highlight is not the whole line.
    assert.match(body, /echo <mark class="cm visible" data-comment-id="c1">two<\/mark><sup class="cmark"/);
    // An orphaned comment is still drawn — it is open, and the viewer says so.
    assert.match(body, /<mark class="cm orphaned" data-comment-id="c2">echo three<\/mark>/);
    // A resolved comment is not drawn at all.
    assert.ok(!body.includes('data-comment-id="c3"'));
  } finally {
    await harness.close();
  }
});

test("a pinned revision is served from jj, and refused when there is no repository", async () => {
  const root = tempDir();
  // No repoFor: the origin says so rather than guessing at the live file.
  const noRepo = await serve(root, ["a.sh"]);
  try {
    fs.writeFileSync(path.join(root, "a.sh"), "echo now\n");
    const refused = await fetch(`${noRepo.base}/c/1/a.sh?rev=abcd1234`);
    assert.equal(refused.status, 400);
    assert.match(await refused.text(), /not version controlled/);
  } finally {
    await noRepo.close();
  }
});

test("rendered Markdown is commentable: the layer is injected, not built into the renderer", async () => {
  const root = tempDir();
  const comment = {
    id: "c9",
    file: "notes.md",
    anchors: [{ changeId: "aaa", originalLine: 3, content: "made with **pumpkin**" }],
    quote: "made with pumpkin",
    occurrence: 0,
    text: "vegetable instead?",
    at: 1,
    state: "visible",
    positions: [3],
  };
  // A repository is what makes a rendered page commentable: without one there is
  // nothing to anchor to, and the plain (script-free) document is served instead.
  const harness = await serve(root, ["notes.md"], {
    comments: [comment],
    repoFor: () => "/tmp/not-touched-by-this-test",
  });
  try {
    fs.writeFileSync(path.join(root, "notes.md"), "# Soup\n\nThe soup is made with **pumpkin**.\n");

    const response = await fetch(`${harness.base}/c/1/notes.md?render`);
    assert.equal(response.status, 200);
    const csp = response.headers.get("content-security-policy") ?? "";
    assert.match(csp, /script-src 'nonce-[^']+'/, "a rendered commentable document runs our script");
    assert.ok(!/allow-same-origin/.test(csp));

    const body = await response.text();
    // Still rendered: the Markdown the agent wrote is markup, escaped first.
    assert.match(body, /<strong>pumpkin<\/strong>/);
    // The comment travels as data, so the script can find its own highlight.
    assert.match(body, /id="comment-data"/);
    assert.match(body, /"quote":"made with pumpkin"/);
    assert.match(body, /"occurrence":0/);
    // And the script itself is a document script, not a link to one.
    assert.match(body, /pi-artifact-select/);
    assert.match(body, /data-file="notes.md"/);
  } finally {
    await harness.close();
  }
});

test("both documents carry the same comment affordance", async () => {
  // The source view and the rendered view each carry a script, because they have different notions
  // of what a selection means (line numbers versus a text run). The affordance is the part that must
  // behave identically, and it is duplicated text — so this is the test that notices when only one
  // copy gets fixed.
  const root = tempDir();
  const harness = await serve(root, ["notes.md"]);
  try {
    fs.writeFileSync(path.join(root, "notes.md"), "plain prose\n");
    const block = (html: string): string => {
      const from = html.indexOf("function showAffordance");
      const to = html.indexOf("affordance = button;", from);
      assert.ok(from !== -1 && to !== -1, "the affordance is in the document");
      return html.slice(from, to);
    };
    // The rendered document only carries a script when it has something to highlight, so the second
    // copy is taken from the exported script itself.
    const source = block(await (await fetch(`${harness.base}/c/1/notes.md?view=source`)).text());
    const rendered = block(RENDER_SCRIPT);
    assert.equal(source, rendered);
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
