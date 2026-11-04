import test from "node:test";
import assert from "node:assert/strict";

import { escapeHtml, inline, markdownDocument, renderMarkdown } from "../src/adapter/markdown.js";

test("source HTML is escaped, never passed through", () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">');
  assert.ok(!html.includes("<script>"), html);
  assert.ok(!html.includes("<img"), html);
  assert.ok(html.includes("&lt;script&gt;"), html);
  assert.ok(html.includes("&lt;img src=x onerror=&quot;alert(2)&quot;&gt;"), html);
});

test("a fenced block keeps its content literal and escapes it", () => {
  const html = renderMarkdown("```ts\nconst a = `<b>`;\n```");
  assert.ok(html.includes('<pre><code class="language-ts">'), html);
  assert.ok(html.includes("const a = `&lt;b&gt;`;"), html);
});

test("markup inside a code span is not interpreted", () => {
  const html = renderMarkdown("use `**not bold**` here");
  assert.ok(html.includes("<code>**not bold**</code>"), html);
  assert.ok(!html.includes("<strong>"), html);
});

test("headings, paragraphs and rules", () => {
  const html = renderMarkdown("# One\n\nsome text\nwrapped onto two lines\n\n---\n\n### Three");
  assert.ok(html.includes("<h1>One</h1>"), html);
  assert.ok(html.includes("<p>some text wrapped onto two lines</p>"), html);
  assert.ok(html.includes("<hr>"), html);
  assert.ok(html.includes("<h3>Three</h3>"), html);
});

test("a pipe table becomes a real table with alignment", () => {
  const html = renderMarkdown("| a | b |\n|---|--:|\n| 1 | 2 |");
  assert.ok(html.includes("<table>"), html);
  assert.ok(html.includes("<th>a</th>"), html);
  assert.ok(html.includes('<th style="text-align:right">b</th>'), html);
  assert.ok(html.includes("<td>1</td>"), html);
});

test("bullet and numbered lists, including one level of nesting", () => {
  const bullets = renderMarkdown("- one\n- two\n  - nested\n- three");
  assert.ok(bullets.includes("<ul><li>one</li><li>two<ul><li>nested</li></ul></li><li>three</li></ul>"), bullets);

  const numbered = renderMarkdown("1. first\n2. second");
  assert.ok(numbered.includes("<ol><li>first</li><li>second</li></ol>"), numbered);
});

test("blockquotes nest their own blocks", () => {
  const html = renderMarkdown("> quoted **bold**\n> second line");
  assert.ok(html.includes("<blockquote><p>quoted <strong>bold</strong> second line</p></blockquote>"), html);
});

test("links keep safe schemes and drop script-carrying ones", () => {
  const ok = renderMarkdown("[docs](https://example.com/a?b=c)");
  assert.ok(ok.includes('<a href="https://example.com/a?b=c" rel="noopener noreferrer">docs</a>'), ok);

  const relative = renderMarkdown("[here](notes.md)");
  assert.ok(relative.includes('href="notes.md"'), relative);

  for (const bad of ["javascript:alert(1)", "data:text/html,<script>", "vbscript:x"]) {
    const html = renderMarkdown(`[click](${bad})`);
    assert.ok(!html.includes("<a "), `${bad} must not become a link: ${html}`);
    assert.ok(html.includes("click"), html);
  }
});

test("inline() escapes before it formats", () => {
  assert.equal(inline("<b>**x**</b>"), "&lt;b&gt;<strong>x</strong>&lt;/b&gt;");
  assert.equal(escapeHtml("a&b<c>d\"e'f"), "a&amp;b&lt;c&gt;d&quot;e&#39;f");
});

test("the document wrapper carries a viewport and the body verbatim", () => {
  const document = markdownDocument("t", "<p>hi</p>");
  assert.ok(document.startsWith("<!doctype html>"), document);
  assert.ok(document.includes("<title>t</title>"), document);
  assert.ok(document.includes("<p>hi</p>"), document);
});

test("the title is escaped in the wrapper", () => {
  const document = markdownDocument("<script>", "<p>hi</p>");
  assert.ok(!document.includes("<title><script>"), document);
  assert.ok(document.includes("<title>&lt;script&gt;</title>"), document);
});
