/**
 * A small Markdown renderer for the artifact viewer.
 *
 * Why hand-rolled: the docs this serves are written by the agent and read in a
 * sandboxed, script-free document on the artifact origin, so the interesting
 * requirement is not "full CommonMark", it is "nothing this renderer emits can
 * execute". That is achieved structurally rather than by sanitising afterwards:
 * every byte of source is HTML-escaped **first**, then a fixed set of block and
 * inline constructs is turned into tags. There is no path by which source text
 * reaches the output as markup, so there is nothing for a sanitiser to fix up.
 *
 * The supported subset is exactly what this repository's docs use — headings,
 * paragraphs, fenced code, blockquotes, bullet and numbered lists (nested),
 * pipe tables, horizontal rules, and inline code/bold/italic/links. Anything
 * else is rendered as the plain text it is, which is a deliberate trade: a
 * document that shows `**not bold**` is a cosmetic bug, a document that renders
 * raw HTML is a security bug.
 *
 * Known limits, so they are not rediscovered as surprises:
 *   - no reference links, footnotes, setext headings, or HTML blocks
 *   - `|` inside a table cell cannot be escaped
 *   - emphasis is not nestable beyond one level (`**a *b* c**` keeps the inner marks)
 */

/** Escape everything that could be markup. Applied before any transformation. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * A link target that a browser cannot turn into script.
 *
 * Only `http`, `https`, `mailto` and scheme-less (relative) targets survive;
 * `javascript:`, `data:` and `vbscript:` are dropped, leaving the label as plain
 * text. The target is already entity-escaped by `escapeHtml`, so it is safe to
 * place in the attribute as-is.
 */
function safeHref(href: string): string | undefined {
  const trimmed = href.trim();
  if (trimmed === "") return undefined;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  if (scheme && !["http", "https", "mailto"].includes(scheme[1].toLowerCase())) return undefined;
  return trimmed;
}

/**
 * Rendering options.
 *
 * `images` is opt-in and off by default, because an image tag is a *passive*
 * request: unlike a link it fires without a click, which would hand whatever
 * wrote the Markdown a silent way to make the reader's browser call a third
 * party. Only the chat page turns it on, and even there a source must be a
 * same-origin relative path — see `safeImageSrc`.
 */
export interface RenderOptions {
  /** Allow inline images whose source is a same-origin relative path. */
  images?: boolean;
}

/**
 * An image source a browser cannot use to reach another host.
 *
 * Deliberately narrower than `safeHref`: a link is inert until clicked and can
 * afford `https`, but an image renders on arrival, so the only acceptable source
 * is one served from the page's own origin under the mount it was written in.
 *
 * Rejected, each for its own reason:
 *   - any scheme (`https:`, `data:`, `file:`) — the first is an exfiltration
 *     channel, the second can carry SVG script;
 *   - a protocol-relative `//host/path`, which a browser reads as absolute;
 *   - a root-absolute `/path`, which escapes the mount a proxied page lives
 *     under and would 404 — or worse, reach a *different* app at the root;
 *   - a `\` prefix, which some browsers normalise to `/`;
 *   - any `..` segment, so a crafted path cannot climb out of the API prefix.
 *
 * What survives is what the page itself emits: `api/c/<id>/image/<e>/<i>`, and
 * anything else relative, which simply 404s on this origin.
 */
function safeImageSrc(src: string): string | undefined {
  const trimmed = src.trim();
  if (trimmed === "") return undefined;
  // A scheme, or protocol-relative shorthand, is never allowed.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return undefined;
  if (trimmed.startsWith("//") || trimmed.startsWith("/") || trimmed.startsWith("\\")) return undefined;
  if (trimmed.split(/[?#]/)[0].split("/").includes("..")) return undefined;
  return trimmed;
}

/** Replace inline constructs in one already-escaped line. */
export function inline(raw: string, options: RenderOptions = {}): string {
  const codes: string[] = [];
  let out = escapeHtml(raw);

  // Code spans first, parked behind a placeholder so their contents are never
  // interpreted as emphasis (`**not bold**` inside backticks must stay literal).
  out = out.replace(/`([^`]+)`/g, (_match, code: string) => {
    codes.push(`<code>${code}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });

  // Images before links, so the `![alt](src)` form is not first eaten by the
  // link rule and left as a stray `!`. Like `inline`, this runs on already
  // escaped text, so `alt` and `src` are entity-escaped by the time they reach
  // the attribute — the tag cannot be broken out of from the source.
  if (options.images === true) {
    out = out.replace(/!\[([^\]]*)\]\(([^()\s]+)\)/g, (match, alt: string, src: string) => {
      const safe = safeImageSrc(src);
      // Not an image we will render: leave the source as the text it was, so the
      // document shows what the agent wrote rather than silently dropping it.
      return safe === undefined ? match : `<img src="${safe}" alt="${alt}" loading="lazy">`;
    });
  }

  out = out.replace(/\[([^\]]+)\]\(([^()\s]+)\)/g, (match, label: string, href: string) => {
    const safe = safeHref(href);
    return safe === undefined ? label : `<a href="${safe}" rel="noopener noreferrer">${label}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/(^|[\s(])_([^_\n]+)_/g, "$1<em>$2</em>");

  return out.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => codes[Number(index)] ?? "");
}

interface ListItem {
  indent: number;
  ordered: boolean;
  text: string;
}

function listItem(line: string): ListItem | undefined {
  const match = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line);
  if (!match) return undefined;
  return {
    indent: match[1].length,
    ordered: /\d/.test(match[2]),
    text: match[3],
  };
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
}

function isTableDelimiter(line: string): boolean {
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{1,}:?$/.test(cell.trim()));
}

function alignmentOf(cell: string): string {
  const left = cell.trim().startsWith(":");
  const right = cell.trim().endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return "";
}

function isFence(line: string): { marker: string; info: string } | undefined {
  const match = /^\s*(`{3,}|~{3,})\s*(\S*)\s*$/.exec(line);
  return match ? { marker: match[1][0].repeat(3), info: match[2] } : undefined;
}

function startsBlock(lines: readonly string[], index: number): boolean {
  const line = lines[index];
  if (line.trim() === "") return true;
  if (isFence(line)) return true;
  if (/^\s{0,3}#{1,6}\s+/.test(line)) return true;
  if (/^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/.test(line)) return true;
  if (/^\s{0,3}>/.test(line)) return true;
  if (listItem(line)) return true;
  const next = lines[index + 1];
  if (line.includes("|") && next !== undefined && isTableDelimiter(next)) return true;
  return false;
}

/**
 * Render a block of lines.
 *
 * Recursive because a blockquote and a list item both contain blocks; that is
 * also why the function is not a single pass with an output buffer.
 */
function renderLines(lines: readonly string[], options: RenderOptions = {}): string {
  const out: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (line.trim() === "") {
      index += 1;
      continue;
    }

    const fence = isFence(line);
    if (fence) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length) {
        const candidate = lines[index];
        if (candidate.trim().startsWith(fence.marker)) {
          index += 1;
          break;
        }
        body.push(candidate);
        index += 1;
      }
      const language = fence.info === "" ? "" : ` class="language-${escapeHtml(fence.info)}"`;
      out.push(`<pre><code${language}>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      // Trailing closing hashes are part of the syntax, not the text.
      out.push(`<h${level}>${inline(heading[2].replace(/\s+#+\s*$/, ""), options)}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/.test(line)) {
      out.push("<hr>");
      index += 1;
      continue;
    }

    if (/^\s{0,3}>/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^\s{0,3}>/.test(lines[index])) {
        quoted.push(lines[index].replace(/^\s{0,3}>\s?/, ""));
        index += 1;
      }
      out.push(`<blockquote>${renderLines(quoted, options)}</blockquote>`);
      continue;
    }

    const delimiter = lines[index + 1];
    if (line.includes("|") && delimiter !== undefined && isTableDelimiter(delimiter)) {
      const header = splitRow(line);
      const aligns = splitRow(delimiter).map(alignmentOf);
      const cell = (tag: string, text: string, column: number): string => {
        const align = aligns[column] ?? "";
        const style = align === "" ? "" : ` style="text-align:${align}"`;
        return `<${tag}${style}>${inline(text.trim(), options)}</${tag}>`;
      };
      const head = header.map((text, column) => cell("th", text, column)).join("");
      index += 2;
      const rows: string[] = [];
      while (index < lines.length && lines[index].includes("|") && lines[index].trim() !== "") {
        const cells = splitRow(lines[index]);
        rows.push(`<tr>${cells.map((text, column) => cell("td", text, column)).join("")}</tr>`);
        index += 1;
      }
      out.push(
        `<table><thead><tr>${head}</tr></thead><tbody>${rows.join("")}</tbody></table>`,
      );
      continue;
    }

    const firstItem = listItem(line);
    if (firstItem) {
      const baseIndent = firstItem.indent;
      const ordered = firstItem.ordered;
      const items: string[][] = [];
      let current: string[] | undefined;

      while (index < lines.length) {
        const candidate = lines[index];
        if (candidate.trim() === "") {
          const after = lines[index + 1];
          const afterItem = after === undefined ? undefined : listItem(after);
          const afterIndented = after !== undefined && /^\s{2,}\S/.test(after);
          if (after === undefined || (!afterItem && !afterIndented)) break;
          current?.push("");
          index += 1;
          continue;
        }
        const item = listItem(candidate);
        if (item && item.indent <= baseIndent + 1) {
          // A change of marker kind at the same depth starts a different list.
          if (item.ordered !== ordered) break;
          current = [item.text];
          items.push(current);
          index += 1;
          continue;
        }
        if (/^\s{2,}\S/.test(candidate) && current) {
          // Continuation or nested block: strip the item's own indentation so
          // the recursive call sees a normal document starting at column zero.
          current.push(candidate.replace(new RegExp(`^\\s{0,${baseIndent + 2}}`), ""));
          index += 1;
          continue;
        }
        break;
      }

      const tag = ordered ? "ol" : "ul";
      const body = items
        .map((itemLines) => {
          const inner = renderLines(itemLines, options);
          // A leading paragraph is unwrapped: `<li><p>a</p></li>` renders with
          // paragraph spacing that a one-line list item should not have. Only the
          // first one — anything after it is a nested block (typically a list).
          const unwrapped = inner.replace(/^<p>([\s\S]*?)<\/p>\n?/, "$1");
          return `<li>${unwrapped}</li>`;
        })
        .join("");
      out.push(`<${tag}>${body}</${tag}>`);
      continue;
    }

    const paragraph: string[] = [line.trim()];
    index += 1;
    while (index < lines.length && !startsBlock(lines, index)) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    out.push(`<p>${inline(paragraph.join(" "), options)}</p>`);
  }

  return out.join("\n");
}

/**
 * Render one Markdown document to HTML. Output is safe to embed; it holds no
 * scripts.
 *
 * `options` is empty by default, so every existing caller keeps the strictest
 * behaviour — a document that renders `![a](b)` as text unless it means it.
 */
export function renderMarkdown(source: string, options: RenderOptions = {}): string {
  return renderLines(source.replace(/\r\n?/g, "\n").split("\n"), options);
}

/** A self-contained document around rendered Markdown, styled for reading. */
export function markdownDocument(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark;
    /* Same stack as the web page's --sans; repeated because this document is
       served standalone and cannot inherit the app's custom properties. */
    --sans: system-ui, -apple-system, "Segoe UI Variable Text", "Segoe UI",
      Inter, Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", "Cascadia Code",
      "JetBrains Mono", Menlo, Consolas, monospace; }
  body { margin: 0 auto; padding: 2rem 1.25rem 4rem; max-width: 46rem;
         font: 16px/1.6 var(--sans); -webkit-font-smoothing: antialiased; }
  h1, h2, h3, h4 { line-height: 1.25; margin: 2rem 0 .75rem; }
  h1 { font-size: 1.6rem; } h2 { font-size: 1.3rem; } h3 { font-size: 1.1rem; }
  p, li { margin: .5rem 0; }
  code { font-family: var(--mono); font-size: .9em;
         background: #8881; padding: .1em .3em; border-radius: 3px; }
  pre { background: #8881; padding: .75rem 1rem; border-radius: 6px; overflow: auto; }
  pre code { background: none; padding: 0; }
  blockquote { margin: .75rem 0; padding-left: .9rem; border-left: 3px solid #8886; opacity: .85; }
  table { border-collapse: collapse; margin: 1rem 0; display: block; overflow-x: auto; }
  th, td { border: 1px solid #8886; padding: .35rem .6rem; text-align: left; vertical-align: top; }
  th { background: #8882; }
  hr { border: 0; border-top: 1px solid #8886; margin: 2rem 0; }
  a { color: inherit; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}
