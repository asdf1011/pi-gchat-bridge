/**
 * grade.mjs — deterministic graders for the bridge's local-model evals.
 *
 * Design rule: every assertion is either (a) a hard contract taken from the
 * feature itself, or (b) derived from the *source* the model was given, never
 * from a model's own output. Otherwise a model's mistakes become the standard.
 *
 * Each check is { name, pass, weight, detail } so the runner can report a
 * weighted score plus a per-check breakdown.
 */

const norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[*_`>#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function check(name, pass, weight, detail) {
  return { name, pass: !!pass, weight, detail };
}

/**
 * Whole-word subject match, for title labels. A fuzzy (substring) matcher is
 * right for "did the summary cover this subject", but badly wrong for a
 * *forbidden* one: `sign` must not match "de-sign", or a workflow-design title
 * gets failed for hallucinating a sign.
 */
function mentionsSubject(text, needle) {
  const escaped = norm(needle).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return false;
  return new RegExp(`\\b${escaped}s?\\b`).test(norm(text));
}

// -------------------------------------------------------- title contract

/**
 * The card-title contract, taken from src/topic-summary.ts and src/cards.ts
 * rather than from any model's output: one line, plain text in a Chat card
 * header, naming the topic rather than narrating.
 *
 * Two classes of check live here, and the distinction matters:
 *  - REAL: what the user actually sees. Production runs cleanTitle() first,
 *    which strips a `Title:` echo, wrapping quotes, trailing punctuation and
 *    anything after the first line — so those raw artefacts never reach Chat.
 *  - RAW (prefix `raw-`, weight 1): prompt hygiene. A model that keeps emitting
 *    `Title: …` is learning a habit that can leak in other ways, so it is
 *    tracked, but it is not a user-visible defect and must not dominate a score.
 */
function titleFormat(text) {
  const out = [];
  const t = String(text ?? "").trim();
  out.push(check("non-empty", t.length > 0, 3, `${t.length} chars`));
  // cleanTitle() keeps only the first line, so a multi-line reply loses content:
  // that one IS user-visible.
  out.push(check("one-line", !t.includes("\n"), 2, t.includes("\n") ? "multi-line (only the first line survives cleanTitle)" : "single line"));
  out.push(check("under-200-chars", t.length <= 200, 1, `${t.length} chars (MAX_TITLE_CHARS guard: 200)`));
  const echo = /^\s*(title|topic|conversation)\s*:/i.test(t);
  out.push(check("raw-no-title-echo", !echo, 1, echo ? "echoes the prompt's TITLE: cue (stripped in production)" : "no prompt-cue echo"));
  const quoted = /^["'\u201c\u201d\u2018\u2019`]|["'\u201c\u201d\u2018\u2019`]$/.test(t);
  out.push(check("raw-no-wrapping-quotes", !quoted, 1, quoted ? "wrapped in quotes (stripped in production)" : "unquoted"));
  const stops = /[.!?]$/.test(t);
  out.push(check("raw-no-trailing-period", !stops, 1, stops ? "ends with a full stop (stripped in production)" : "no trailing full stop"));
  const md = /[*_`#]|\]|^"> /.test(t);
  out.push(check("no-markdown", !md, 1, md ? "markdown renders literally in a card header" : "plain text"));
  // A card header is a label, not a sentence about the participants.
  // cleanTitle() does not fix this one.
  const narration = /\b(the user|the assistant|this conversation|the conversation (is|was))\b/i.test(t);
  out.push(check("no-third-person-narration", !narration, 2, narration ? "narrates the participants instead of naming the topic" : "names the topic, not the participants"));
  return out;
}

/**
 * Topic coverage, from hand-set expectations over the SOURCE (for photo cases,
 * by looking at the image). `mustMention` is a list of concept groups: a group
 * passes if ANY alternative appears, so "photo of a sign" and "notice about
 * noise" both score.
 */
function titleContent(text, exp) {
  const out = [];
  const groups = exp.mustMention ?? [];
  const missed = [];
  for (const group of groups) {
    const alts = Array.isArray(group) ? group : [group];
    if (!alts.some((alt) => mentionsSubject(text, alt))) missed.push(alts[0]);
  }
  out.push(check(
    "names-the-topic",
    missed.length === 0,
    4,
    missed.length ? `missing concept(s): ${missed.join(", ")}` : `covers ${groups.length} concept(s)`,
  ));

  // Whatever the title says must come from the conversation: a stray "sign" in a
  // disk-space thread is a fabrication.
  const leaked = (exp.mustNotMention ?? []).filter((f) => mentionsSubject(text, f));
  out.push(check(
    "no-hallucinated-subject",
    leaked.length === 0,
    2,
    leaked.length ? `invented: ${leaked.join(", ")}` : "no out-of-conversation subjects",
  ));
  return out;
}

// ---------------------------------------------------------------- public

export function grade(caseMeta, output) {
  const exp = caseMeta.expectations ?? {};
  const checks = [...titleFormat(output), ...titleContent(output, exp)];
  const total = checks.reduce((a, c) => a + c.weight, 0);
  const got = checks.reduce((a, c) => a + (c.pass ? c.weight : 0), 0);
  return {
    checks,
    score: total ? got / total : 0,
    passed: checks.every((c) => c.pass),
    failures: checks.filter((c) => !c.pass).map((c) => c.name),
  };
}
