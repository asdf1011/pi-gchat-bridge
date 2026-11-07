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

// --- Images -----------------------------------------------------------------
//
// Off by default, and even switched on only a same-origin relative path is
// accepted. The distinction that matters: a link waits for a click, an image
// fires on render, so its source must not be able to name another host.

test("images stay literal unless the renderer is asked for them", () => {
  // Every caller that has not opted in — the artifact viewer above all — keeps
  // the old behaviour, where this is text and a link.
  assert.equal(renderMarkdown("![pie](api/c/7/image/3/0)").trim(),
    '<p>!<a href="api/c/7/image/3/0" rel="noopener noreferrer">pie</a></p>');
});

test("an opted-in renderer emits a same-origin relative image", () => {
  assert.equal(renderMarkdown("![pie](api/c/7/image/3/0)", { images: true }).trim(),
    '<p><img src="api/c/7/image/3/0" alt="pie" loading="lazy"></p>');
  // A query string is part of a relative path and is kept.
  assert.match(renderMarkdown("![a](api/c/7/image/3/0?v=1)", { images: true }),
    /<img src="api\/c\/7\/image\/3\/0\?v=1"/);
});

test("an image cannot name another host or another scheme", () => {
  // Each otherwise-valid image is refused and falls back to the link form, so a
  // document shows what was written instead of silently dropping it.
  const hostile = [
    "https://evil.example/p.png",      // an exfiltration channel
    "http://evil.example/p.png",       // same, unencrypted
    "//evil.example/p.png",            // protocol-relative: a browser reads it as absolute
    "/api/c/7/image/3/0",              // root-absolute: escapes the mount, may reach another app
    "\\\\evil.example\\p.png",          // backslash prefix some browsers normalise to "/"
    "api/../../secret.png",            // climbs out of the API prefix
    "data:image/svg+xml,<svg onload=alert(1)>", // can carry script
    "file:///etc/passwd",              // local file
  ];
  for (const src of hostile) {
    const html = renderMarkdown(`![x](${src})`, { images: true });
    assert.ok(!html.includes("<img"), `${src} must not render as an image: ${html}`);
    // No scheme reaches an href either — `safeHref` already dropped those.
    assert.ok(!/<a[^>]+href="(?:javascript|data|file|vbscript)/i.test(html), src);
  }
});

test("alt text cannot break out of the attribute", () => {
  // The source is escaped before the tag is built, so a quote in the alt text is
  // an entity, not an attribute boundary: the `onerror=` ends up *inside* the
  // quoted alt value, where it is inert text rather than a second attribute.
  const html = renderMarkdown('![a" onerror="alert(1)](api/x.png)', { images: true });
  assert.match(html, /alt="a&quot; onerror=&quot;alert\(1\)"/);
  // The real property: the emitted tag parses as exactly three attributes, so
  // nothing in the alt text opened a fourth.
  const tag = /<img [^>]*>/.exec(html)?.[0] ?? "";
  const attrs = [...tag.matchAll(/(\w+)="/g)].map((m) => m[1]);
  assert.deepEqual(attrs, ["src", "alt", "loading"], tag);
});

test("an image inside a code span or fence stays literal", () => {
  const html = renderMarkdown("`![a](api/x.png)`", { images: true });
  assert.ok(!html.includes("<img"), html);
  assert.match(html, /<code>!\[a\]\(api\/x\.png\)<\/code>/);
});
