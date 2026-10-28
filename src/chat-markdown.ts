/**
 * Rewrite agent Markdown into the subset Google Chat actually renders.
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
 * | pipe table                 | rows concatenated with NO separator at all    |
 *
 * The last one is the destructive case: a whole table collapses into a run-on
 * paragraph ("… F16258.1 ± 34.03.58 t/s…"), and a heading glued to the row
 * above it. Tables aren't in Chat's Markdown subset (literal pipes are what
 * the README used to promise, but no separator at all is what you get), so we
 * convert each row into a bullet line and label the columns from the header
 * instead of hoping for a table widget.
 *
 * The transform is idempotent: already-converted output passes through
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
  /** Inside a fenced block — leave the bytes alone (a trailing space is content). */
  code: boolean;
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

/** Render one table row as a bullet, using the header to label extra columns. */
function renderRow(header: string[], row: string[]): string {
  const label = row[0] ?? "";
  const rest = row.slice(1);
  const filled = rest.filter((v) => v !== "").length;
  const parts = rest
    .map((value, i) => {
      if (value === "") return "";
      if (filled <= 1) return value; // two-column table: the value speaks for itself
      const head = header[i + 1] ?? "";
      return head && head !== label ? `${head}: ${value}` : value;
    })
    .filter((v) => v !== "");
  if (!label && parts.length === 0) return "";
  if (!label) return `- ${parts.join("; ")}`;
  return parts.length > 0 ? `- **${label}** — ${parts.join("; ")}` : `- **${label}**`;
}

/**
 * Detect a pipe table starting at `lines[start]`; returns its replacement lines
 * and the index just past the table, or undefined when it isn't a table.
 */
function readTable(lines: string[], start: number): { out: string[]; end: number } | undefined {
  const headerLine = lines[start];
  const delimLine = lines[start + 1];
  if (!headerLine?.includes("|") || !delimLine?.includes("|")) return undefined;
  if (!isDelimiterRow(delimLine)) return undefined;

  const rows: string[][] = [];
  let i = start + 2;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "" || !line.includes("|") || FENCE_RE.test(line)) break;
    rows.push(splitRow(line));
    i++;
  }
  // Header + delimiter with no body is probably prose that happens to line up —
  // leave it alone rather than inventing bullets.
  if (rows.length === 0) return undefined;

  const header = splitRow(headerLine);
  const out = rows.map((row) => renderRow(header, row)).filter((line) => line !== "");
  return out.length > 0 ? { out, end: i } : undefined;
}

/** `## Title` → `**Title**` (Chat drops the level but keeps the emphasis). */
function convertHeading(line: string): string {
  const m = HEADING_RE.exec(line);
  if (!m) return line;
  const text = m[1].trim();
  return text ? `**${text}**` : "";
}

/**
 * Rewrite `input` for Google Chat's renderer: tables → bullet lines,
 * headings → bold lines, and every remaining soft line break → a hard break so
 * lines the agent wrote on purpose don't get glued together. Fenced code blocks
 * are passed through untouched.
 */
export function toChatMarkdown(input: string): string {
  const lines = input.split("\n");
  const out: OutLine[] = [];
  let fence: string | undefined; // the opening run, e.g. "```", while inside a block

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = FENCE_RE.exec(line);

    if (fence) {
      out.push({ text: line, code: true });
      // A closing fence is the same character, at least as long, no info string.
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) {
        fence = undefined;
      }
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      out.push({ text: line, code: true });
      continue;
    }

    const table = readTable(lines, i);
    if (table) {
      for (const text of table.out) out.push({ text, code: false });
      i = table.end - 1;
      continue;
    }

    out.push({ text: convertHeading(line), code: false });
  }

  return out
    .map((line, i) => {
      const next = out[i + 1];
      if (line.code || !next || next.code) return line.text;
      if (line.text.trim() === "" || next.text.trim() === "") return line.text;
      if (HARD_BREAK_RE.test(line.text)) return line.text;
      return `${line.text}  `;
    })
    .join("\n");
}
