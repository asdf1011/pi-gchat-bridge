import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

import { JSDOM } from "jsdom";

import { RENDER_SCRIPT, startArtifactsServer } from "../src/adapter/artifacts-server.js";
import { canonicalPath, type ArtifactFile } from "../src/durable/artifacts.js";
import { deriveQuoteSelection, selectionFromOffsets } from "../src/durable/comments.js";
import type { SessionHost } from "../src/session-host/api.js";

/**
 * Selections that span lines, driven through the documents' own scripts.
 *
 * A multi-line comment is the case where every part of the pipeline changes shape at once: the
 * source view stops sending character offsets (the format cannot say "column 18 of line 3 to column
 * 5 of line 4"), the rendered view sends a quote that contains newlines, and the server has to map
 * that quote back onto a range. Each part was covered on its own; these tests cover the seam
 * between them, which is where a selection can arrive looking perfectly reasonable and anchor to
 * nothing.
 */

const prose = [
  "# Notes",
  "first line of prose",
  "second line of prose",
  "third line of prose",
  "last line",
].join("\n");

function fakeSeam(files: readonly ArtifactFile[]): SessionHost {
  return {
    artifacts: async (id: number) => (id === 1 ? files : undefined),
    comments: async (id: number) => (id === 1 ? [] : undefined),
  } as unknown as SessionHost;
}

async function serve(root: string, files: string[]): Promise<{ base: string; close(): Promise<void> }> {
  const artifacts = files.map(
    (file): ArtifactFile => ({ key: file, root: canonicalPath(root), path: path.join(root, file), wrote: 1, edited: 0 }),
  );
  const server = await startArtifactsServer({ seam: fakeSeam(artifacts), port: 0 });
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-comment-selection-"));
}

/** Two source lines' text nodes, for a selection that starts on one and ends on another. */
function lineText(dom: JSDOM, line: number): Node {
  const span = dom.window.document.querySelector(`[data-line="${line}"] .tx`);
  assert.ok(span, `line ${line} carries text`);
  const node = span.firstChild;
  assert.ok(node, `line ${line} has a text node to select`);
  return node;
}

/** A settled selection, then a click on the affordance it produced. */
async function commentOn(dom: JSDOM, from: Node, fromOffset: number, to: Node, toOffset: number): Promise<Record<string, unknown>> {
  const doc = dom.window.document;
  const range = doc.createRange();
  range.setStart(from, fromOffset);
  range.setEnd(to, toOffset);
  const selection = dom.window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  doc.dispatchEvent(new dom.window.Event("selectionchange"));

  // The settle is a timer inside the document; poll rather than sleep a fixed span, or the test goes
  // intermittently red under load.
  for (let i = 0; i < 100 && !doc.querySelector("button.cm-add"); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const button = doc.querySelector("button.cm-add");
  assert.ok(button, "a multi-line selection still offers the affordance");
  button!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  const posted = (dom.window as unknown as { posted: Record<string, unknown>[] }).posted;
  const selects = posted.filter((each) => each.t === "pi-artifact-select");
  assert.equal(selects.length, 1, "one click, one selection message (the document also announces itself once)");
  return selects[0];
}

test("a multi-line selection in the source view comments on the whole range", async () => {
  const root = tempDir();
  const harness = await serve(root, ["notes.md"]);
  try {
    fs.writeFileSync(path.join(root, "notes.md"), `${prose}\n`);
    const html = await (await fetch(`${harness.base}/c/1/notes.md?view=source`)).text();
    const dom = new JSDOM(html, {
      url: harness.base,
      runScripts: "dangerously",
      beforeParse(win) {
        (win as unknown as { posted: unknown[] }).posted = [];
        (win as unknown as { postMessage: (data: unknown) => void }).postMessage = (data) =>
          (win as unknown as { posted: unknown[] }).posted.push(data);
      },
    });
    try {
      // Lines 2 through 4: from the first character of one to the end of another.
      const last = lineText(dom, 4);
      const message = await commentOn(dom, lineText(dom, 2), 0, last, (last.nodeValue ?? "").length);

      assert.equal(message.t, "pi-artifact-select");
      assert.equal(message.intent, "comment");
      assert.equal(message.line, 2, "the comment starts where the selection starts");
      assert.equal(message.endLine, 4, "and ends where it ends");
      assert.match(String(message.quote), /first line of prose\s+second line of prose\s+third line of prose/);
      // The half of the message that must *not* be there: a two-dimensional range has no column
      // format, and sending one anyway would point the highlight at a few characters of one line.
      assert.equal(message.charStart, undefined);
      assert.equal(message.charEnd, undefined);
    } finally {
      dom.window.close();
    }
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a single-line selection still carries character offsets", async () => {
  // The guard on the test above: dropping offsets for every selection would look identical from the
  // comment's point of view until a word-level highlight landed on the wrong word.
  const root = tempDir();
  const harness = await serve(root, ["notes.md"]);
  try {
    fs.writeFileSync(path.join(root, "notes.md"), `${prose}\n`);
    const html = await (await fetch(`${harness.base}/c/1/notes.md?view=source`)).text();
    const dom = new JSDOM(html, {
      url: harness.base,
      runScripts: "dangerously",
      beforeParse(win) {
        (win as unknown as { posted: unknown[] }).posted = [];
        (win as unknown as { postMessage: (data: unknown) => void }).postMessage = (data) =>
          (win as unknown as { posted: unknown[] }).posted.push(data);
      },
    });
    try {
      const line = lineText(dom, 3);
      const message = await commentOn(dom, line, 0, line, "second".length);

      assert.equal(message.line, 3);
      assert.equal(message.endLine, 3);
      assert.equal(message.charStart, 1, "offsets are one-based on the wire");
      assert.equal(message.charEnd, 6);
    } finally {
      dom.window.close();
    }
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a multi-line selection in the rendered view anchors back to a source range", async () => {
  // The rendered document has no line numbers, so the reader's selection arrives as text with
  // newlines in it. This is the assertion that the text it sends is anchorable: the same functions
  // the server uses must find it and turn it into the range the comment is stored against.
  const root = tempDir();
  const harness = await serve(root, ["notes.md"]);
  try {
    fs.writeFileSync(path.join(root, "notes.md"), `${prose}\n`);
    const html = await (await fetch(`${harness.base}/c/1/notes.md?render`)).text();
    const dom = new JSDOM(html, { url: harness.base, runScripts: "outside-only" });
    try {
      (dom.window as unknown as { posted: unknown[] }).posted = [];
      (dom.window as unknown as { postMessage: (data: unknown) => void }).postMessage = (data) =>
        (dom.window as unknown as { posted: unknown[] }).posted.push(data);
      dom.window.eval(RENDER_SCRIPT);

      // Markdown joins the source's soft line breaks into one paragraph, so the four prose lines are a
      // single element here and selecting it spans them all — which is exactly the case worth testing.
      const paragraph = dom.window.document.querySelector("p");
      assert.ok(paragraph?.firstChild, "the rendered document has a paragraph of prose");
      const text = paragraph!.firstChild!;
      const message = await commentOn(dom, text, 0, text, (text.nodeValue ?? "").length);

      assert.equal(message.intent, "comment");
      assert.equal(message.line, undefined, "the rendered view has no line numbers to send");
      const quote = String(message.quote);
      assert.match(quote, /first line of prose\s+second line of prose/, "the quote spans the first two lines");
      assert.match(quote, /third line of prose\s+last line/, "and runs on to the end of the paragraph");
      assert.ok(!/\d/.test(quote), `line numbers are not part of the quote: ${JSON.stringify(quote)}`);

      const span = deriveQuoteSelection(`${prose}\n`, quote);
      assert.ok(span, "the server can find the selected text in the source");
      const selection = selectionFromOffsets(`${prose}\n`, span.start, span.end);
      assert.equal(selection.line, 2, "it begins on the source line the reader started on");
      assert.equal(selection.endLine, 5, "and covers every line the paragraph holds");
    } finally {
      dom.window.close();
    }
  } finally {
    await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
