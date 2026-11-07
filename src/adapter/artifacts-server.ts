/**
 * The artifact origin: a GET-only HTTP surface over one conversation's files.
 *
 * Separate listener, separate port, separate tunnel hostname. It shares the
 * process with the bridge but not its route table, so "this surface cannot
 * submit a message or run a tool" is a property of what is registered here, not
 * of a header check — nothing that can reach this port can reach the mutating
 * API, however malformed the request.
 *
 * Three rules the responses hold to, because artifact content is untrusted by
 * construction (the agent is steerable by what it reads):
 *
 *   1. Never `text/html` without a sandboxing CSP. Markdown is rendered to HTML
 *      here, and every document — index, rendered doc, raw text — carries
 *      `sandbox`, so the browser treats it as an opaque origin with no cookies,
 *      no storage and no access to the parent page.
 *   2. Never `connect-src` open. `default-src 'none'` means a rendered document
 *      cannot fetch, frame or load anything, so it has no exfiltration channel.
 *   3. Only paths that appear in the conversation's derived artifact list are
 *      served. The list is the allow-list; there is no filesystem browsing.
 */
import { randomBytes } from "node:crypto";
import http from "node:http";

import { isMarkdown, readArtifact, type ArtifactFile } from "../durable/artifacts.js";
import { repoRelativePath, showFile } from "../durable/artifact-vcs.js";
import { logger } from "../logger.js";
import type { SessionHost } from "../session-host/api.js";
import { escapeHtml, markdownDocument, renderMarkdown } from "./markdown.js";

export interface ArtifactsServerOptions {
  /** The conversation host. In-process today; a link would satisfy the same shape. */
  seam: SessionHost;
  /** Port on the loopback interface. 0 picks a free one (tests). */
  port: number;
  /** Bind address. Loopback by default: the tunnel is the only way in. */
  bind?: string;
  /** Applied to file content on the way out; the viewer bypasses the harness. */
  redact?: (text: string) => string;
  /**
   * Origin of the chat UI, allowed to frame these documents.
   *
   * `BRIDGE_WEB_ORIGIN` in deployment (`https://pi.hl.id.au`). Unset falls back to
   * `'self'`, which only works if the viewer is served from this same origin.
   */
  webOrigin?: string;
  /**
   * The jj repository holding a conversation's artifacts, if the deployment
   * version-controls them.
   *
   * Present, this origin can serve a *revision* (`?rev=<changeId>`) as well as the
   * live file, and it can draw review comments. Absent, both are refused with a
   * plain explanation — this surface never invents an anchor it cannot check.
   */
  repoFor?: (conversationId: number) => string | undefined;
}

/** Headers shared by every response: no sniffing, no caching, no framing by others. */
const BASE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Opener-Policy": "same-origin",
};

/**
 * A sandboxed document: opaque origin, no network, no forms, no framing by
 * anything but this deployment's own UI. `style-src 'unsafe-inline'` is required
 * by the inline `<style>` both documents carry, and is harmless in a document
 * that cannot load or run anything else.
 */
function documentCsp(frameAncestors: string): string {
  return (
    "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; " +
    `form-action 'none'; base-uri 'none'; frame-ancestors ${frameAncestors}`
  );
}

/**
 * Who may frame these documents.
 *
 * `'self'` alone means the chat UI — a *different* origin — gets
 * "refused to connect", which is what the artifact drawer showed: the list came
 * from the chat origin, but the document itself refused to be framed there. So
 * the chat origin has to be named explicitly.
 */
function documentCspFor(webOrigin: string | undefined): string {
  return documentCsp(frameAncestorsFor(webOrigin));
}

function frameAncestorsFor(webOrigin: string | undefined): string {
  const origin = (webOrigin ?? "").trim().replace(/\/$/, "");
  return origin === "" ? "'self'" : `'self' ${origin}`;
}

/** Raw text is inert by content type; the CSP is a second belt in case of sniffing. */
const TEXT_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'";

/**
 * The CSP for a document that runs *our* script and nothing else.
 *
 * The one place in this file that permits script, and the permission is a nonce:
 * the artifact's own bytes are escaped into the page as text, so the only script
 * the browser will accept is the one whose nonce we generated for this response.
 * `default-src 'none'` still holds, so a document cannot fetch, frame, or post
 * anywhere — its script can talk to the parent window and nothing else.
 *
 * `allow-scripts` *without* `allow-same-origin`: the origin stays opaque. With
 * both, the sandbox is escapable, which is the classic way to undo this header.
 */
function scriptedDocumentCsp(frameAncestors: string, nonce: string): string {
  return (
    `sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'; ` +
    `img-src data:; script-src 'nonce-${nonce}'; ` +
    `form-action 'none'; base-uri 'none'; frame-ancestors ${frameAncestors}`
  );
}

function send(
  res: http.ServerResponse,
  status: number,
  contentType: string,
  csp: string,
  body: string,
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, { ...BASE_HEADERS, "Content-Type": contentType, "Content-Security-Policy": csp, ...extra });
  res.end(body);
}

/** Each path segment encoded, slashes kept: a key is a path, not an opaque string. */
function hrefFor(key: string): string {
  return key.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

/** The conversation's artifacts, derived by the host from its own transcript. */
async function artifactsOf(
  options: ArtifactsServerOptions,
  conversationId: number,
): Promise<readonly ArtifactFile[] | undefined> {
  return options.seam.artifacts(conversationId);
}

function indexPage(conversationId: number, files: readonly ArtifactFile[]): string {
  const rows = files
    .map((file) => {
      const href = hrefFor(file.key);
      const counts = [
        file.wrote > 0 ? `${file.wrote} write${file.wrote === 1 ? "" : "s"}` : "",
        file.edited > 0 ? `${file.edited} edit${file.edited === 1 ? "" : "s"}` : "",
      ]
        .filter((part) => part !== "")
        .join(", ");
      const rendered = isMarkdown(file.key)
        ? ` · <a href="${href}?render">rendered</a>`
        : "";
      return `<li><a href="${href}">${escapeHtml(file.key)}</a><small>${escapeHtml(counts)}${rendered}</small></li>`;
    })
    .join("\n");

  const body =
    files.length === 0
      ? `<p>No files were written or edited in this conversation.</p>`
      : `<ul class="files">\n${rows}\n</ul>`;

  return markdownDocument(
    `artifacts · conversation ${conversationId}`,
    `<h1>Artifacts</h1>
<p class="meta">Conversation ${conversationId} · ${files.length} file${files.length === 1 ? "" : "s"}</p>
${body}
<p class="meta">Derived from the conversation's transcript: files changed through <code>bash</code> are not listed.</p>`,
  );
}

/**
 * The client-side half of commenting: what a selection means, and what a click
 * means.
 *
 * Deliberately tiny, and deliberately unable to reach the network: it reads the
 * selection out of the DOM, computes line and character offsets against the line
 * the browser says was touched, and posts a message to the parent window. The
 * parent is the only party that can submit anything, which is the whole point of
 * putting this here rather than giving the artifact origin a mutating route.
 *
 * Coordinates are 1-based and counted in **code points**, matching
 * `comments.ts`: a `Range.toString()` length is UTF-16 units, so it is spread
 * into code points before counting. A comment anchored to a column of emoji must
 * point where the cursor was, not where the bytes landed.
 */
const COMMENT_SCRIPT = `
(function () {
  var FRAME = { file: document.body.getAttribute("data-file") || "" };

  function lineElement(node) {
    var element = node && node.nodeType === 3 ? node.parentElement : node;
    return element && element.closest ? element.closest("[data-line]") : null;
  }

  function textSpan(lineElement) {
    return lineElement ? lineElement.querySelector(".tx") : null;
  }

  function codePointOffset(span, node, offset) {
    try {
      var range = document.createRange();
      range.setStart(span, 0);
      range.setEnd(node, offset);
      return Array.from(range.toString()).length;
    } catch (e) {
      return null;
    }
  }

  function report() {
    var selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      // A selection that went away is the reader dismissing the composer, so say
      // so: the parent closes the bar, unless something has been typed into it.
      parent.postMessage({ t: "pi-artifact-clear", file: FRAME.file }, "*");
      return;
    }
    var range = selection.getRangeAt(0);
    var startLine = lineElement(range.startContainer);
    var endLine = lineElement(range.endContainer);
    if (!startLine || !endLine) return;
    var start = Number(startLine.getAttribute("data-line"));
    var end = Number(endLine.getAttribute("data-line"));
    if (!start || !end) return;

    var startSpan = textSpan(startLine);
    var endSpan = textSpan(endLine);
    var message = {
      t: "pi-artifact-select",
      file: FRAME.file,
      line: start,
      endLine: end,
      quote: String(selection).slice(0, 400)
    };
    // Characters only within one line: a two-dimensional span has no format.
    if (start === end && startSpan && endSpan) {
      var from = codePointOffset(startSpan, range.startContainer, range.startOffset);
      var to = codePointOffset(endSpan, range.endContainer, range.endOffset);
      if (from !== null && to !== null && to > from) {
        message.charStart = from + 1;
        message.charEnd = to;
      }
    }
    parent.postMessage(message, "*");
  }

  var timer = null;
  document.addEventListener("selectionchange", function () {
    if (timer) clearTimeout(timer);
    // A little settled time: selectionchange fires per character while a
    // selection is being dragged, and the parent only needs the result.
    timer = setTimeout(report, 220);
  });

  document.addEventListener("click", function (event) {
    var target = event.target;
    var marker = target && target.closest ? target.closest("[data-comment-id]") : null;
    if (!marker) return;
    parent.postMessage(
      { t: "pi-artifact-open", id: marker.getAttribute("data-comment-id") },
      "*"
    );
  });

  // Tell the parent the document is ready for highlights it wants to change.
  parent.postMessage({ t: "pi-artifact-ready", file: FRAME.file }, "*");
})();
`;

/** One comment as the viewer draws it: positions are lines in *this* revision. */
interface ViewComment {
  id: string;
  file: string;
  positions: readonly number[];
  charStart?: number;
  charEnd?: number;
  state: string;
  text: string;
  label: string;
  /** The selected text, used by the rendered view to find its own highlight. */
  quote?: string;
  /** Which occurrence of `quote` this was, 0-based. */
  occurrence?: number;
}

/** Split one line around a comment's character range, counting code points. */
function splitAtCodePoints(text: string, from: number, to: number): [string, string, string] {
  const points = [...text];
  const start = Math.max(0, Math.min(from - 1, points.length));
  const end = Math.max(start, Math.min(to, points.length));
  return [points.slice(0, start).join(""), points.slice(start, end).join(""), points.slice(end).join("")];
}

/**
 * One line of the source view, with its comment marks.
 *
 * Whole-line comments mark the line; a character range marks just those
 * characters. The marker (a superscript number) goes at the end of the mark so a
 * tap target exists even for a one-character highlight, and both carry
 * `data-comment-id` so the click handler needs one rule.
 */
function sourceLine(number: number, text: string, comments: readonly ViewComment[]): string {
  const marks = comments.filter((comment) => comment.positions.includes(number));
  const ranges = marks.filter(
    (comment) =>
      comment.charStart !== undefined && comment.charEnd !== undefined && comment.positions.length === 1,
  );

  let body = escapeHtml(text);
  if (ranges.length === 1) {
    // A character range is the narrowest thing a person can select, so it wins
    // over the whole-line mark for the same line.
    const only = ranges[0]!;
    const [before, middle, after] = splitAtCodePoints(text, only.charStart!, only.charEnd!);
    body =
      escapeHtml(before) +
      `<mark class="cm ${escapeHtml(only.state)}" data-comment-id="${escapeHtml(only.id)}">${escapeHtml(middle)}</mark>` +
      `<sup class="cmark" data-comment-id="${escapeHtml(only.id)}">${escapeHtml(only.label)}</sup>` +
      escapeHtml(after);
  } else if (marks.length > 0) {
    const first = marks[0]!;
    // Labels only on the last line a comment covers, so a three-line highlight
    // shows one number rather than three.
    const label = marks
      .filter((comment) => comment.positions[comment.positions.length - 1] === number)
      .map((comment) => comment.label)
      .join("");
    body =
      `<mark class="cm ${escapeHtml(first.state)}" data-comment-id="${escapeHtml(first.id)}">${escapeHtml(text)}</mark>` +
      (label === ""
        ? ""
        : `<sup class="cmark" data-comment-id="${escapeHtml(first.id)}">${escapeHtml(label)}</sup>`);
  }

  return `<div class="ln" id="L${number}" data-line="${number}"><a class="no" href="#L${number}">${number}</a><span class="tx">${body}</span></div>`;
}

/**
 * The script for a *rendered* document, where there are no line numbers.
 *
 * A paragraph is not a line, so a selection here is reported as **text**: the
 * parent asks the host where that text came from, and the host searches the
 * source. `occurrence` is the count of earlier identical matches in this
 * document, which is how a comment on the second "return null" stays on the
 * second one after the source is searched instead of the DOM.
 *
 * Painting works the same way in reverse: each comment's quote is found in the
 * rendered text and wrapped, so the highlight sits on the words the person
 * selected rather than on a whole block.
 */
const RENDER_SCRIPT = `
(function () {
  var FRAME = { file: document.body.getAttribute("data-file") || "" };

  function textNodes() {
    var nodes = [];
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        var parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest("pre, code, mark, script, sup.cmark")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  }

  /** Which occurrence of \`needle\` in the document a selection starts at. */
  function occurrenceOf(needle, container, offset) {
    if (!needle) return 0;
    var seen = 0;
    var nodes = textNodes();
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      var text = node.nodeValue || "";
      var from = text.indexOf(needle);
      while (from !== -1) {
        // Before the selection? Then it is an earlier instance.
        var range = document.createRange();
        range.setStart(node, from);
        range.setEnd(node, from + needle.length);
        var before = range.compareBoundaryPoints(Range.START_TO_START, (function () {
          var sel = window.getSelection();
          if (!sel || sel.rangeCount === 0) return range;
          return sel.getRangeAt(0);
        })()) < 0;
        var isTheSelection = node === container || (container.compareDocumentPosition && false);
        if (before) { seen += 1; }
        else { return seen; }
        from = text.indexOf(needle, from + 1);
      }
    }
    return seen;
  }

  function report() {
    var selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      parent.postMessage({ t: "pi-artifact-clear", file: FRAME.file }, "*");
      return;
    }
    var quote = String(selection).trim();
    if (!quote) return;
    var firstLine = quote.split("\\n")[0].trim();
    var range = selection.getRangeAt(0);
    parent.postMessage({
      t: "pi-artifact-select",
      file: FRAME.file,
      quote: quote.slice(0, 400),
      occurrence: occurrenceOf(firstLine, range.startContainer, range.startOffset)
    }, "*");
  }

  function mark(comment) {
    // A selection can span several source lines (a paragraph), and the rendered
    // document joins them into one run of text — so the search needle is the
    // first line of the quote. The occurrence count is taken the same way.
    var needle = ((comment.quote || "").split("\\n")[0] || "").trim();
    if (!needle) return;
    var wanted = comment.occurrence || 0;
    var seen = 0;
    var nodes = textNodes();
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      var text = node.nodeValue || "";
      var at = text.indexOf(needle);
      while (at !== -1) {
        if (seen === wanted) {
          var range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + needle.length);
          var wrap = document.createElement("mark");
          wrap.className = "cm " + (comment.state || "visible");
          wrap.setAttribute("data-comment-id", comment.id);
          try {
            range.surroundContents(wrap);
            var sup = document.createElement("sup");
            sup.className = "cmark";
            sup.setAttribute("data-comment-id", comment.id);
            sup.textContent = comment.label || "*";
            wrap.parentNode.insertBefore(sup, wrap.nextSibling);
          } catch (e) {
            // A range spanning several elements cannot be wrapped; leave it.
          }
          return;
        }
        seen += 1;
        at = text.indexOf(needle, at + 1);
      }
    }
  }

  var timer = null;
  document.addEventListener("selectionchange", function () {
    if (timer) clearTimeout(timer);
    timer = setTimeout(report, 220);
  });

  document.addEventListener("click", function (event) {
    var target = event.target;
    var marker = target && target.closest ? target.closest("[data-comment-id]") : null;
    if (!marker) return;
    parent.postMessage({ t: "pi-artifact-open", id: marker.getAttribute("data-comment-id") }, "*");
  });

  try {
    var data = JSON.parse(document.getElementById("comment-data").textContent || "[]");
    for (var i = 0; i < data.length; i += 1) mark(data[i]);
  } catch (e) {}

  parent.postMessage({ t: "pi-artifact-ready", file: FRAME.file }, "*");
})();
`;

/**
 * The source view: numbered lines, comment marks, and the selection script.
 *
 * Served as `text/html` and therefore escaped line by line — the artifact's bytes
 * are never markup here, which is what lets the page carry a script at all. The
 * nonce is per response, so a document cannot reuse another response's script
 * permission.
 */
function sourceDocument(input: {
  key: string;
  content: string;
  meta: string;
  comments: readonly ViewComment[];
  nonce: string;
  frameAncestors: string;
}): string {
  const lines = input.content.split("\n");
  const rows = lines.map((line, index) => sourceLine(index + 1, line, input.comments)).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.key)}</title>
<style>
  :root { color-scheme: light dark;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", "Cascadia Code", "JetBrains Mono", Menlo, Consolas, monospace; }
  body { margin: 0; padding: 0 0 4rem; font: 13px/1.55 var(--mono); }
  .meta { padding: .5rem .75rem; opacity: .7; border-bottom: 1px solid #8883; margin: 0; }
  .ln { display: flex; gap: .75rem; padding: 0 .75rem; white-space: pre-wrap; word-break: break-word; }
  .ln:target { background: #ffd54a33; }
  .no { flex: none; width: 3.5em; text-align: right; opacity: .45; text-decoration: none;
        color: inherit; user-select: none; }
  .tx { flex: 1; min-width: 0; }
  mark.cm { background: #ffd54a66; color: inherit; border-radius: 2px; cursor: pointer; }
  mark.cm.orphaned { background: #ff8a8a55; }
  mark.cm.resolved { background: #8affa055; }
  sup.cmark { color: inherit; background: #ffd54a99; border-radius: 999px; padding: 0 .35em;
              margin-left: .15em; font-size: .8em; cursor: pointer; text-decoration: none; }
</style>
</head>
<body data-file="${escapeHtml(input.key)}">
<p class="meta">${escapeHtml(input.meta)}</p>
${rows}
<script nonce="${input.nonce}">${COMMENT_SCRIPT}</script>
</body>
</html>`;
}

/**
 * A rendered Markdown document with the comment layer bolted on.
 *
 * The renderer is untouched — it still escapes before it emits, and it still
 * knows nothing about comments. The layer is injected: a small style block for
 * the marks, the comments as data, and the script that paints them. Everything
 * the script needs is inline, because this document cannot fetch anything.
 */
function renderedDocument(key: string, bodyHtml: string, input: {
  meta: string;
  comments: readonly ViewComment[];
  nonce: string;
}): string {
  const data = input.comments.map((comment) => ({
    id: comment.id,
    quote: comment.quote ?? "",
    occurrence: comment.occurrence ?? 0,
    state: comment.state,
    label: comment.label,
  }));
  const style = `<style>
  mark.cm { background: #ffd54a66; color: inherit; border-radius: 2px; cursor: pointer; }
  mark.cm.orphaned { background: #ff8a8a55; }
  sup.cmark { color: inherit; background: #ffd54a99; border-radius: 999px; padding: 0 .35em;
              margin-left: .15em; font-size: .8em; cursor: pointer; }
  .comment-meta { font: .8em var(--mono, monospace); opacity: .65; }
</style>`;
  const payload = `<script type="application/json" id="comment-data" nonce="${input.nonce}">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`;
  const script = `<script nonce="${input.nonce}">${RENDER_SCRIPT}</script>`;
  const head = `${style}</head>`;
  const tail = `${payload}${script}</body>`;
  return markdownDocument(key, `<p class="comment-meta">${escapeHtml(input.meta)}</p>\n${bodyHtml}`)
    // The script needs to know which file it is looking at, and `markdownDocument`
    // is shared with callers that have no comments, so the attribute is added here
    // rather than by changing the template.
    .replace("<body>", `<body data-file="${escapeHtml(key)}">`)
    .replace("</head>", head)
    .replace("</body>", tail);
}

/** One request. Split out so tests can drive it without a socket. */
async function handle(
  options: ArtifactsServerOptions,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://artifacts.invalid");
  const documentCsp = documentCspFor(options.webOrigin);

  if (req.method === "GET" && url.pathname === "/healthz") {
    send(res, 200, "text/plain; charset=utf-8", TEXT_CSP, "ok");
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, "text/plain; charset=utf-8", TEXT_CSP, "method not allowed", { Allow: "GET, HEAD" });
    return;
  }

  const match = /^\/c\/(\d+)(?:\/(.*))?$/.exec(url.pathname);
  if (!match) {
    send(res, 404, "text/plain; charset=utf-8", TEXT_CSP, "not found");
    return;
  }
  const conversationId = Number(match[1]);
  const rawKey = match[2] ?? "";

  const files = await artifactsOf(options, conversationId);
  if (files === undefined) {
    send(res, 404, "text/plain; charset=utf-8", TEXT_CSP, `no such conversation: ${conversationId}`);
    return;
  }

  if (rawKey === "") {
    send(res, 200, "text/html; charset=utf-8", documentCsp, indexPage(conversationId, files));
    return;
  }

  let key: string;
  try {
    key = decodeURIComponent(rawKey);
  } catch {
    send(res, 400, "text/plain; charset=utf-8", TEXT_CSP, "bad path encoding");
    return;
  }

  // The derived list IS the allow-list: a key that is not in it cannot be read,
  // so no amount of `..`, absolute paths or symlink games reaches anything else.
  const file = files.find((candidate) => candidate.key === key);
  if (!file) {
    send(res, 404, "text/plain; charset=utf-8", TEXT_CSP, `not an artifact of this conversation: ${key}`);
    return;
  }

  const revision = (url.searchParams.get("rev") ?? "").trim();
  const repo = options.repoFor?.(conversationId);

  let read;
  try {
    if (revision !== "" && revision !== "latest") {
      // A pinned revision: the file as the conversation produced it, read out of
      // jj rather than off the disk. The allow-list above still decides *which*
      // paths may be read, so a revision cannot widen what is reachable.
      if (!repo) {
        send(res, 400, "text/plain; charset=utf-8", TEXT_CSP, "artifacts are not version controlled here");
        return;
      }
      const content = await showFile(repo, revision, repoRelativePath(repo, file.key));
      const redacted = options.redact ? options.redact(content) : content;
      read = {
        content: redacted,
        size: Buffer.byteLength(content, "utf8"),
        truncated: false,
        binary: content.includes("\u0000"),
        resolved: file.path,
      };
    } else {
      read = readArtifact(file, { ...(options.redact ? { redact: options.redact } : {}) });
    }
  } catch (error) {
    logger.error(`[artifacts] ${key}: ${(error as Error).message}`);
    send(res, 404, "text/plain; charset=utf-8", TEXT_CSP, `unreadable: ${key}`);
    return;
  }

  if (read.binary) {
    send(
      res,
      415,
      "text/plain; charset=utf-8",
      TEXT_CSP,
      `${key} looks binary (${read.size} bytes); this viewer only shows text.`,
    );
    return;
  }

  if (url.searchParams.get("view") === "source") {
    // The commentable view: numbered lines, existing marks, and the selection
    // script. Its own CSP, because it is the one document here that runs script.
    const comments = (await options.seam.comments(conversationId)) ?? [];
    const view: ViewComment[] = comments
      .filter((comment) => comment.file === key && comment.state !== "resolved")
      .map((comment, index) => ({
        id: comment.id,
        file: comment.file,
        positions: comment.positions,
        ...(comment.charStart === undefined ? {} : { charStart: comment.charStart }),
        ...(comment.charEnd === undefined ? {} : { charEnd: comment.charEnd }),
        state: comment.state,
        text: comment.text,
        label: index < 9 ? String(index + 1) : "+",
        ...(comment.quote === undefined ? {} : { quote: comment.quote }),
        ...(comment.occurrence === undefined ? {} : { occurrence: comment.occurrence }),
      }));
    const nonce = randomBytes(16).toString("base64");
    const where = revision === "" || revision === "latest" ? "latest" : `revision ${revision}`;
    const meta = `${key} · ${where}${view.length === 0 ? "" : ` · ${view.length} open comment${view.length === 1 ? "" : "s"}`}`;
    send(
      res,
      200,
      "text/html; charset=utf-8",
      scriptedDocumentCsp(frameAncestorsFor(options.webOrigin), nonce),
      sourceDocument({
        key,
        content: read.content,
        meta,
        comments: view,
        nonce,
        frameAncestors: frameAncestorsFor(options.webOrigin),
      }),
    );
    return;
  }

  if (url.searchParams.has("render") && isMarkdown(key)) {
    const body = renderMarkdown(read.content);
    const note = read.truncated ? `<p class="meta">Truncated at ${read.content.length} of ${read.size} bytes.</p>` : "";

    if (!repo) {
      // No repository, no comments: the plain document is still the right answer,
      // and it is the one without a script.
      send(res, 200, "text/html; charset=utf-8", documentCsp, markdownDocument(key, body + note));
      return;
    }

    // Rendered *and* commentable. A rendered page has no line numbers, so the
    // document reports the selected text and the host finds the source lines it
    // came from — which is why nothing here has to know how Markdown was parsed.
    const comments = (await options.seam.comments(conversationId)) ?? [];
    const view: ViewComment[] = comments
      .filter((comment) => comment.file === key && comment.state !== "resolved")
      .map((comment, index) => ({
        id: comment.id,
        file: comment.file,
        positions: comment.positions,
        state: comment.state,
        text: comment.text,
        label: index < 9 ? String(index + 1) : "+",
        ...(comment.quote === undefined ? {} : { quote: comment.quote }),
        ...(comment.occurrence === undefined ? {} : { occurrence: comment.occurrence }),
      }));
    const nonce = randomBytes(16).toString("base64");
    const where = revision === "" || revision === "latest" ? "latest" : `revision ${revision}`;
    const meta = `${key} · ${where}${view.length === 0 ? "" : ` · ${view.length} open comment${view.length === 1 ? "" : "s"}`}`;
    send(
      res,
      200,
      "text/html; charset=utf-8",
      scriptedDocumentCsp(frameAncestorsFor(options.webOrigin), nonce),
      renderedDocument(key, body + note, { meta, comments: view, nonce }),
    );
    return;
  }

  const suffix = read.truncated
    ? `\n\n--- truncated: showing ${read.content.length} of ${read.size} bytes ---\n`
    : "";
  send(res, 200, "text/plain; charset=utf-8", TEXT_CSP, read.content + suffix, {
    "Content-Disposition": `inline; filename="${encodeURIComponent(key.split("/").at(-1) ?? key)}"`,
  });
}

/** Start the artifact listener. Resolves once it is accepting connections. */
export function startArtifactsServer(options: ArtifactsServerOptions): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    void handle(options, req, res).catch((error: unknown) => {
      logger.error("[artifacts] request failed:", (error as Error).message);
      if (!res.headersSent) {
        send(res, 500, "text/plain; charset=utf-8", TEXT_CSP, "internal error");
      } else {
        res.end();
      }
    });
  });

  const bind = options.bind ?? "127.0.0.1";
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, bind, () => {
      server.off("error", reject);
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : options.port;
      logger.info(`[artifacts] listening on http://${bind}:${port}`);
      resolve(server);
    });
  });
}
