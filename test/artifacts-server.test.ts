import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import zlib from "node:zlib";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { RENDER_SCRIPT, startArtifactsServer } from "../src/web/artifacts-server.js";

/** The repository root, for the tests that load a client script as a file. */
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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

/** A 1x1 PNG, so the bytes are a real image rather than a shape that looks like one. */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

test("an image's bytes are served from ?raw, with an image type", async () => {
  // The bug: every artifact went through a UTF-8 decode, so a PNG was reported as
  // "binary" and refused. A picture has to come back byte for byte or it is not a
  // picture — every invalid UTF-8 sequence becomes U+FFFD on the way through.
  const root = tempDir();
  const harness = await serve(root, ["shot.png"]);
  try {
    fs.writeFileSync(path.join(root, "shot.png"), PNG_BYTES);
    const response = await fetch(`${harness.base}/c/1/shot.png?raw`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("content-disposition") ?? "", /^inline; filename="shot\.png"$/);

    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(bytes, PNG_BYTES, "the bytes are unchanged");
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the plain image URL is a document that centres the picture", async () => {
  // The reason this is not simply "the bytes": a browser paints an image
  // *document's* backdrop white whatever the theme, so a picture framed directly
  // arrived in a dark drawer as a white slab. A document with a stylesheet is the
  // only place the background can be made to follow the theme — and no response
  // header reaches it, which is why `Color-Scheme` is not the fix.
  const root = tempDir();
  const harness = await serve(root, ["shot.png"]);
  try {
    fs.writeFileSync(path.join(root, "shot.png"), PNG_BYTES);
    const response = await fetch(`${harness.base}/c/1/shot.png`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html/);

    const html = await response.text();
    // The picture, fetched from this same origin — never a remote host, never the
    // file's own bytes interpreted as markup.
    // The picture, and the class that makes it the gesture surface for a region
    // comment: without `touch-action: none` the browser keeps the drag for scrolling
    // and no rectangle can be drawn on a phone at all.
    assert.match(html, /<img class="crop-target" src="shot\.png\?raw"/);
    assert.match(html, /color-scheme: light dark/);
    assert.match(html, /background: Canvas/);
    assert.ok(html.includes('alt="shot.png"'), html);
    // The swipe script, which the other two document kinds have had all along. Its
    // absence was the bug: swiping across a *picture* did nothing, while swiping a
    // Markdown or source file worked — so every test that used Markdown passed and
    // the reader's phone did nothing.
    assert.match(html, /pi-artifact-swipe/);
    const nonce = /<script nonce="([^"]+)"/.exec(html);
    assert.ok(nonce, "the script carries a per-response nonce");
    assert.match(
      response.headers.get("content-security-policy") ?? "",
      new RegExp(`script-src 'nonce-${nonce![1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`),
    );
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the image document is sized so the picture is centred, not pushed down", async () => {
  // `height: 100%` plus `padding` adds the padding *outside* the 100%, so the content
  // box is taller than the frame and a centred picture sits visibly too high. Only a
  // real layout can catch it, and the fix (`box-sizing: border-box`) is one keyword —
  // which is exactly the kind of thing that gets removed again without a test.
  const root = tempDir();
  const harness = await serve(root, ["shot.png"]);
  try {
    fs.writeFileSync(path.join(root, "shot.png"), PNG_BYTES);
    const html = await (await fetch(`${harness.base}/c/1/shot.png`)).text();
    assert.match(html, /html, body \{ height: 100%; box-sizing: border-box; \}/);
    // Centring moved from `body` to the stage when the body became the scrolling window:
    // a transform-scaled picture needs something that grows with it, and the body cannot
    // be both that and the thing the zoom scrolls.
    assert.match(html, /<div class="stage">/);
    // Centred by an auto margin on the picture, not by `justify-content`. A flex container
    // centres a too-large item by overflowing it on the *start* side, which its scrollable
    // area cannot reach — so a zoomed picture's top-left was unreachable. Reported, and
    // fixed by letting the margin collapse to zero instead.
    assert.match(html, /\.stage > img \{ margin: auto; \}/);
    // And it is *fitted*: a screenshot wider than the drawer must scale down, not
    // scroll sideways.
    assert.match(html, /max-width: 100%; max-height: 100%; object-fit: contain/);
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the image document may load its own picture and nothing else", async () => {
  // `img-src 'self'` is the one allowance; everything else stays closed, so a
  // picture cannot become a page that fetches or runs anything.
  const root = tempDir();
  const harness = await serve(root, ["shot.png"]);
  try {
    fs.writeFileSync(path.join(root, "shot.png"), PNG_BYTES);
    const response = await fetch(`${harness.base}/c/1/shot.png`);
    const csp = response.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /img-src 'self' data:/);
    // Script is permitted *only* by nonce — one script, ours, for this response. The
    // picture's own bytes are still never parsed as markup, so the document is a
    // wrapper around an image and cannot reach anything else.
    assert.match(csp, /script-src 'nonce-[^']+'/);
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
    assert.doesNotMatch(csp, /script-src[^;]*\*/);
    // Still sandboxed and still only framable by this deployment's own UI.
    assert.match(csp, /sandbox/);
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("svg is not an image this viewer will draw", async () => {
  // An SVG is a document that can carry script. Serving it inline from the artifact
  // origin would be the HTML problem wearing a picture's extension, so it falls
  // through to the text path and is never given an image content type.
  const root = tempDir();
  const harness = await serve(root, ["logo.svg"]);
  try {
    fs.writeFileSync(path.join(root, "logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const response = await fetch(`${harness.base}/c/1/logo.svg?raw`);
    assert.equal(response.status, 200);
    const type = response.headers.get("content-type") ?? "";
    assert.ok(!type.startsWith("image/"), `served as ${type}`);
    assert.match(type, /^text\/plain/);
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a file named like an image is framed as one, whatever it holds", async () => {
  // The content type comes from the name, which is what a person reads and what the
  // drawer decided to frame. Naming a text file `.png` therefore gets it the image
  // wrapper and the browser draws nothing — which is the honest outcome, and
  // certainly better than sniffing the bytes and guessing HTML.
  const root = tempDir();
  const harness = await serve(root, ["notreally.png"]);
  try {
    fs.writeFileSync(path.join(root, "notreally.png"), "this is not a png\n");
    const document = await fetch(`${harness.base}/c/1/notreally.png`);
    assert.match(document.headers.get("content-type") ?? "", /^text\/html/);

    // And its bytes keep the image type they were asked for by name: the browser
    // declines to draw them, which is a refusal at the right layer.
    const raw = await fetch(`${harness.base}/c/1/notreally.png?raw`);
    assert.equal(raw.headers.get("content-type"), "image/png");
    assert.equal(await raw.text(), "this is not a png\n");
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("?download marks an image as an attachment rather than a page", async () => {
  const root = tempDir();
  const harness = await serve(root, ["shot.png"]);
  try {
    fs.writeFileSync(path.join(root, "shot.png"), PNG_BYTES);
    const response = await fetch(`${harness.base}/c/1/shot.png?raw&download`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-disposition") ?? "", /^attachment; filename="shot\.png"$/);
    // Still an image: a download is how it is delivered, not what it is.
    assert.equal(response.headers.get("content-type"), "image/png");
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a file that vanished after being listed explains itself, as a page", async () => {
  // The list is derived once, then read later; between the two a file can be renamed
  // or deleted. The answer used to be the bare line `unreadable: <key>` in a framed
  // blank panel, which says nothing about what happened or what to do.
  const root = tempDir();
  const harness = await serve(root, ["gone.png", "gone.md"]);
  try {
    fs.writeFileSync(path.join(root, "gone.png"), PNG_BYTES);
    fs.writeFileSync(path.join(root, "gone.md"), "text\n");
    // Listed and readable first, so the 404 below is about deletion rather than the
    // allow-list.
    assert.equal((await fetch(`${harness.base}/c/1/gone.png?raw`)).status, 200);
    assert.equal((await fetch(`${harness.base}/c/1/gone.md`)).status, 200);

    fs.rmSync(path.join(root, "gone.png"));
    fs.rmSync(path.join(root, "gone.md"));

    for (const pathUnderTest of ["gone.png", "gone.md"]) {
      const response = await fetch(`${harness.base}/c/1/${pathUnderTest}`);
      assert.equal(response.status, 404);
      // A document, not a line of text: the drawer frames this.
      assert.match(response.headers.get("content-type") ?? "", /^text\/html/);
      const html = await response.text();
      assert.match(html, /can no longer be read/);
      assert.ok(html.includes(pathUnderTest), "it names the file");
      assert.match(html, /renamed or deleted/);
      // Sandboxed like every other document here, so it cannot run anything.
      assert.match(response.headers.get("content-security-policy") ?? "", /sandbox/);
    }
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an image that is not on the allow-list is still a 404", async () => {
  // The new route must not become a way around the list: being an image is not
  // permission to be read.
  const root = tempDir();
  const harness = await serve(root, ["shot.png"]);
  try {
    fs.writeFileSync(path.join(root, "shot.png"), PNG_BYTES);
    fs.writeFileSync(path.join(root, "secret.png"), PNG_BYTES);
    assert.equal((await fetch(`${harness.base}/c/1/secret.png`)).status, 404);
    assert.equal((await fetch(`${harness.base}/c/999/shot.png`)).status, 404);
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

test("both documents carry the same swipe handling", async () => {
  // A rendered document and a source document are two copies of one script; a fix
  // applied to one is a fix the reader does not get in the other. This is the same
  // guard as the affordance test above, for the gesture code.
  const root = tempDir();
  const harness = await serve(root, ["notes.md"]);
  try {
    fs.writeFileSync(path.join(root, "notes.md"), "plain prose\n");
    const block = (html: string, from: string, to: string): string => {
      const start = html.indexOf(from);
      const end = html.indexOf(to, start);
      assert.ok(start !== -1 && end !== -1, `${from} is in the document`);
      return html.slice(start, end);
    };
    const from = "// --- Swiping between artifacts";
    const to = 'parent.postMessage({ t: "pi-artifact-ready"';
    const source = block(await (await fetch(`${harness.base}/c/1/notes.md?view=source`)).text(), from, to);
    const rendered = block(RENDER_SCRIPT, from, to);
    assert.equal(source, rendered);
    // And the gesture is real, not just a comment: both input kinds are wired.
    assert.match(source, /touchstart/);
    assert.match(source, /touchend/);
    assert.match(source, /"wheel"/);
    assert.match(source, /pi-artifact-swipe/);
    // The iOS case: a gesture the system claims ends in `touchcancel`, not
    // `touchend`. Listening only for touchend works on desktop Chromium and does
    // nothing on a phone, which is exactly what happened in the field.
    assert.match(source, /"touchcancel", settle/);
    assert.match(source, /"touchmove"/);
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a document keeps vertical scrolling but claims horizontal panning", async () => {
  // Without this the platform owns a sideways drag — on iOS as a back-navigation
  // gesture — and the swipe script never sees an end to judge. `pan-y` keeps
  // scrolling, which is what a long source file needs.
  const root = tempDir();
  const harness = await serve(root, ["notes.md"]);
  try {
    fs.writeFileSync(path.join(root, "notes.md"), "# hi\n");
    for (const view of ["?view=source", "?render"]) {
      const html = await (await fetch(`${harness.base}/c/1/notes.md${view}`)).text();
      assert.match(html, /touch-action: pan-y pinch-zoom/, `${view} claims horizontal panning`);
    }
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
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

/**
 * A real RGBA PNG, `size` by `size`, built here so a crop has something to decode.
 *
 * The 1×1 fixture above is deliberately not used: a rectangle inside a 1-pixel picture
 * is not a selection, so a test of the crop needs pixels to select.
 */
function pngOfSize(size: number): Buffer {
  const crcTable: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buffer: Buffer): number => {
    let crc = 0xffffffff;
    for (const byte of buffer) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]!;
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
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const at = y * (size * 4 + 1) + 1 + x * 4;
      raw[at] = x * 4;
      raw[at + 1] = y * 4;
      raw[at + 2] = 128;
      raw[at + 3] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The width and height an image declares in its own header. */
function sizeOfPng(bytes: Buffer): { width: number; height: number } {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test("?region cuts the selected rectangle out of the picture", async () => {
  // The whole point of an image comment: the model is shown the part the reader pointed
  // at, not only told where it is. The rectangle is in the picture's own pixels, so the
  // crop is too — no scaling between what was drawn and what is sent.
  const root = tempDir();
  const harness = await serve(root, ["shot.png"]);
  try {
    fs.writeFileSync(path.join(root, "shot.png"), pngOfSize(64));
    const response = await fetch(`${harness.base}/c/1/shot.png?region=x4,y8,w16,h12`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    const bytes = Buffer.from(await response.arrayBuffer());
    // A PNG whatever the source format was, and the *rectangle's* size rather than the
    // picture's — 16x12, not 64x64.
    assert.deepEqual(sizeOfPng(bytes), { width: 16, height: 12 });
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a region outside the picture is clamped, and nonsense is refused", async () => {
  const root = tempDir();
  const harness = await serve(root, ["shot.png"]);
  try {
    fs.writeFileSync(path.join(root, "shot.png"), pngOfSize(32));
    // Dragged off the right edge: the part over the picture is the part selected.
    const clamped = await fetch(`${harness.base}/c/1/shot.png?region=x24,y24,w40,h40`);
    assert.equal(clamped.status, 200);
    assert.deepEqual(sizeOfPng(Buffer.from(await clamped.arrayBuffer())), { width: 8, height: 8 });

    // A shape that names no rectangle does not become a crop of the whole picture.
    for (const bad of ["x4,y4", "garbage", "x4,y4,w0,h0", "x-1,y0,w8,h8"]) {
      const response = await fetch(`${harness.base}/c/1/shot.png?region=${encodeURIComponent(bad)}`);
      assert.equal(response.status, 404, `refused: ${bad}`);
    }
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a region of a file that is not a decodable picture is refused, not guessed at", async () => {
  const root = tempDir();
  const harness = await serve(root, ["notreally.png"]);
  try {
    // Named like an image, holds text. The browser will not draw it either, and a crop
    // of it would be an attachment of noise.
    fs.writeFileSync(path.join(root, "notreally.png"), "this is not a png\n");
    const response = await fetch(`${harness.base}/c/1/notreally.png?region=x0,y0,w8,h8`);
    assert.equal(response.status, 404);
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the image document carries the region script, and refuses network like the rest", async () => {
  const root = tempDir();
  const harness = await serve(root, ["shot.png"]);
  try {
    fs.writeFileSync(path.join(root, "shot.png"), PNG_BYTES);
    const response = await fetch(`${harness.base}/c/1/shot.png`);
    const html = await response.text();
    // The gesture, and the file it is about: the parent is told which artifact a
    // rectangle belongs to, because a drawer can show several.
    assert.match(html, /pi-artifact-region/);
    assert.ok(html.includes('data-file="shot.png"'), html);
    // The script talks to the parent and nothing else: `default-src 'none'` still holds,
    // so a rectangle cannot be posted anywhere but the drawer.
    const csp = response.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'none'/);
    assert.doesNotMatch(csp, /connect-src/);
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** A two-page PDF, written by PyMuPDF, so a page can be rendered for real. */
function writePdf(target: string): boolean {
  const result = spawnSync(
    "python3",
    [
      "-c",
      [
        "import sys, pymupdf",
        "document = pymupdf.open()",
        "page = document.new_page()",
        "page.insert_text((72, 72), 'first page of the document')",
        "second = document.new_page()",
        "second.insert_text((72, 72), 'second page of the document')",
        "document.save(sys.argv[1])",
      ].join("\n"),
      target,
    ],
    { encoding: "utf8" },
  );
  return result.status === 0;
}

/** The size a PNG declares in its IHDR. */
function pngDimensions(bytes: Buffer): { width: number; height: number } {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const pdfAvailable = (() => {
  const probe = spawnSync("python3", ["-c", "import pymupdf"], { encoding: "utf8" });
  return probe.status === 0;
})();

test("a PDF is served as a document around a rendered page", { skip: !pdfAvailable && "pymupdf is not available" }, async () => {
  // The reader's request: clicking a PDF in the drawer should show the document, not
  // "looks binary". What is framed is one *page*, rasterised, because a page is what a
  // rectangle can be drawn on — the PDF itself is what ↗ opens.
  const root = tempDir();
  const harness = await serve(root, ["resume.pdf"]);
  try {
    assert.ok(writePdf(path.join(root, "resume.pdf")));
    const response = await fetch(`${harness.base}/c/1/resume.pdf`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html/);

    const html = await response.text();
    // The page, as a sibling PNG URL, and the same gesture surface a picture has.
    assert.match(html, /<img class="crop-target" src="resume\.pdf\?page=1&amp;png"/);
    assert.ok(html.includes("pi-artifact-region"), "the region script is there");
    assert.ok(html.includes('class="pages"'), "and the paging strip");
    assert.ok(html.includes("page 1 of 2"), html);
    assert.ok(html.includes('data-file="resume.pdf"'), html);
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a PDF page is available as a PNG, and a page that does not exist is refused", { skip: !pdfAvailable && "pymupdf is not available" }, async () => {
  const root = tempDir();
  const harness = await serve(root, ["resume.pdf"]);
  try {
    assert.ok(writePdf(path.join(root, "resume.pdf")));

    const page = await fetch(`${harness.base}/c/1/resume.pdf?page=2&png`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("content-type"), "image/png");
    const bytes = Buffer.from(await page.arrayBuffer());
    const size = pngDimensions(bytes);
    // A4 at 150 dpi. The exact number is not the point; that it is a page-sized raster
    // rather than the document's bytes is.
    assert.ok(size.width > 1000 && size.height > 1000, JSON.stringify(size));

    // Past the end: an honest 404, not an empty image.
    assert.equal((await fetch(`${harness.base}/c/1/resume.pdf?page=9&png`)).status, 404);
    assert.equal((await fetch(`${harness.base}/c/1/resume.pdf?page=0&png`)).status, 404);
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a region of a PDF page is cropped from that page", { skip: !pdfAvailable && "pymupdf is not available" }, async () => {
  // The comment path: a rectangle on page 2 must be cut from page 2. Getting this
  // wrong is invisible in a single-page document and wrong in every real one.
  const root = tempDir();
  const harness = await serve(root, ["resume.pdf"]);
  try {
    assert.ok(writePdf(path.join(root, "resume.pdf")));
    const response = await fetch(`${harness.base}/c/1/resume.pdf?page=2&png&region=x100,y120,w400,h300`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.deepEqual(pngDimensions(Buffer.from(await response.arrayBuffer())), { width: 400, height: 300 });

    // And the rectangle is checked against the *page*, so nonsense is refused.
    assert.equal((await fetch(`${harness.base}/c/1/resume.pdf?page=2&png&region=garbage`)).status, 404);
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("?raw serves the PDF itself, for the browser's own viewer", { skip: !pdfAvailable && "pymupdf is not available" }, async () => {
  // A rasterised page is for reviewing; the PDF is for reading. This is what ↗ opens,
  // and it must be the document itself — text selection, links and zoom intact.
  const root = tempDir();
  const harness = await serve(root, ["resume.pdf"]);
  try {
    assert.ok(writePdf(path.join(root, "resume.pdf")));
    const response = await fetch(`${harness.base}/c/1/resume.pdf?raw`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/pdf");
    assert.match(response.headers.get("content-disposition") ?? "", /^inline; filename="resume\.pdf"$/);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.subarray(0, 5).toString("ascii"), "%PDF-", "the document's own bytes");
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a PDF that cannot be opened is refused, not served as garbage", { skip: !pdfAvailable && "pymupdf is not available" }, async () => {
  const root = tempDir();
  const harness = await serve(root, ["broken.pdf"]);
  try {
    // Named like a PDF, holds text. The renderer refuses it; the viewer must not turn
    // that into a page of noise.
    fs.writeFileSync(path.join(root, "broken.pdf"), "this is not a pdf\n");
    assert.equal((await fetch(`${harness.base}/c/1/broken.pdf`)).status, 404);
    assert.equal((await fetch(`${harness.base}/c/1/broken.pdf?page=1&png`)).status, 404);
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the picture document never asks the browser to zoom it", async () => {
  // The reported bug: pinching a picture zoomed the *drawer* — header, comment button and
  // all — because a browser's pinch-zoom scales the visual viewport, which belongs to the
  // top-level page, not to this iframe. Zoom has to be this document's own.
  //
  // So `pinch-zoom` must not appear in the image document's own touch-action, and the
  // script must carry the transform-based zoom instead. The scale itself is proven in the
  // browser test; this is the assertion that the page never cedes zoom to the browser.
  const root = tempDir();
  const harness = await serve(root, ["shot.png"]);
  try {
    fs.writeFileSync(path.join(root, "shot.png"), PNG_BYTES);
    const html = await (await fetch(`${harness.base}/c/1/shot.png`)).text();

    // The picture document's own rule. (The source view may still say `pan-y pinch-zoom`:
    // it has no zoom of its own, and text benefits from the browser's.)
    // Comments out: the word appears in the prose explaining why it is gone.
    const imageDocumentCss = html
      .slice(0, html.indexOf("</style>"))
      .replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(imageDocumentCss, /pinch-zoom/, "the browser must not zoom this frame");

    // The zoom that replaces it: a scale on the picture, and the gestures that drive it.
    assert.match(imageDocumentCss, /will-change: transform/);
    assert.ok(html.includes("function zoomAbout"), "zoom happens in the document");
    assert.ok(html.includes("event.ctrlKey"), "a trackpad's pinch is handled");
    assert.ok(html.includes("distanceBetween"), "two fingers are handled");
    // And the scrolling window can contain its own pan rather than passing it to the drawer.
    assert.match(imageDocumentCss, /overscroll-behavior: contain/);
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a zoomed picture keeps the drag until it has none left in that direction", () => {
  // The reader's rule: page to the next artifact only when the picture cannot be dragged any
  // further *that way*. It is the whole reason `gesture.js` exists, and it is arithmetic —
  // so it is tested as arithmetic, by running the real file.
  //
  // This used to regex the served script for `dx > 0 ? pannable.left : pannable.right`, which
  // passed as long as that line was spelled that way and said nothing about what it did. The
  // logic is one small object now, so it can be loaded and asked.
  const source = fs.readFileSync(path.join(projectRoot, "src/web/client/gesture.js"), "utf8");
  const owner = new Function(`${source}; return gestureOwner;`)() as {
    report(next: { armed?: boolean; panLeft?: boolean; panRight?: boolean }): void;
    owns(dx: number): boolean;
  };

  // At fit: nothing to pan, so the drawer owns every horizontal drag.
  owner.report({});
  assert.equal(owner.owns(-40), false, "a leftward drag pages when there is nothing to pan");
  assert.equal(owner.owns(40), false, "and so does a rightward one");

  // Zoomed, in the middle: the picture pans both ways, so the drawer gets nothing.
  owner.report({ panLeft: true, panRight: true });
  assert.equal(owner.owns(-40), true);
  assert.equal(owner.owns(40), true);

  // Against the left edge: a finger moving *right* has content to the left and pans; one
  // moving left has nowhere to go, so that direction is the drawer's.
  owner.report({ panLeft: true, panRight: false });
  assert.equal(owner.owns(40), true, "rightward still pans, there is content to the left");
  assert.equal(owner.owns(-40), false, "leftward pages, the picture is pinned to that edge");

  // Against the right edge, the mirror image.
  owner.report({ panLeft: false, panRight: true });
  assert.equal(owner.owns(-40), true);
  assert.equal(owner.owns(40), false);

  // Armed: a rectangle has no direction, so it owns every horizontal drag whatever the pan
  // state says. This is the case that matters most — it is the reader's finger mid-selection.
  owner.report({ armed: true, panLeft: false, panRight: false });
  assert.equal(owner.owns(-40), true);
  assert.equal(owner.owns(40), true);
});

test("a zoomed picture is pinned to its fitted size, so the scroll extent is right", async () => {
  // The bug: growing the stage to fit*zoom let the img lay out larger than fit — it is
  // `max-width: 100%` of its container, so a bigger container gives a bigger picture — and
  // the transform then scaled *that*. Stage and picture disagreed about the picture's size,
  // so the scroll extent was too small and the picture could not be dragged to its edges:
  // it ran out of room before the content did, and the top and left were unreachable.
  //
  // The fix is that the picture's layout box is pinned to the fitted pixels while zoomed,
  // so the transform is the only thing changing its size and the stage can be sized from
  // the same number.
  const root = tempDir();
  const harness = await serve(root, ["shot.png"]);
  try {
    fs.writeFileSync(path.join(root, "shot.png"), PNG_BYTES);
    const html = await (await fetch(`${harness.base}/c/1/shot.png`)).text();

    // Measuring releases every inline size, including the pin — otherwise a re-measure
    // while zoomed reports the pinned box as "the fit".
    assert.match(html, /function measureFit\(\)/);
    assert.match(html, /image\.style\.maxWidth = ""/);
    // Zoom pins the layout box before sizing the stage from the *same* measurement.
    assert.match(html, /image\.style\.width = fit\.width \+ "px"/);
    assert.match(html, /var width = Math\.round\(fit\.width \* zoom\)/);
    // And unzooming releases all of it, so the stylesheet lays the picture out again.
    assert.match(html, /image\.style\.width = "";/);
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- Audio -------------------------------------------------------------------

/** A short, real WAV: 8 frames of silence at 8 kHz, mono, 16-bit. */
function wavBytes(frames = 8): Buffer {
  const data = Buffer.alloc(frames * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(8000, 24); // sample rate
  header.writeUInt32LE(8000 * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

test("audio's bytes are served from ?raw with an audio type, unchanged", async () => {
  const root = tempDir();
  const harness = await serve(root, ["story.wav"]);
  try {
    const bytes = wavBytes(64);
    fs.writeFileSync(path.join(root, "story.wav"), bytes);
    const response = await fetch(`${harness.base}/c/1/story.wav?raw`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "audio/wav");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("cache-control"), "no-store");
    // Tells a media element it may scrub by asking for a range.
    assert.equal(response.headers.get("accept-ranges"), "bytes");
    assert.match(response.headers.get("content-disposition") ?? "", /^inline; filename="story\.wav"$/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a range request answers 206 with exactly that slice", async () => {
  // Not an optimisation: Safari refuses to play a media element from a server that
  // never answers 206, and a scrubber dragged to the middle must not re-download the
  // start. This is the behaviour the progress bar depends on.
  const root = tempDir();
  const harness = await serve(root, ["story.wav"]);
  try {
    const bytes = wavBytes(64);
    fs.writeFileSync(path.join(root, "story.wav"), bytes);
    const response = await fetch(`${harness.base}/c/1/story.wav?raw`, {
      headers: { Range: "bytes=10-19" },
    });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-type"), "audio/wav");
    assert.equal(response.headers.get("content-range"), `bytes 10-19/${bytes.length}`);
    assert.equal(response.headers.get("content-length"), "10");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(10, 20));
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an open-ended range runs to the end, and a suffix range from the end", async () => {
  const root = tempDir();
  const harness = await serve(root, ["story.wav"]);
  try {
    const bytes = wavBytes(64);
    fs.writeFileSync(path.join(root, "story.wav"), bytes);

    // "from 60 to the end" — what a seek to the tail asks for.
    const open = await fetch(`${harness.base}/c/1/story.wav?raw`, { headers: { Range: "bytes=60-" } });
    assert.equal(open.status, 206);
    assert.equal(open.headers.get("content-range"), `bytes 60-${bytes.length - 1}/${bytes.length}`);

    // "the last 8 bytes" — how a player reads a container's trailing index.
    const suffix = await fetch(`${harness.base}/c/1/story.wav?raw`, { headers: { Range: "bytes=-8" } });
    assert.equal(suffix.status, 206);
    assert.equal(
      suffix.headers.get("content-range"),
      `bytes ${bytes.length - 8}-${bytes.length - 1}/${bytes.length}`,
    );
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a range past the end is 416, not a truncated file", async () => {
  // The honest answer: a player with a stale idea of the length is told the real one,
  // rather than being handed a zero-length 206 it would read as a corrupt file.
  const root = tempDir();
  const harness = await serve(root, ["story.wav"]);
  try {
    const bytes = wavBytes(64);
    fs.writeFileSync(path.join(root, "story.wav"), bytes);
    const response = await fetch(`${harness.base}/c/1/story.wav?raw`, {
      headers: { Range: `bytes=${bytes.length}-` },
    });
    assert.equal(response.status, 416);
    assert.equal(response.headers.get("content-range"), `bytes */${bytes.length}`);
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the plain audio URL is a player document with our own controls", async () => {
  // A raw audio document in a frame gets the browser's native controls, which follow
  // the browser's theme and cannot show a scrub bar sized to the drawer or an
  // elapsed/total readout. So the drawer frames a document, as it does for a picture.
  const root = tempDir();
  const harness = await serve(root, ["story.wav"]);
  try {
    fs.writeFileSync(path.join(root, "story.wav"), wavBytes(64));
    const response = await fetch(`${harness.base}/c/1/story.wav`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    const html = await response.text();

    // The element is behind the controls, not the interface itself.
    assert.match(html, /<audio preload="metadata" src="story\.wav\?raw">/);
    assert.match(html, /class="play"/);
    assert.match(html, /type="range"/);
    assert.match(html, /class="elapsed"/);
    assert.match(html, /class="total"/);
    // The player script is ours and carries the nonce, not an inline reference to a file.
    assert.match(html, /<script nonce="[^"]+">/);
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the player document may load its own audio and nothing else", async () => {
  const root = tempDir();
  const harness = await serve(root, ["story.wav"]);
  try {
    fs.writeFileSync(path.join(root, "story.wav"), wavBytes(64));
    const response = await fetch(`${harness.base}/c/1/story.wav`);
    const csp = response.headers.get("content-security-policy") ?? "";
    // The file it was made for, and no remote host.
    assert.match(csp, /media-src 'self'/);
    assert.match(csp, /default-src 'none'/);
    // Same rule as every other scripted document: the origin stays opaque.
    assert.match(csp, /sandbox allow-scripts/);
    assert.doesNotMatch(csp, /allow-same-origin/);
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a file named like audio is framed as one, whatever it holds", async () => {
  // The type comes from the name, like every other decision in this viewer: the name is
  // what a person reads, and a .wav that is not one fails at the demuxer with a reason.
  const root = tempDir();
  const harness = await serve(root, ["fake.wav"]);
  try {
    fs.writeFileSync(path.join(root, "fake.wav"), "this is not audio\n");
    const raw = await fetch(`${harness.base}/c/1/fake.wav?raw`);
    assert.equal(raw.headers.get("content-type"), "audio/wav");
    assert.equal(await raw.text(), "this is not audio\n");
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the player claims its own keys, so paging is not lost to them", async () => {
  // The drawer's own keydown listener lives on the *parent* document and pages with
  // the arrow keys. A player that handled arrows without this reasoning would be a
  // second claimant; because the frame is a cross-origin sandboxed document, its keys
  // never reach the parent, so the two cannot fight. This asserts the player really
  // does handle them, which is what makes that reasoning load-bearing.
  const root = tempDir();
  const harness = await serve(root, ["story.wav"]);
  try {
    fs.writeFileSync(path.join(root, "story.wav"), wavBytes(64));
    const html = await (await fetch(`${harness.base}/c/1/story.wav`)).text();
    assert.match(html, /event\.key === ' '/);
    assert.match(html, /event\.key === 'ArrowLeft'/);
    assert.match(html, /event\.key === 'ArrowRight'/);
    // Space is not taken from a focused scrubber: the browser already owns it there.
    assert.match(html, /if \(event\.target === seek\) return;/);
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("?download on a text artifact is an attachment, not another inline view", async () => {
  // The drawer's ⤓ saves the file. A text artifact was always served inline, which is
  // right for the frame and wrong for a download: the browser would show it rather than
  // save it, and `run_tts.sh` would arrive named after whatever the URL derived.
  const root = tempDir();
  const harness = await serve(root, ["run_tts.sh"]);
  try {
    fs.writeFileSync(path.join(root, "run_tts.sh"), "#!/bin/bash\necho hi\n");
    const plain = await fetch(`${harness.base}/c/1/run_tts.sh`);
    assert.match(plain.headers.get("content-disposition") ?? "", /^inline;/);

    const saved = await fetch(`${harness.base}/c/1/run_tts.sh?download`);
    assert.equal(saved.status, 200);
    assert.match(saved.headers.get("content-disposition") ?? "", /^attachment; filename="run_tts\.sh"$/);
    // The bytes are still the file's own, so a save is byte-identical to the artifact.
    assert.equal(await saved.text(), "#!/bin/bash\necho hi\n");
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("?download marks audio as an attachment, and still honours a range", async () => {
  // A download must not be answered as a media stream: `attachment` is what makes the
  // browser save instead of opening its player. Range support is unchanged, so a
  // resumed download still works.
  const root = tempDir();
  const harness = await serve(root, ["story.wav"]);
  try {
    const bytes = wavBytes(64);
    fs.writeFileSync(path.join(root, "story.wav"), bytes);
    const saved = await fetch(`${harness.base}/c/1/story.wav?raw&download`);
    assert.equal(saved.status, 200);
    assert.match(saved.headers.get("content-disposition") ?? "", /^attachment; filename="story\.wav"$/);
    assert.equal(saved.headers.get("accept-ranges"), "bytes");
    assert.deepEqual(Buffer.from(await saved.arrayBuffer()), bytes);
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the download button appears and hides with the others, and saves the raw file", async () => {
  // A header button with no wiring is invisible in review and obvious on screen, so this
  // asserts the four things that make it work: it exists, it follows the same show/hide
  // as ↗, it knows which key is open, and it points at the *raw* bytes as an attachment
  // rather than at the document the frame is showing.
  const page = fs.readFileSync(path.join(projectRoot, "src/web/page.html"), "utf8");
  assert.match(page, /<button id="artifacts-download"[^>]*hidden>/, page);
  assert.match(page, /id="artifacts-download"[^>]*aria-label="Download this file"/);

  const client = fs.readFileSync(path.join(projectRoot, "src/web/artifacts.js"), "utf8");
  // Shown and hidden exactly where ↗ is, so the two can never disagree about whether
  // there is a document open.
  assert.match(client, /artifactsNewTab\.hidden = false;\s*\n\s*artifactsDownload\.hidden = false;/);
  assert.match(client, /artifactsNewTab\.hidden = true;\s*\n\s*artifactsDownload\.hidden = true;/);
  // The key is recorded on open and on a step, which are the two ways a document changes.
  assert.equal((client.match(/artifactsDownload\.dataset\.key = /g) ?? []).length, 2);
  // `?raw&download`: the file's own bytes, as an attachment.
  assert.match(client, /'\?raw&download'/);
});

// --- Apps --------------------------------------------------------------------
//
// An app is any directory holding app.json. The tests below are about the *mechanism*
// — discovery, containment, headers, types — and deliberately name no particular app,
// because the bridge does not know what an app is for and must not start knowing.

/** Serve a conversation directory, so `/apps/...` has somewhere to look. */
async function serveWithApps(root: string, conversationDir: string): Promise<Harness> {
  const server = await startArtifactsServer({
    seam: fakeSeam([], [1], []),
    port: 0,
    conversationDirFor: (id: number) => (id === 1 ? conversationDir : undefined),
  });
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Write one app into a conversation directory. */
function writeApp(conversationDir: string, name: string, files: Record<string, string>, manifest = {}): void {
  const dir = path.join(conversationDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "app.json"), JSON.stringify(manifest));
  for (const [file, content] of Object.entries(files)) {
    const at = path.join(dir, file);
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.writeFileSync(at, content);
  }
}

test("a directory with app.json is an app, and the index lists it", async () => {
  const root = tempDir();
  const conversationDir = path.join(root, "conversation", "1");
  fs.mkdirSync(conversationDir, { recursive: true });
  writeApp(conversationDir, "bench", { "index.html": "<h1>hi</h1>" }, { name: "Bench", description: "times a model" });
  // Not an app: no marker, so it is just a directory that would otherwise be served.
  fs.mkdirSync(path.join(conversationDir, "scratch"), { recursive: true });
  fs.writeFileSync(path.join(conversationDir, "scratch", "index.html"), "<h1>no</h1>");

  const harness = await serveWithApps(root, conversationDir);
  try {
    const response = await fetch(`${harness.base}/apps/1/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    const html = await response.text();
    assert.match(html, /href="\/apps\/1\/bench\/"/);
    assert.match(html, />Bench</);
    assert.match(html, /times a model/);
    // The unmarked directory is not offered.
    assert.doesNotMatch(html, /scratch/);
    // The index is inert: it is our markup, so it keeps the sandbox.
    assert.match(response.headers.get("content-security-policy") ?? "", /sandbox/);
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an app's files are served with the types a bundle needs", async () => {
  // The three load-bearing ones: a module script is refused unless it is a JavaScript
  // type, and instantiateStreaming is refused unless wasm is application/wasm. Getting
  // either wrong is a page that half-works.
  const root = tempDir();
  const conversationDir = path.join(root, "conversation", "1");
  fs.mkdirSync(conversationDir, { recursive: true });
  writeApp(conversationDir, "bench", {
    "index.html": "<!doctype html><title>app</title>",
    "app.js": "export const x = 1;",
    "lib.wasm": "\0asm",
    "cfg.json": "{}",
    "model.gguf": "x",
  });

  const harness = await serveWithApps(root, conversationDir);
  try {
    const at = async (p: string) => (await fetch(`${harness.base}/apps/1/bench/${p}`)).headers.get("content-type");
    assert.match(await at("app.js") ?? "", /text\/javascript/);
    assert.equal(await at("lib.wasm"), "application/wasm");
    assert.match(await at("cfg.json") ?? "", /application\/json/);
    // An unknown binary downloads rather than rendering.
    assert.equal(await at("model.gguf"), "application/octet-stream");
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the app root serves index.html, whatever the trailing slash", async () => {
  // A relative <script src="app.js"> has to resolve against the same directory either
  // way, so the root is answered rather than redirected.
  const root = tempDir();
  const conversationDir = path.join(root, "conversation", "1");
  fs.mkdirSync(conversationDir, { recursive: true });
  writeApp(conversationDir, "bench", { "index.html": "<!doctype html><title>index</title>" });

  const harness = await serveWithApps(root, conversationDir);
  try {
    for (const p of ["/apps/1/bench/", "/apps/1/bench"]) {
      const response = await fetch(`${harness.base}${p}`);
      assert.equal(response.status, 200, p);
      assert.match(await response.text(), /<title>index<\/title>/, p);
    }
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an app page is cross-origin isolated, because a wasm bundle waits forever without it", async () => {
  // A pthread build asks for SharedArrayBuffer at startup. Without COOP+COEP the page is
  // not isolated, the ask never resolves, and the app hangs with no error at all.
  const root = tempDir();
  const conversationDir = path.join(root, "conversation", "1");
  fs.mkdirSync(conversationDir, { recursive: true });
  writeApp(conversationDir, "bench", { "index.html": "<!doctype html><title>app</title>" });

  const harness = await serveWithApps(root, conversationDir);
  try {
    const response = await fetch(`${harness.base}/apps/1/bench/`);
    assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin");
    assert.equal(response.headers.get("cross-origin-embedder-policy"), "require-corp");
    assert.equal(response.headers.get("cross-origin-resource-policy"), "cross-origin");

    const csp = response.headers.get("content-security-policy") ?? "";
    // Rust-style CSP: the bundle's wasm must be allowed to instantiate.
    assert.match(csp, /'wasm-unsafe-eval'/);
    // An app runs script, so it is the one document here that is not sandboxed.
    assert.doesNotMatch(csp, /sandbox/);
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a path cannot leave the app's own directory", async () => {
  // The one function standing between a URL and the filesystem. `..`, an absolute path,
  // and a symlink all have to be refused, and `.jj` too — that is the repository the
  // conversation's artifacts are committed to.
  const root = tempDir();
  const conversationDir = path.join(root, "conversation", "1");
  fs.mkdirSync(conversationDir, { recursive: true });
  writeApp(conversationDir, "bench", { "index.html": "<!doctype html><title>app</title>" });
  fs.mkdirSync(path.join(conversationDir, ".jj"), { recursive: true });
  fs.writeFileSync(path.join(conversationDir, ".jj", "secret"), "history");
  fs.writeFileSync(path.join(conversationDir, "outside.txt"), "not yours");
  // A symlink inside the app pointing out of it.
  fs.symlinkSync(path.join(conversationDir, "outside.txt"), path.join(conversationDir, "bench", "link.txt"));

  const harness = await serveWithApps(root, conversationDir);
  try {
    const refused = async (p: string, why: string) => {
      const response = await fetch(`${harness.base}/apps/1/bench/${p}`);
      assert.notEqual(response.status, 200, `${why} should not be served`);
    };
    await refused("../outside.txt", "parent traversal");
    await refused("..%2Foutside.txt", "encoded traversal");
    await refused("%2e%2e/outside.txt", "dot-dot");
    await refused("link.txt", "a symlink out of the directory");
    await refused(".jj/secret", "the repository");
    // The app's own files still work, so the refusals are not a blanket denial.
    assert.equal((await fetch(`${harness.base}/apps/1/bench/index.html`)).status, 200);
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a directory without app.json is not an app, and says how to become one", async () => {
  const root = tempDir();
  const conversationDir = path.join(root, "conversation", "1");
  fs.mkdirSync(path.join(conversationDir, "notes"), { recursive: true });
  fs.writeFileSync(path.join(conversationDir, "notes", "index.html"), "<h1>no</h1>");

  const harness = await serveWithApps(root, conversationDir);
  try {
    const response = await fetch(`${harness.base}/apps/1/notes/`);
    assert.equal(response.status, 404);
    assert.match(await response.text(), /app\.json/);
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("without a conversation directory, apps are explained rather than 404'd as missing", async () => {
  // A deployment that does not version artifacts has nowhere to look, and saying so beats
  // "no such app", which would send someone hunting for a file that was never the problem.
  const root = tempDir();
  const harness = await serve(root, ["notes.md"]);
  try {
    fs.writeFileSync(path.join(root, "notes.md"), "# hi\n");
    const response = await fetch(`${harness.base}/apps/1/bench/`);
    assert.equal(response.status, 404);
    assert.match(await response.text(), /does not host apps/);
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
