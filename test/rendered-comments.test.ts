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
