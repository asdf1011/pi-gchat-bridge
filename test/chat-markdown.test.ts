import test from "node:test";
import assert from "node:assert/strict";
import { openTable, toChatMarkdown } from "../src/chat-markdown.js";

// Tables became renderable in Chat on Nov 16 2026 (GA, MARKUP_SYNTAX_MARKDOWN),
// so the conversion to bullets is gone. What these check is that nothing is done
// to a table: a rewritten row is no longer a row.

test("a table passes through byte for byte", () => {
  const source = [
    "That completes the comparison:",
    "",
    "| body | method | PPL (3 chunks) | speed |",
    "|---|---|---|---|",
    "| Q8_0 | RTN from F16 | **258.1 ± 34.0** | 3.58 t/s |",
    "| Q4_0 | vendor QAD | 281.4 ± 37.3 | 4.06 t/s |",
    "",
    "Conclusion follows.",
  ].join("\n");

  const out = toChatMarkdown(source);
  for (const row of source.split("\n").slice(2, 6)) assert.ok(out.includes(row), row);
  assert.ok(out.includes("Conclusion follows."));
});

test("table rows never get a hard break glued on", () => {
  const source = ["| Metric | Value |", "|---|---|", "| PPL | 258.1 |"].join("\n");
  assert.equal(toChatMarkdown(source), source);
});

test("pipe-less GFM tables are left alone too", () => {
  const source = ["a | b | c", "--- | --- | ---", "1 | 2 | 3"].join("\n");
  assert.equal(toChatMarkdown(source), source);
});

test("a paragraph followed by a thematic break is not treated as a table", () => {
  const source = ["a | b", "---"].join("\n");
  assert.equal(toChatMarkdown(source), "a | b  \n---");
});

test("a prose line directly above a table is separated from it", () => {
  // Without the blank line the header row may read as the paragraph's next line,
  // and then there is no table at all.
  const source = ["Comparison follows:", "| a | b |", "|---|---|", "| 1 | 2 |"].join("\n");
  assert.equal(
    toChatMarkdown(source),
    ["Comparison follows:", "", "| a | b |", "|---|---|", "| 1 | 2 |"].join("\n"),
  );
});

test("prose directly below a table is separated from it", () => {
  const source = ["| a | b |", "|---|---|", "| 1 | 2 |", "Prose out of nowhere."].join("\n");
  assert.equal(
    toChatMarkdown(source),
    ["| a | b |", "|---|---|", "| 1 | 2 |", "", "Prose out of nowhere."].join("\n"),
  );
});

test("a header-only table is still left exactly as written", () => {
  const source = ["| a | b |", "|---|---|"].join("\n");
  assert.equal(toChatMarkdown(source), source);
});

test("headings become bold lines", () => {
  assert.equal(toChatMarkdown("## So, to answer your question"), "**So, to answer your question**");
  assert.equal(toChatMarkdown("### Deep ###"), "**Deep**");
  assert.equal(toChatMarkdown("#1 issue is not a heading"), "#1 issue is not a heading");
});

test("soft line breaks become hard breaks so lines are not glued together", () => {
  const out = toChatMarkdown("line A\nline B");
  assert.equal(out, "line A  \nline B");
});

test("blank lines and existing hard breaks are left alone", () => {
  assert.equal(toChatMarkdown("a\n\nb"), "a\n\nb");
  assert.equal(toChatMarkdown("a  \nb"), "a  \nb");
});

test("fenced code blocks pass through untouched", () => {
  const source = ["```", "| a | b |", "|---|---|", "# not a heading", "trailing  ", "```"].join("\n");
  assert.equal(toChatMarkdown(source), source);
});

test("an unterminated fence still protects its content", () => {
  const source = ["```", "| a | b |", "|---|---|"].join("\n");
  assert.equal(toChatMarkdown(source), source);
});

test("the transform is idempotent", () => {
  const source = [
    "intro",
    "## Heading",
    "",
    "| a | b |",
    "|---|---|",
    "| 1 | 2 |",
    "",
    "```",
    "code  ",
    "```",
    "done",
  ].join("\n");
  const once = toChatMarkdown(source);
  assert.equal(toChatMarkdown(once), once);
});

test("openTable names the header pair of a table the text ends inside", () => {
  const text = ["prose", "", "| a | b |", "|---|---|", "| 1 | 2 |"].join("\n");
  assert.deepEqual(openTable(text), { header: ["| a | b |", "|---|---|"], start: 2 });
});

test("openTable sees nothing once the table has ended", () => {
  const ended = ["| a | b |", "|---|---|", "| 1 | 2 |", "", "prose"].join("\n");
  assert.equal(openTable(ended), undefined);
  const prose = ["| a | b |", "|---|---|", "| 1 | 2 |", "prose out of nowhere"].join("\n");
  assert.equal(openTable(prose), undefined);
});

test("openTable ignores a table inside a code block", () => {
  const text = ["```", "| a | b |", "|---|---|", "| 1 | 2 |"].join("\n");
  assert.equal(openTable(text), undefined);
});
