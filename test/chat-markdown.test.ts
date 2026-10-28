import test from "node:test";
import assert from "node:assert/strict";
import { toChatMarkdown } from "../src/chat-markdown.js";

test("tables become one bullet per row, labelled from the header", () => {
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
  assert.ok(out.includes("- **Q8_0** — method: RTN from F16; PPL (3 chunks): **258.1 ± 34.0**; speed: 3.58 t/s"));
  assert.ok(out.includes("- **Q4_0** — method: vendor QAD; PPL (3 chunks): 281.4 ± 37.3; speed: 4.06 t/s"));
  assert.ok(!out.includes("|---|"));
  assert.ok(out.includes("Conclusion follows."));
});

test("two-column tables read as key/value bullets without redundant labels", () => {
  const source = ["| Metric | Value |", "|---|---|", "| PPL | 258.1 |"].join("\n");
  assert.equal(toChatMarkdown(source), "- **PPL** — 258.1");
});

test("pipe-less GFM tables are converted too", () => {
  const source = ["a | b | c", "--- | --- | ---", "1 | 2 | 3"].join("\n");
  assert.equal(toChatMarkdown(source), "- **1** — b: 2; c: 3");
});

test("a paragraph followed by a thematic break is not treated as a table", () => {
  const source = ["a | b", "---"].join("\n");
  assert.equal(toChatMarkdown(source), "a | b  \n---");
});

test("a header-only table is left as literal text", () => {
  const source = ["| a | b |", "|---|---|"].join("\n");
  assert.equal(toChatMarkdown(source), "| a | b |  \n|---|---|");
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

test("the run-on table case from the bug report keeps its numbers separable", () => {
  const source = [
    "| body precision | method | PPL (3 chunks) | speed |",
    "|---|---|---|---|",
    "| Q8_0 | naive RTN from F16 | **258.1 ± 34.0** | 3.58 t/s |",
    "| Q4_0 | naive RTN from F16 | 274.7 ± 37.0 | 4.06 t/s |",
  ].join("\n");
  const out = toChatMarkdown(source);
  assert.ok(!/\d\.\d{2} t\/s\d/.test(out.replace(/\n/g, " ")) || out.includes("\n"));
  for (const line of out.split("\n")) assert.ok(line.startsWith("- **"), line);
});
