/**
 * Comments in a *rendered* document, which is where a person actually reads an artifact.
 *
 * The source view marks comments server-side by line, so it always works. The rendered view has
 * no lines — its script finds each comment's quoted text and wraps it — and that search skipped
 * inline code, so a comment on a code span was invisible in the view people read. A comment on an
 * API heading (`2.4 `POST /v1/…``) is exactly that case, and not finding it is what made a review
 * comment look lost.
 *
 * The script is run here the way the document runs it: real DOM, the same JSON payload, the same
 * globals absent (no fetch, no network).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { RENDER_SCRIPT } from "../src/adapter/artifacts-server.js";

/** Build the document the server would send, and run its script. */
function render(bodyHtml: string, comments: { id: string; quote: string; occurrence?: number }[]): JSDOM {
  const payload = JSON.stringify(
    comments.map((comment) => ({ ...comment, occurrence: comment.occurrence ?? 0, state: "visible", label: "*" })),
  ).replace(/</g, "\\u003c");
  const dom = new JSDOM(
    `<!doctype html><html><body data-file="conversation/1/doc.md">
       ${bodyHtml}
       <script type="application/json" id="comment-data">${payload}</script>
     </body></html>`,
    { runScripts: "outside-only" },
  );
  dom.window.eval(RENDER_SCRIPT);
  return dom;
}

test("a comment on inline code is marked in the rendered view", () => {
  // The case that failed: the quoted text lives inside a code span.
  const dom = render("<h3>2.4 <code>POST /v1/conversations/{id}/submissions</code></h3>", [
    { id: "c1", quote: "POST /v1/conversations/{id}/submissions" },
  ]);
  const doc = dom.window.document;
  const mark = doc.querySelector("mark.cm");
  assert.ok(mark, "the code span is marked");
  assert.equal(mark.textContent, "POST /v1/conversations/{id}/submissions");
  assert.ok(doc.querySelector("sup.cmark"), "and carries its number, so it is findable");
  dom.window.close();
});

test("a comment on prose is marked, and the right occurrence is chosen", () => {
  const dom = render(
    "<p>first use of the word</p><p>second use of the word</p>",
    [{ id: "c2", quote: "use of the word", occurrence: 1 }],
  );
  const marks = dom.window.document.querySelectorAll("mark.cm");
  assert.equal(marks.length, 1, "one mark, not one per occurrence");
  const paragraph = marks[0]!.closest("p");
  assert.match(paragraph?.textContent ?? "", /^second/, "the occurrence count picks the second one");
  dom.window.close();
});

test("a fenced block is left alone, because a comment there belongs to the source view", () => {
  // Wrapping text inside a `pre` would break whitespace and selection; the source view marks those
  // by line instead, so nothing is lost — it just is not painted here.
  const dom = render("<pre><code>const x = 1;</code></pre>", [{ id: "c3", quote: "const x = 1;" }]);
  assert.equal(dom.window.document.querySelector("mark.cm"), null);
  dom.window.close();
});

/* --- the comment affordance --------------------------------------------------------- */

/** Select a text node's contents and let the document's debounce settle. */
async function selectText(dom: JSDOM, selector: string): Promise<void> {
  const doc = dom.window.document;
  const range = doc.createRange();
  range.selectNodeContents(doc.querySelector(selector)!);
  const selection = dom.window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  doc.dispatchEvent(new dom.window.Event("selectionchange"));
  // Poll rather than sleep a fixed 260ms: the settle is a timer inside the document, and under a
  // loaded harness a fixed wait is how this kind of test goes intermittently red.
  for (let i = 0; i < 100 && !doc.querySelector("button.cm-add"); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("a selection shows a button, and the button is what opens the composer", async () => {
  // The point of the change: reading and selecting must not summon a comment box. A small button
  // appears beside the text; clicking it is the explicit request to write, and it carries that
  // intent so the pane knows it may focus the field.
  const dom = render("<p>selectable prose</p>", []);
  const posted: unknown[] = [];
  dom.window.parent.postMessage = (data: unknown) => posted.push(data);

  await selectText(dom, "p");
  const button = dom.window.document.querySelector("button.cm-add");
  assert.ok(button, "an affordance appears beside the selection");
  assert.equal(posted.some((m) => (m as { t: string }).t === "pi-artifact-select"), false, "selecting alone opens nothing");

  button!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  const opened = posted.find((m) => (m as { t: string }).t === "pi-artifact-select") as { intent?: string };
  assert.ok(opened, "the click asks for the composer");
  assert.equal(opened.intent, "comment", "and says the reader meant to write");
  assert.equal(dom.window.document.querySelector("button.cm-add"), null, "the button goes once used");
  dom.window.close();
});

test("an empty selection takes the button away again", async () => {
  const dom = render("<p>selectable prose</p>", []);
  await selectText(dom, "p");
  assert.ok(dom.window.document.querySelector("button.cm-add"));

  dom.window.getSelection()!.removeAllRanges();
  dom.window.document.dispatchEvent(new dom.window.Event("selectionchange"));
  const gone = dom.window.document.querySelector("button.cm-add");
  for (let i = 0; i < 100 && dom.window.document.querySelector("button.cm-add"); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(gone === null || dom.window.document.querySelector("button.cm-add") === null,
    "a dismissed selection leaves nothing behind");
  dom.window.close();
});
