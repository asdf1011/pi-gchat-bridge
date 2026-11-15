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

import { imageTypeOf, isMarkdown, readArtifact, readArtifactBytes, type ArtifactFile } from "../durable/artifacts.js";
import { repoRelativePath, showFile, showFileBytes } from "../durable/artifact-vcs.js";
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

/**
 * The CSP for the image wrapper document.
 *
 * `img-src 'self'` is the one allowance and it is deliberately the narrowest that
 * works: the wrapper shows a picture that this same origin holds and nothing else.
 * `default-src 'none'` still covers fetch, frames and script, and the document has
 * no script at all — so a picture is a picture, and cannot become a page.
 */
function imageDocumentCsp(frameAncestors: string, nonce: string): string {
  return (
    `sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'; ` +
    `img-src 'self' data:; script-src 'nonce-${nonce}'; ` +
    `form-action 'none'; base-uri 'none'; frame-ancestors ${frameAncestors}`
  );
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
  body: string | Buffer,
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, { ...BASE_HEADERS, "Content-Type": contentType, "Content-Security-Policy": csp, ...extra });
  res.end(body);
}

/**
 * The CSP for an image served from this origin.
 *
 * An image is *not* a document: it is never parsed as HTML, it cannot carry script,
 * and the only thing it can do is be drawn. So this is `default-src 'none'` and
 * nothing else — no `sandbox`, which applies to documents and would be noise here.
 * A sandbox would also stop the image being framed, and one of the two things that
 * happens to these bytes is exactly that.
 */
const IMAGE_CSP = "default-src 'none'";

/**
 * An image at a pinned revision, read out of jj rather than off the disk.
 *
 * The same rule as the text path: the allow-list has already decided *which* paths
 * may be read, so a revision cannot widen what is reachable. The only difference is
 * that the bytes are not decoded on the way through.
 */
async function readImageAtRevision(
  options: ArtifactsServerOptions,
  repo: string,
  revision: string,
  file: ArtifactFile,
): Promise<{ bytes: Buffer; size: number }> {
  const bytes = await showFileBytes(repo, revision, await repoPathOrThrow(repo, file.path, file.key));
  return { bytes, size: bytes.length };
}

/**
 * The path a file has *inside the repository*, for a jj read.
 *
 * The file's absolute path is what the host derived, and the repository is wherever
 * `jj root` says — which is not always the conversation directory: the artifacts
 * directory usually lives inside a checkout, so its repo is that checkout. Asking jj
 * is the only way to get this right for both.
 */
async function repoPathOrThrow(repo: string, absolute: string, key: string): Promise<string> {
  const relative = await repoRelativePath(repo, absolute);
  if (relative === undefined) throw new Error(`${key} is not a file in this repository`);
  return relative;
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
/**
 * The swipe gesture, shared by both documents.
 *
 * One copy interpolated into each script rather than two hand-kept ones: a rendered
 * document and a source document are two builds of the same behaviour, and a fix
 * applied to one is a fix the reader does not get in the other. Exported so the e2e
 * test can serve a document that really carries it, instead of a stub with no
 * gesture handling that would pass for the wrong reason.
 *
 * The document lives in a sandboxed cross-origin frame, so its pointer events never
 * reach the page that frames it: the gesture is recognised in here and posted out,
 * the same way a selection is. The parent decides what "next" means; this reports
 * which way the finger went.
 */
export const SWIPE_SCRIPT = `
  // --- Swiping between artifacts --------------------------------------------
  //
  // Two gestures share this surface, and getting the test wrong is what makes a
  // document feel broken: a horizontal swipe must page, and a vertical drag must
  // still scroll. So nothing is decided until the gesture is over, and then only if
  // the movement was dominantly horizontal and long enough to be deliberate.
  //
  // "Over" is touchend OR touchcancel, and that distinction is the whole reason
  // this is not a dozen lines. On iOS a touch the system claims — which includes a
  // horizontal drag that turns into a back-navigation swipe, and any gesture the
  // scroll view decides it owns — is ended with touchcancel, and touchend never
  // arrives. A handler that only listens for touchend therefore works on desktop
  // Chromium and does nothing on the phone, which is exactly the bug this rewrite
  // fixes: the position is tracked on every touchmove, so a cancelled gesture can
  // still be judged from where it had got to.
  (function () {
    var DISTANCE = 60;       // how far a swipe has to travel to count (a tap is ~0)
    var DRAG_START = 8;      // where the document starts following the finger
    var RATIO = 1.5;         // horizontal must beat vertical by this much
    var SLOW = 800;          // longer than this is a drag, not a flick
    var start = null;
    var last = null;

    function pointOf(event) {
      // changedTouches is where a touch really is; clientX is 0 on some browsers
      // for a touchend, which would read every swipe as a huge one.
      var touch = event.changedTouches && event.changedTouches[0];
      if (touch) return { x: touch.clientX, y: touch.clientY };
      var live = event.touches && event.touches[0];
      if (live) return { x: live.clientX, y: live.clientY };
      if (typeof event.clientX === "number") return { x: event.clientX, y: event.clientY };
      return null;
    }

    /** Judge the gesture that just ended, from wherever it had reached. */
    function settle(event) {
      if (!start) return;
      var from = start;
      var to = last || pointOf(event);
      start = null;
      last = null;
      if (!to) return;
      var dx = to.x - from.x;
      var dy = to.y - from.y;
      var absX = Math.abs(dx);
      var absY = Math.abs(dy);
      // Anything that does not qualify leaves the pane wherever the drag put it,
      // so it has to be released before each of these early returns.
      function abort() {
        parent.postMessage({ t: "pi-artifact-drag-end", commit: false }, "*");
      }
      if (absX < DISTANCE) return abort();
      if (absX < absY * RATIO) return abort();   // mostly vertical: a scroll
      if (Date.now() - from.at > SLOW) return abort();
      // A selection the reader is making is not a page turn either.
      var selection = window.getSelection && window.getSelection();
      if (selection && !selection.isCollapsed) {
        // Not a page turn, so the pane must go back where it was.
        parent.postMessage({ t: "pi-artifact-drag-end", commit: false }, "*");
        return;
      }
      // commit says the drawer may keep the movement and finish the slide; the
      // direction tells it which way to bring the next document in.
      parent.postMessage(
        { t: "pi-artifact-swipe", direction: dx < 0 ? "left" : "right", commit: true },
        "*",
      );
    }

    document.addEventListener("touchstart", function (event) {
      // Two fingers is a pinch or a system gesture, not a page turn.
      if (event.touches && event.touches.length > 1) { start = null; last = null; return; }
      var point = pointOf(event);
      start = point ? { x: point.x, y: point.y, at: Date.now() } : null;
      last = point;
    }, { passive: true });

    // Tracking on move does two things: it keeps a cancelled gesture judgeable, and
    // it is what lets the drawer follow the finger. Every move reports the offset
    // once the gesture has committed to being horizontal — before that, the reader
    // may still be scrolling, and moving the page then would fight them.
    document.addEventListener("touchmove", function (event) {
      if (!start) return;
      var point = pointOf(event);
      if (!point) return;
      last = point;
      var dx = point.x - start.x;
      var dy = point.y - start.y;
      var absX = Math.abs(dx);
      var absY = Math.abs(dy);
      // Past the slop, and clearly more horizontal than vertical. Both conditions
      // have to hold before anything moves: a diagonal drag that keeps scrolling
      // must not drag the document sideways while it does.
      if (absX < DRAG_START || absX < absY * RATIO) return;
      parent.postMessage({ t: "pi-artifact-drag", dx: dx }, "*");
    }, { passive: true });

    document.addEventListener("touchend", settle, { passive: true });
    // iOS ends an interrupted gesture here; judge it on the way out rather than
    // throwing the whole swipe away.
    document.addEventListener("touchcancel", settle, { passive: true });

    // A trackpad's two-finger swipe arrives as a wheel event with a horizontal
    // delta, and it is the same gesture to the person making it. Events stream, so
    // this accumulates until the momentum dies down and fires once.
    var travel = 0;
    // NOT named "settle": that is the touch handler's name, and var hoists — a
    // second "var settle" in this same scope overwrote the function with null
    // before addEventListener("touchend", settle) ran, so every swipe bound null
    // and no gesture was ever judged. This is the bug that made swiping do nothing
    // on a real device while the code read correctly.
    var wheelTimer = null;
    document.addEventListener("wheel", function (event) {
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) { travel = 0; return; }
      if (event.ctrlKey) return;              // ctrl+wheel is zoom
      var selection = window.getSelection && window.getSelection();
      if (selection && !selection.isCollapsed) return;
      travel += event.deltaX;
      if (wheelTimer) clearTimeout(wheelTimer);
      wheelTimer = setTimeout(function () {
        var moved = travel;
        travel = 0;
        wheelTimer = null;
        if (Math.abs(moved) < 60) return;
        parent.postMessage({ t: "pi-artifact-swipe", direction: moved > 0 ? "left" : "right" }, "*");
      }, 120);
    }, { passive: true });
  })();
`;

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

  /** The selected text without the furniture: line numbers and comment markers are not the quote. */
  function quoteOf(range) {
    try {
      var fragment = range.cloneContents();
      var junk = fragment.querySelectorAll(".no, sup.cmark");
      for (var i = 0; i < junk.length; i += 1) {
        if (junk[i].parentNode) junk[i].parentNode.removeChild(junk[i]);
      }
      var text = fragment.textContent || "";
      if (text.trim()) return text.trim();
    } catch (e) {}
    // Nothing clonable: fall back to what the selection itself says.
    return String(window.getSelection()).trim();
  }

  /** The selection as a message, or null when there is nothing worth commenting on. */
  function describe() {
    var selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    var range = selection.getRangeAt(0);
    var startLine = lineElement(range.startContainer);
    var endLine = lineElement(range.endContainer);
    if (!startLine || !endLine) return null;
    var start = Number(startLine.getAttribute("data-line"));
    var end = Number(endLine.getAttribute("data-line"));
    if (!start || !end) return null;

    var startSpan = textSpan(startLine);
    var endSpan = textSpan(endLine);
    var message = {
      t: "pi-artifact-select",
      file: FRAME.file,
      line: start,
      endLine: end,
      // Not the selection's own string: a selection spanning lines also spans the gutter, so the
      // quote would read "first line, 3second line" — line numbers pasted into the comment.
      quote: quoteOf(range).slice(0, 400)
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
    return { range: range, message: message };
  }

  // --- The comment affordance -------------------------------------------------
  //
  // Selecting text no longer opens the composer. People select text to read it, and a box appearing
  // over the page is a distraction; so a small button appears beside the selection and *that* is what
  // opens the comment box. The click carries the intent, which is what lets the pane focus the field:
  // the reader said they wanted to write something, rather than being interrupted mid-read.
  var affordance = null;

  function hideAffordance() {
    if (!affordance) return;
    if (affordance.parentNode) affordance.parentNode.removeChild(affordance);
    affordance = null;
  }

  /**
   * A coarse pointer means a finger, and a finger means the platform's own menu.
   *
   * Deliberately the pointer media feature rather than a width: a small laptop window
   * is not a
   * phone, and a tablet with a keyboard is one device with two answers. What matters
   * is whether the selection came with tear-drop handles and a system toolbar, and
   * that follows the input device.
   */
  function isTouch() {
    try {
      return window.matchMedia("(pointer: coarse)").matches;
    } catch (e) {
      return false;
    }
  }

  function showAffordance(range, message) {
    hideAffordance();
    // On a touch device the page draws nothing. Selecting text raises the system menu
    // (Copy / Select all / Share) directly above the selection and two drag handles at
    // its bottom corners; a button of ours sits on top of one or the other, and there is
    // no web API to add ourselves to the system menu instead. So the *parent* shows the
    // action, in a bar above the composer, where none of that reaches.
    if (isTouch()) {
      message.intent = "comment";
      parent.postMessage({ t: "pi-artifact-select-touch", message: message }, "*");
      return;
    }
    var rect;
    try {
      rect = range.getBoundingClientRect();
    } catch (e) {
      rect = null;
    }
    // Below the selection, not above it. Above is where a desktop browser puts its own
    // selection toolbar, so a button there is covered by it or collides with it.
    //
    // A zero rect is what a headless DOM reports; pinning the button top-left there is
    // better than throwing, because the tests drive exactly this path.
    var GAP = 30;   // clears the selection's own handles on touch
    var BUTTON_H = 34;
    var selectionTop = (rect && rect.top) || 8;
    var selectionBottom = rect && rect.bottom ? rect.bottom : selectionTop;
    // Below the selection when it fits, above only when it does not: near the bottom of
    // the viewport there is no room underneath, and above is then the lesser evil.
    var below = selectionBottom + GAP;
    var top = below + BUTTON_H <= (window.innerHeight || 600)
      ? below
      : Math.max(4, selectionTop - BUTTON_H);
    var left = Math.max(4, Math.min((window.innerWidth || 800) - 44, ((rect && rect.right) || 8) + 6));
    var button = document.createElement("button");
    button.type = "button";
    button.className = "cm-add";
    button.title = "Comment on this";
    button.setAttribute("aria-label", "Comment on the selected text");
    button.textContent = "Comment";
    button.style.position = "fixed";
    button.style.top = top + "px";
    button.style.left = left + "px";
    button.style.zIndex = "2147483647";
    // Without this the press itself collapses the selection, and the click would report nothing.
    button.addEventListener("mousedown", function (event) { event.preventDefault(); });
    button.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      hideAffordance();
      message.intent = "comment";
      parent.postMessage(message, "*");
    });
    document.body.appendChild(button);
    affordance = button;
  }

  var timer = null;
  document.addEventListener("selectionchange", function () {
    if (timer) clearTimeout(timer);
    // A little settled time: selectionchange fires per character while a selection is being
    // dragged, and only the settled result is worth a button.
    timer = setTimeout(function () {
      var built = describe();
      if (!built) {
        hideAffordance();
        // No touch message here: the clear message below already tells the page the
        // selection is gone, on every device, and the page treats it as the one place
        // that forgets a selection. A second "nothing selected" would be a second thing
        // to keep in step.
        // A selection that went away is the reader dismissing the composer, so say so: the parent
        // closes the bar, unless something has been typed into it.
        parent.postMessage({ t: "pi-artifact-clear", file: FRAME.file }, "*");
        return;
      }
      showAffordance(built.range, built.message);
    }, 220);
  });
  document.addEventListener("scroll", hideAffordance, true);
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") hideAffordance();
  });
  // The key that does what the affordance does. Both scripts install the same handler;
  // the collaborators are what differ (this one reports line numbers, the rendered one
  // reports text and an occurrence).
  document.addEventListener(
    "keydown",
    ${commentKeyHandler.toString()}({
      isTouch: isTouch,
      ready: function () { return !!affordance; },
      hide: hideAffordance,
      describe: describe,
      post: function (message) { parent.postMessage(message, "*"); }
    })
  );

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
  // Tell the parent the document is ready for highlights it wants to change.
  ${SWIPE_SCRIPT}

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
 * A `c` press turns the settled selection into a comment.
 *
 * The affordance beside the selection is a mouse-shaped offer, and reaching for it is
 * a trip to a button for someone who has just selected the text they want to comment
 * on. So the key does what the button does — and sends the same `intent: "comment"`, so
 * the pane focuses the field. Anything else would be a second meaning for the same act.
 *
 * Deliberately narrow, because a stray `c` must never open a comment box or swallow a
 * keystroke meant for something else. Every condition here is a reason *not* to act:
 *
 *   - **not on a touch device** — there is no keyboard, and the platform's own menus are
 *     what a phone uses. This is the same `isTouch()` that decides whether the
 *     affordance is drawn, so no device gets half of the behaviour.
 *   - **only while a selection is settled** — `ready()` is what says so. It is exactly
 *     the state in which the reader is looking at the offer.
 *   - **no modifiers** — `Cmd/Ctrl+C` is copy, and stealing it would be a real bug.
 *   - **not while typing** — inside an `input`, `textarea`, `select` or a
 *     `contenteditable`, `c` is a letter. The frame has none of those today, but the
 *     check costs nothing and the failure would be silent.
 *   - **the selection is re-read under the key**, because the reader may have moved it
 *     since the affordance was drawn; a stale message would comment on the wrong lines.
 *
 * Returned rather than installed, and given its collaborators, so both scripts — source
 * and rendered — share one implementation without either owning a copy of the rules.
 */
function commentKeyHandler(deps: {
  isTouch: () => boolean;
  ready: () => boolean;
  hide: () => void;
  describe: () => { message: Record<string, unknown> } | null;
  post: (message: unknown) => void;
}): (event: KeyboardEvent) => void {
  return function (event: KeyboardEvent): void {
    if (event.key !== "c" && event.key !== "C") return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.defaultPrevented) return;
    if (deps.isTouch()) return;
    if (!deps.ready()) return;
    // The target is an `EventTarget` in TypeScript and an element at runtime, which is
    // it: a keydown in a document always lands on a node. Narrowed rather than cast, so
    // a same-named property elsewhere cannot be mistaken for a tag name.
    var node = event.target as (EventTarget & { nodeName?: string; isContentEditable?: boolean; closest?: (selector: string) => Element | null }) | null;
    var name = node && node.nodeName ? String(node.nodeName).toLowerCase() : "";
    if (name === "input" || name === "textarea" || name === "select") return;
    if (node && (node.isContentEditable || (node.closest && node.closest("[contenteditable]")))) return;
    var built = deps.describe();
    if (!built) return;
    event.preventDefault();
    deps.hide();
    var message = built.message;
    message.intent = "comment";
    deps.post(message);
  };
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
export const RENDER_SCRIPT = `
(function () {
  var FRAME = { file: document.body.getAttribute("data-file") || "" };

  function textNodes() {
    var nodes = [];
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        var parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        // Inline code is allowed: a code span is prose-sized text, and a highlight inside it
        // neither breaks copying nor rendering. It used to be excluded, which made every comment
        // on a code span invisible in the rendered view — including a comment on an API heading,
        // where this document keeps its subject matter. Fenced blocks stay excluded: they are
        // line-anchored, and wrapping text across one breaks whitespace and selection, so comments
        // there belong to the source view.
        if (parent.closest("pre, mark, script, sup.cmark")) return NodeFilter.FILTER_REJECT;
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

  /** The selection as a message, or null when there is nothing worth commenting on. */
  /** The selected text without the furniture: line numbers and comment markers are not the quote. */
  function quoteOf(range) {
    try {
      var fragment = range.cloneContents();
      var junk = fragment.querySelectorAll(".no, sup.cmark");
      for (var i = 0; i < junk.length; i += 1) {
        if (junk[i].parentNode) junk[i].parentNode.removeChild(junk[i]);
      }
      var text = fragment.textContent || "";
      if (text.trim()) return text.trim();
    } catch (e) {}
    // Nothing clonable: fall back to what the selection itself says.
    return String(window.getSelection()).trim();
  }

  function describe() {
    var selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    var range = selection.getRangeAt(0);
    var quote = quoteOf(range);
    if (!quote) return null;
    var firstLine = quote.split("\\n")[0].trim();
    return {
      range: range,
      message: {
        t: "pi-artifact-select",
        file: FRAME.file,
        quote: quote.slice(0, 400),
        occurrence: occurrenceOf(firstLine, range.startContainer, range.startOffset)
      }
    };
  }

  // The comment affordance: see the source view's copy for why selecting text no longer opens the
  // composer. Two documents, one behaviour — kept literally identical so they cannot drift.
  var affordance = null;

  function hideAffordance() {
    if (!affordance) return;
    if (affordance.parentNode) affordance.parentNode.removeChild(affordance);
    affordance = null;
  }

  /**
   * A coarse pointer means a finger, and a finger means the platform's own menu.
   *
   * Deliberately the pointer media feature rather than a width: a small laptop window
   * is not a phone, and a tablet with a keyboard is one device with two answers. What
   * matters
   * is whether the selection came with tear-drop handles and a system toolbar, and
   * that follows the input device.
   */
  function isTouch() {
    try {
      return window.matchMedia("(pointer: coarse)").matches;
    } catch (e) {
      return false;
    }
  }

  function showAffordance(range, message) {
    hideAffordance();
    // On a touch device the page draws nothing. Selecting text raises the system menu
    // (Copy / Select all / Share) directly above the selection and two drag handles at
    // its bottom corners; a button of ours sits on top of one or the other, and there is
    // no web API to add ourselves to the system menu instead. So the *parent* shows the
    // action, in a bar above the composer, where none of that reaches.
    if (isTouch()) {
      message.intent = "comment";
      parent.postMessage({ t: "pi-artifact-select-touch", message: message }, "*");
      return;
    }
    var rect;
    try {
      rect = range.getBoundingClientRect();
    } catch (e) {
      rect = null;
    }
    // Below the selection, not above it. Above is where a desktop browser puts its own
    // selection toolbar, so a button there is covered by it or collides with it.
    //
    // A zero rect is what a headless DOM reports; pinning the button top-left there is
    // better than throwing, because the tests drive exactly this path.
    var GAP = 30;   // clears the selection's own handles on touch
    var BUTTON_H = 34;
    var selectionTop = (rect && rect.top) || 8;
    var selectionBottom = rect && rect.bottom ? rect.bottom : selectionTop;
    // Below the selection when it fits, above only when it does not: near the bottom of
    // the viewport there is no room underneath, and above is then the lesser evil.
    var below = selectionBottom + GAP;
    var top = below + BUTTON_H <= (window.innerHeight || 600)
      ? below
      : Math.max(4, selectionTop - BUTTON_H);
    var left = Math.max(4, Math.min((window.innerWidth || 800) - 44, ((rect && rect.right) || 8) + 6));
    var button = document.createElement("button");
    button.type = "button";
    button.className = "cm-add";
    button.title = "Comment on this";
    button.setAttribute("aria-label", "Comment on the selected text");
    button.textContent = "Comment";
    button.style.position = "fixed";
    button.style.top = top + "px";
    button.style.left = left + "px";
    button.style.zIndex = "2147483647";
    // Without this the press itself collapses the selection, and the click would report nothing.
    button.addEventListener("mousedown", function (event) { event.preventDefault(); });
    button.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      hideAffordance();
      message.intent = "comment";
      parent.postMessage(message, "*");
    });
    document.body.appendChild(button);
    affordance = button;
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
    timer = setTimeout(function () {
      var built = describe();
      if (!built) {
        hideAffordance();
        // No touch message here: the clear message below already tells the page the
        // selection is gone, on every device, and the page treats it as the one place
        // that forgets a selection. A second "nothing selected" would be a second thing
        // to keep in step.
        parent.postMessage({ t: "pi-artifact-clear", file: FRAME.file }, "*");
        return;
      }
      showAffordance(built.range, built.message);
    }, 220);
  });
  document.addEventListener("scroll", hideAffordance, true);
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") hideAffordance();
  });
  // The key that does what the affordance does. Both scripts install the same handler;
  // the collaborators are what differ (this one reports line numbers, the rendered one
  // reports text and an occurrence).
  document.addEventListener(
    "keydown",
    ${commentKeyHandler.toString()}({
      isTouch: isTouch,
      ready: function () { return !!affordance; },
      hide: hideAffordance,
      describe: describe,
      post: function (message) { parent.postMessage(message, "*"); }
    })
  );

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

  ${SWIPE_SCRIPT}

  parent.postMessage({ t: "pi-artifact-ready", file: FRAME.file }, "*");
})();
`;

/**
 * Why a file could not be shown, as a page rather than a line of text.
 *
 * The drawer frames whatever this origin answers with, so a plain-text error became
 * a bare line in a blank panel with no clue what to do about it — which is exactly
 * how `unreadable: conversation/40010/01-desktop-staged.png` arrived after a file
 * was renamed. The status is still 404 (this is a failure, not a document), but the
 * body explains it in the place the reader is already looking.
 */
function unreadableDocument(key: string): string {
  return markdownDocument(
    `unreadable · ${key}`,
    `<h1>This file can no longer be read</h1>
<p class="meta">${escapeHtml(key)}</p>
<p>It was written during this conversation, but it is not on disk any more — it was
renamed or deleted afterwards. The transcript records what happened to a file, not
what is still there.</p>
<p>Use the arrow at the top of this panel to go back to the list.</p>`,
  );
}

/**
 * An image, centred on the theme's own background.
 *
 * Served as HTML around an `<img>` rather than as the bare bytes, for a reason that
 * only shows up on screen: a browser paints an image *document's* backdrop white,
 * whatever the theme, and no header changes that inside a frame — so a transparent
 * PNG arrived in a dark drawer as a white slab. A document with a stylesheet is the
 * only place the backdrop can be made to follow the theme.
 *
 * The safety rules are unchanged. Every byte of the file name that reaches the markup
 * is escaped; the `<img>` points at this same origin (the `?raw` form of the same
 * URL), never at a remote host; and the CSP allows `img-src 'self'` and nothing else,
 * so the document cannot load, fetch or run anything but the picture.
 */
function imageDocument(input: {
  key: string;
  size: number;
  truncated: boolean;
  /** Per-response, for the swipe script — the same rule as every other scripted document. */
  nonce: string;
}): string {
  // Relative to this document, not to the conversation root: the document is served
  // at `<root>/c/<id>/<key>`, so the image is its *sibling* `<key>?raw` — the full
  // key again would resolve to `<root>/c/<id>/<key>/<key>` and quietly 404. Only the
  // last segment is needed, and that is also what makes the URL work behind any
  // mount prefix without this file having to know what the prefix is.
  const href = `${encodeURIComponent(input.key.split("/").at(-1) ?? input.key)}?raw`;
  const note = input.truncated
    ? `<p class="note">Showing the first ${Math.round(input.size / 1024)} KiB of ${input.size} bytes.</p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.key)}</title>
<style>
  /* Same light/dark contract as every other document here, so the picture sits on
     the drawer's colour rather than on a white field. */
  :root { color-scheme: light dark; }
  /* Vertical pans stay the browser's — scrolling a long file is the point — but a
     the X axis is this document's. Without it a sideways drag is claimed by the
     platform (on iOS, as a back-navigation gesture) and the swipe script never sees
     an end to judge. pan-y keeps scrolling; taking x away from the browser is what
     makes a swipe mean something. */
  html { touch-action: pan-y pinch-zoom; }
  /* border-box because a padded height of 100% overflows its own viewport: the
     padding is added outside the 100%, which pushes the picture's content box past
     the bottom of the frame and makes it sit visibly too high. */
  html, body { height: 100%; box-sizing: border-box; }
  body { margin: 0; display: flex; align-items: center; justify-content: center;
         padding: 1rem; background: Canvas; color: CanvasText;
         font: 13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  /* Fitted, not stretched: a screenshot wider than the drawer is the ordinary case,
     and scaling it down to fit is what makes it readable at a glance. The height is
     capped too, so a tall one does not need a scroll to see what it is. */
  img { max-width: 100%; max-height: 100%; object-fit: contain;
        image-rendering: auto; background: #8881; border-radius: .4rem; }
  .note { position: absolute; bottom: .5rem; left: .5rem; margin: 0; opacity: .7; }
</style>
</head>
<body>
<img src="${escapeHtml(href)}" alt="${escapeHtml(input.key)}">
${note}
<script nonce="${input.nonce}">${SWIPE_SCRIPT}</script>
</body>
</html>`;
}

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
  /* Vertical pans stay the browser's — scrolling a long file is the point — but a
     the X axis is this document's. Without it a sideways drag is claimed by the
     platform (on iOS, as a back-navigation gesture) and the swipe script never sees
     an end to judge. pan-y keeps scrolling; taking x away from the browser is what
     makes a swipe mean something. */
  html { touch-action: pan-y pinch-zoom; }
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
  /* The affordance a settled selection shows: a small button beside the text, never a panel. */
  .cm-add { font: inherit; line-height: 1; padding: .3em .5em; border-radius: 6px;
            border: 1px solid #8886; background: Canvas; color: inherit; cursor: pointer;
            box-shadow: 0 1px 4px #0003; }
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
  .cm-add { font: inherit; line-height: 1; padding: .3em .5em; border-radius: 6px;
            border: 1px solid #8886; background: Canvas; color: inherit; cursor: pointer;
            box-shadow: 0 1px 4px #0003; }
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

  // An image is answered from its bytes, before anything tries to decode it as
  // text. Doing it here rather than after `readArtifact` is not an optimisation:
  // that function reports a PNG as "binary" and returns no content, so a check
  // below it would never see a picture at all.
  //
  // Two URLs, because a picture needs both:
  //
  //   `?raw`   — the bytes, with their real content type. What the document below
  //              embeds, and what ↗ in the drawer's header opens.
  //   plain    — an HTML document around those bytes, because a browser paints an
  //              image *document's* backdrop white whatever the theme. That white
  //              slab in a dark drawer is the bug this document exists to fix, and
  //              no response header reaches it.
  //
  // `?download` asks for the bytes as an attachment rather than inline.
  const imageType = imageTypeOf(key);
  if (imageType !== undefined) {
    let image;
    try {
      if (revision !== "" && revision !== "latest") {
        if (!repo) throw new Error("artifacts are not version controlled here");
        image = await readImageAtRevision(options, repo, revision, file);
      } else {
        image = readArtifactBytes(file);
      }
    } catch (error) {
      logger.error(`[artifacts] ${key}: ${(error as Error).message}`);
      send(res, 404, "text/html; charset=utf-8", documentCsp, unreadableDocument(key));
      return;
    }
    // No redaction, and there cannot be: `redact` is a text transform, and running
    // it over a PNG would corrupt it. That is a real gap and it is stated here
    // rather than hidden — an image this agent produced can contain whatever it
    // drew, and the reviewer of an image is a person looking at it.
    if (!url.searchParams.has("raw")) {
      // A nonce, because this document now carries the swipe script. The permission
      // is the narrowest that works: one script, ours, for this response only — the
      // picture's own bytes are still never parsed as anything.
      const nonce = randomBytes(16).toString("base64");
      send(
        res,
        200,
        "text/html; charset=utf-8",
        imageDocumentCsp(frameAncestorsFor(options.webOrigin), nonce),
        imageDocument({ key, size: image.size, truncated: image.size > image.bytes.length, nonce }),
      );
      return;
    }
    const filename = encodeURIComponent(key.split("/").at(-1) ?? key);
    send(res, 200, imageType, IMAGE_CSP, image.bytes, {
      "Content-Disposition": `${url.searchParams.has("download") ? "attachment" : "inline"}; filename="${filename}"`,
      // Only meaningful when this URL is opened *directly* — the ↗ tab, a saved
      // link — where the browser draws its own image viewer around it. Inside the
      // drawer the wrapper document's stylesheet is what themes the backdrop; a
      // response header does not reach an image document in a frame, which is the
      // whole reason the wrapper exists.
      "Color-Scheme": "light dark",
    });
    return;
  }

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
      const content = await showFile(repo, revision, await repoPathOrThrow(repo, file.path, file.key));
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
    send(res, 404, "text/html; charset=utf-8", documentCsp, unreadableDocument(key));
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
