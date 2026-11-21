/**
 * Rewrite agent Markdown into the shapes Google Chat's renderer gets wrong.
 *
 * Chat takes `MARKUP_SYNTAX_MARKDOWN` (CommonMark, GA Aug 2026) but its
 * renderer differs from a desktop CommonMark viewer in ways that visibly
 * mangle agent output (verified live against the API by round-tripping a
 * message and reading the output-only `formattedText` field):
 *
 * | Source                     | Chat renders                                  |
 * |----------------------------|-----------------------------------------------|
 * | `a  \n b` (two spaces)     | hard line break — supported                   |
 * | `a\\\n b` (backslash)      | hard line break — supported                   |
 * | `a\nb` (plain soft break)  | joined with a space                           |
 * | `## heading`               | bold paragraph (level is dropped)             |
 * | pipe table                 | a real table — since Nov 16 2026, GA          |
 *
 * So two rewrites survive. A heading loses its level, so `## x` becomes `**x**`
 * — a bold line, which is what Chat draws anyway. And a soft break is joined
 * with a space, so every line the agent broke on purpose gets a two-space hard
 * break instead, or the reply arrives as one paragraph.
 *
 * Tables used to be the third, and the ugliest: before Nov 16 2026 Chat had no
 * table widget, and its fallback was destructive — the rows were concatenated
 * with *no* separator (`… 258.1 ± 34.03.58 t/s…`), swallowing the line after
 * them. This file rewrote each table into bullet lines to survive that
 * ([upstream 428659965](https://issuetracker.google.com/issues/428659965)).
 * That conversion is gone: the same `markupSyntax: MARKUP_SYNTAX_MARKDOWN` the
 * bridge already sends on create *and* on every streamed PATCH now draws a real
 * table, so the agent's table is passed through byte for byte.
 *
 * Passing it through means leaving a table's lines *alone*, which is why the
 * hard-break rule skips them: a row is syntax, not prose, and two trailing
 * spaces after the closing `|` or on the `|---|` row are not the same table.
 * A table is also given a blank line above it, so it starts its own block
 * rather than continuing the paragraph before it.
 *
 * The transform is idempotent: already-normalised output passes through
 * unchanged, so it can be applied per streamed PATCH as well as to the final
 * text (which stream.ts splits after normalizing).
 */

/** Opening/closing fence line (``` or ~~~, optionally indented). */
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
/** One GFM alignment cell: `---`, `:--`, `--:`, `:-:`. */
const DELIM_CELL_RE = /^:?-+:?$/;
/** ATX heading: `## text`, optionally with a closing hash run. */
const HEADING_RE = /^\s{0,3}#{1,6}[ \t]+(.*?)[ \t]*#*[ \t]*$/;
/** Line already ending in a CommonMark hard break (2+ spaces). */
const HARD_BREAK_RE = / {2,}$/;

interface OutLine {
  text: string;
  /**
   * Inside a fenced block or a table — leave the bytes alone. In a block a
   * trailing space is content; in a table row it is the difference between a
   * row and a row with a hard break glued to it.
   */
  verbatim: boolean;
}

/** Split a table row into trimmed cells, honouring `\|` escapes. */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/**
 * True for the `|---|:--:|` row under a table header. Requires pipes in the
 * row itself, which also keeps a pipe-containing paragraph followed by a `---`
 * thematic break (i.e. a setext heading) from being mistaken for a table.
 */
function isDelimiterRow(line: string): boolean {
  const t = line.trim();
  if (!t.includes("-") || !t.includes("|")) return false;
  if (!/^[|\s:-]+$/.test(t)) return false;
  return splitRow(t).every((cell) => cell === "" || DELIM_CELL_RE.test(cell));
}

/**
 * Detect a pipe table starting at `lines[start]`; returns the index just past
 * its last row, or undefined when it isn't a table.
 *
 * Chat's rule is the same as GFM's (`developers.google.com/workspace/chat/
 * format-messages`): columns separated by `|`, and the header row followed by a
 * row with at least three `-` per column. A header and delimiter with no body
 * is still a legal (if empty) table, so it is recognised — the old bullet
 * rewrite deliberately ignored that case, because "one line of guesses" reads
 * worse than the literal pipes. Nothing is rewritten now, so there is nothing
 * to be shy about.
 */
function tableEnd(lines: string[], start: number): number | undefined {
  const headerLine = lines[start];
  const delimLine = lines[start + 1];
  if (!headerLine?.includes("|") || !delimLine?.includes("|")) return undefined;
  if (!isDelimiterRow(delimLine)) return undefined;
  let i = start + 2;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "" || !line.includes("|") || FENCE_RE.test(line)) break;
    i++;
  }
  return i;
}

/** `## Title` → `**Title**` (Chat drops the level but keeps the emphasis). */
function convertHeading(line: string): string {
  const m = HEADING_RE.exec(line);
  if (!m) return line;
  const text = m[1].trim();
  return text ? `**${text}**` : "";
}

/**
 * Rewrite `input` for Google Chat's renderer: headings → bold lines and every
 * remaining soft line break → a hard break, so lines the agent wrote on purpose
 * don't get glued together. Fenced code blocks and pipe tables are passed
 * through untouched.
 */
export function toChatMarkdown(input: string): string {
  const lines = input.split("\n");
  const out: OutLine[] = [];
  let fence: string | undefined; // the opening run, e.g. "```", while inside a block

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = FENCE_RE.exec(line);

    if (fence) {
      out.push({ text: line, verbatim: true });
      // A closing fence is the same character, at least as long, no info string.
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) {
        fence = undefined;
      }
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      out.push({ text: line, verbatim: true });
      continue;
    }

    const end = tableEnd(lines, i);
    if (end !== undefined) {
      // A table is its own block. A paragraph line immediately above it would
      // leave the header row as prose if Chat requires the blank line GFM does,
      // so it is inserted rather than assumed — and likewise below it, so the
      // prose that follows is not swallowed by the last row.
      const previous = out[out.length - 1];
      if (previous && previous.text.trim() !== "") out.push({ text: "", verbatim: true });
      for (let j = i; j < end; j++) out.push({ text: lines[j], verbatim: true });
      if ((lines[end] ?? "").trim() !== "") out.push({ text: "", verbatim: true });
      i = end - 1;
      continue;
    }

    out.push({ text: convertHeading(line), verbatim: false });
  }

  return out
    .map((line, i) => {
      const next = out[i + 1];
      if (line.verbatim || !next || next.verbatim) return line.text;
      if (line.text.trim() === "" || next.text.trim() === "") return line.text;
      if (HARD_BREAK_RE.test(line.text)) return line.text;
      return `${line.text}  `;
    })
    .join("\n");
}

/** A table a chunk of text ends inside, as the splitter needs to see it. */
export interface OpenTable {
  /** The header row and the delimiter row, exactly as written. */
  readonly header: readonly [string, string];
  /** Line index of the header row, so a splitter can move the pair whole. */
  readonly start: number;
}

/**
 * The table `text` ends inside, if any — the counterpart of `openFence`, for
 * `splitMessage`.
 *
 * A reply longer than Chat's 4,000-character cap is cut at a line boundary, and
 * a table cut there leaves the second half as rows with no header row above
 * them, which is not a table at all: the rows render as literal pipes. Since a
 * table cannot be re-opened from nothing, the splitter repeats the two header
 * lines at the top of the next chunk — the same trade the fence re-opener
 * makes, and for the same reason.
 *
 * "Ends inside" means the last line is a row: a blank line, or a line with no
 * pipe in it, has already broken the table.
 */
export function openTable(text: string): OpenTable | undefined {
  const lines = text.split("\n");
  let fence: string | undefined;
  let open: OpenTable | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = FENCE_RE.exec(line);

    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) {
        fence = undefined;
      }
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      open = undefined;
      continue;
    }

    const previous = lines[i - 1];
    if (previous !== undefined && previous.includes("|") && isDelimiterRow(line)) {
      open = { header: [previous, line], start: i - 1 };
      continue;
    }
    // A blank line ends a table; so does any line that cannot be a row.
    if (line.trim() === "" || !line.includes("|")) open = undefined;
  }

  return open;
}
