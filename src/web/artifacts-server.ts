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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

import { imageTypeOf, isMarkdown, isPdf, readArtifact, readArtifactBytes, type ArtifactFile } from "../durable/artifacts.js";
import { repoRelativePath, showFile, showFileBytes } from "../durable/artifact-vcs.js";
import { parseRegion } from "../durable/comments.js";
import { logger } from "../logger.js";
import type { SessionHost } from "../session-host/api.js";
import { cropRegion } from "./crop.js";
import { pdfPageCount, renderPdfPage } from "./pdf.js";
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
    var RATIO = 1.5;         // horizontal must beat vertical by this much
    var SLOW = 800;          // longer than this is a drag, not a flick
    var start = null;
    var last = null;
    /**
     * Whether a horizontal drag is the *page's* to claim right now.
     *
     * Two things can own a horizontal movement on this surface, and only one of them can
     * have it. While a rectangle is being selected, the drag is drawing that box. While
     * the picture is zoomed in, the drag pans it. In both cases the document consumes the
     * gesture, and paging must not begin underneath it — which is what made a drag feel
     * like a coin toss between moving the picture and moving to the next artifact.
     *
     * The document is also the only party that can answer: it knows whether it is armed,
     * and only it knows how much of the picture is left to pan. So it reports both, and
     * this script simply obeys.
     */
    var pageLocked = false;
    /** Which way the document still has somewhere to go. */
    var pannable = { left: false, right: false };

    /**
     * Whether the document owns a drag whose finger moves dx pixels horizontally.
     *
     * Armed means it owns every horizontal drag: the reader is drawing a rectangle, and a
     * rectangle has no direction. Zoomed means it owns the drag only while the picture has
     * somewhere to go that way — a finger moving right scrolls the picture's content right,
     * which needs content to the left (pannable.left). When there is none the picture is
     * pinned to that edge and the gesture is the drawer's: that is the whole of the rule,
     * page only when we cannot drag any further.
     */
    function owned(dx) {
      if (!pageLocked) return false;
      // Armed: no direction, the rectangle owns it.
      if (pannable.armed) return true;
      return dx > 0 ? pannable.left : pannable.right;
    }

    window.addEventListener("message", function (event) {
      var data = event.data;
      if (!data) return;
      if (data.t !== "pi-artifact-page-locked") return;
      // Only this document's own report. A lock from anywhere else would be about another
      // frame, and obeying it would stop paging for no reason a reader could see.
      if (event.source !== window) return;
      pageLocked = data.locked === true;
      pannable = data.sides || { left: false, right: false };
    });

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
      // The document owned this gesture, so it never was a page turn. Released with
      // commit false like any other abort, because the pane may have been nudged before
      // the ownership was known.
      if (owned(dx)) return abort();
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
      // The document owns this direction, so the pane does not follow the finger at all. The
      // old slop test used to decide this by accident — the pane only moved once the drag was
      // horizontal enough — but a selection or a pan is horizontal too, so the slop cannot
      // tell them apart. The document can, and says so.
      if (owned(dx)) return;
      // Past the slop, and clearly more horizontal than vertical. Both conditions
      // have to hold before anything moves: a diagonal drag that keeps scrolling
      // must not drag the document sideways while it does.
      if (absX < 8 || absX < absY * RATIO) return;
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
      if (owned(event.deltaX)) { travel = 0; return; } // the document owns this direction
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

/**
 * Choosing part of a picture, for the image document only.
 *
 * Separate from `SWIPE_SCRIPT` and `COMMENT_SCRIPT` because it needs an `<img>` (the
 * source and rendered views have none) and because a rectangle is not a line: it is
 * the one gesture whose result the host cannot re-derive, so this computes the answer
 * itself, in the picture's own pixels, and reports it. Exported so the e2e test can
 * serve a document that really carries it.
 */
export const REGION_SCRIPT = `
  // --- Choosing part of a picture ------------------------------------------
  //
  // A picture has no lines to select, so the commentable unit is a rectangle dragged
  // over it. What the parent needs is the rectangle **in the picture's own pixels**: a
  // picture is scaled to fit the drawer, so the pixels under the finger are not the
  // pixels in the file, and a rectangle counted in screen pixels would point somewhere
  // else the moment the drawer is a different width. The scale is naturalWidth /
  // drawnWidth, and it is applied here because this document is the only party that
  // knows both numbers.
  //
  // Every message here is report-only, like the selection script: this origin cannot
  // submit anything, and the parent decides what a rectangle means.
  (function () {
    var image = document.querySelector("img.crop-target");
    if (!image) return;

    var MIN_SIDE = 8;        // a tap is not a selection (see MIN_REGION_SIDE in comments.ts)
    var drag = null;         // { x, y } where the finger went down, in client coordinates
    var marquee = null;      // the box being drawn

    /** The drag so far, in the picture's own pixels, or null when it is not a selection. */
    function regionOf(from, to) {
      var naturalWidth = image.naturalWidth || 0;
      var naturalHeight = image.naturalHeight || 0;
      var box = image.getBoundingClientRect();
      if (naturalWidth < 1 || naturalHeight < 1 || box.width < 1 || box.height < 1) return null;
      // The picture is fitted, so one scale serves both axes and the letterbox is
      // outside box — a drag starting on the empty margin is clamped to the edge
      // rather than refused, because it obviously meant the picture.
      var scaleX = naturalWidth / box.width;
      var scaleY = naturalHeight / box.height;
      var left = Math.max(0, Math.min(from.x, to.x) - box.left) * scaleX;
      var top = Math.max(0, Math.min(from.y, to.y) - box.top) * scaleY;
      var right = Math.min(box.width, Math.max(from.x, to.x) - box.left) * scaleX;
      var bottom = Math.min(box.height, Math.max(from.y, to.y) - box.top) * scaleY;
      var region = {
        x: Math.round(left),
        y: Math.round(top),
        width: Math.round(right - left),
        height: Math.round(bottom - top),
        imageWidth: naturalWidth,
        imageHeight: naturalHeight
      };
      if (region.width < MIN_SIDE || region.height < MIN_SIDE) return null;
      return region;
    }

    function clear() {
      if (marquee && marquee.parentNode) marquee.parentNode.removeChild(marquee);
      marquee = null;
      drag = null;
    }

    /**
     * Tell the drawer this document can take a rectangle.
     *
     * Sent once, when the picture has loaded. What the drawer needs is a fact about the
     * document — whether pressing the comment button should arm it — and the button is on
     * screen from the moment the document is, so a message deferred until a tap would offer
     * it late, or for documents that cannot use it.
     *
     * Nothing else travels: the picture's size is already known to the zoom, which measures
     * it in this document, and the drawer has no use for it.
     */
    function announce() {
      parent.postMessage(
        { t: "pi-artifact-image", file: document.body.getAttribute("data-file") || "" },
        "*"
      );
    }
    if (image.complete) announce();
    else image.addEventListener("load", announce, { once: true });

    // --- Zooming the picture, and nothing else --------------------------------
    //
    // The browser's own pinch-zoom is deliberately off (see the stylesheet): it scales the
    // *visual viewport*, which belongs to the top-level page, so pinching a picture zoomed
    // the drawer's header and the comment button along with it. What a reader wants is to
    // look closely at the picture, so the zoom is applied here, as a transform on the img,
    // and the frame — and everything around it — stays exactly where it is.
    //
    // Two input paths, because the devices differ:
    //   - **two pointers** (touch screens) — track distance and midpoint;
    //   - **ctrl + wheel** (trackpads and desktops) — the conventional pinch, and what a
    //     keyboard-driven magnification sends.
    //
    // Double-tap and double-click toggle a comfortable 2x, which is the gesture people
    // reach for on a phone before they reach for two fingers.

    var stage = document.querySelector(".stage");
    var MIN_ZOOM = 1;
    var MAX_ZOOM = 8;
    var zoom = 1;
    var pointers = {};      // pointerId -> {x, y}, so a pinch knows how far apart they are
    var pinch = null;       // { distance, zoom } captured when the second finger landed
    var pan = null;         // { x, y, left, top } for a one-finger drag while zoomed

    /**
     * Tell the page whether a horizontal drag is the document's, or the drawer's.
     *
     * The drawer pages between artifacts on a horizontal swipe, and this document can also
     * own a horizontal drag — drawing a rectangle when armed, panning when zoomed in. Only
     * one of the two can have it, and the document is the only party that knows which.
     *
     * "Can we drag any further" is the reader's phrasing and it is the right rule: while
     * the picture still has somewhere to pan in that direction, the drag pans it; once it
     * is against the edge, the same drag pages. That is why this is not simply "armed or
     * zoomed" — a zoomed picture scrolled to its left edge has nothing left to give.
     */
    /** Which way the picture still has somewhere to go, and whether a box is being drawn. */
    var sides = { left: false, right: false, armed: false };

    function reportPageLock() {
      var locked = armed;
      var scroller = document.scrollingElement;
      if (!locked && zoom > 1 && scroller) {
        var maxLeft = scroller.scrollWidth - scroller.clientWidth;
        // Direction matters, and this is the whole rule: "page only when we cannot drag any
        // further" means the picture keeps the gesture while there is room to move *that
        // way*. A picture scrolled hard against its right edge has nowhere to go right, so
        // dragging right is the drawer's — while dragging left still pans.
        //
        // The script reports both sides so the swipe can pick the one the finger is going.
        sides = {
          left: scroller.scrollLeft > 1,
          right: scroller.scrollLeft < maxLeft - 1,
          armed: false
        };
        locked = sides.left || sides.right;
      } else {
        // Zoomed out (or unarmed): nothing to pan, so the drawer owns horizontal drags
        // unless a rectangle is being drawn.
        sides = { left: false, right: false, armed: armed };
      }
      // Both ways round. window reaches the swipe script, a sibling IIFE in this same
      // document, so a message is how the two talk and parent alone would skip it. parent
      // reaches the drawer, which stops the strip moving even if a stale drag message is
      // already in flight.
      window.postMessage({ t: "pi-artifact-page-locked", locked: locked, sides: sides }, "*");
      parent.postMessage({ t: "pi-artifact-page-locked", locked: locked, sides: sides }, "*");
    }

    /**
     * How big the picture is at fit, before any transform.
     *
     * Measured with the transform off and remembered. Reading offsetWidth while scaled gives
     * the unscaled box, which is fine — but reading it while the *stage* has an explicit
     * width does not: the picture is a flex item with max-width 100 percent, so sizing its
     * container to the scaled picture makes it collapse to zero, and every later
     * measurement is zero too. That is the loop this avoids.
     */
    var fitted = null;

    function measureFit() {
      // Every inline size has to be released, not just the transform: applyZoom pins the
      // picture to its fitted width, so measuring while that is set would measure the pinned
      // box and call it the fit. Re-measuring then happens after a resize, which is exactly
      // when the two differ.
      var was = {
        transform: image.style.transform,
        width: image.style.width,
        height: image.style.height,
        maxWidth: image.style.maxWidth,
        maxHeight: image.style.maxHeight
      };
      image.style.transform = "";
      image.style.width = "";
      image.style.height = "";
      image.style.maxWidth = "";
      image.style.maxHeight = "";
      fitted = { width: image.offsetWidth, height: image.offsetHeight };
      image.style.transform = was.transform;
      image.style.width = was.width;
      image.style.height = was.height;
      image.style.maxWidth = was.maxWidth;
      image.style.maxHeight = was.maxHeight;
      return fitted;
    }

    function applyZoom() {
      if (stage && zoom !== 1) {
        // Pin the picture at its fitted size *before* resizing anything around it.
        //
        // This is the whole bug the first version had: the img is max-width 100 percent of
        // its container, so growing the stage to fit times zoom let the picture lay out
        // larger than fit (up to its natural size), and the transform then scaled that. The
        // stage and the picture disagreed about how big the picture was, so the scroll
        // extent was wrong and the picture could not be dragged to its edges — it ran out of
        // room before the content did.
        //
        // A fixed width in the fitted pixels makes the picture's layout box exactly what the
        // stage was sized from, and the transform becomes the only thing that changes its
        // size. That is also why the measurement is taken while this is still auto.
        var fit = fitted || measureFit();
        image.style.width = fit.width + "px";
        image.style.height = fit.height + "px";
        image.style.maxWidth = "none";
        image.style.maxHeight = "none";
        // No auto margins while zoomed. The picture's layout box stays at its fitted size and
        // the transform does the growing, so an auto margin would centre that small box in a
        // stage already sized to the scaled picture: hundreds of pixels of slack on each
        // side, which the reader can scroll into and which is not picture. Top-left
        // alignment plus a top-left transform origin makes the stage and the drawn picture
        // the same rectangle.
        image.style.margin = "0";
        image.style.transform = "scale(" + zoom + ")";
        // The stage is exactly the drawn picture, with no padding of its own: the stage's
        // box is what the browser scrolls, so any slack in it is scroll room past the
        // picture's edge — visible as a band of empty space the reader can drag into.
        var width = Math.round(fit.width * zoom);
        var height = Math.round(fit.height * zoom);
        stage.style.width = width + "px";
        stage.style.height = height + "px";
        stage.style.minWidth = width + "px";
        stage.style.minHeight = height + "px";
        stage.style.padding = "0";
      } else {
        // Back to fit: every inline size handed out above is released, so the picture is
        // laid out by the stylesheet again and the stage is the window.
        image.style.transform = "";
        image.style.width = "";
        image.style.height = "";
        image.style.maxWidth = "";
        image.style.maxHeight = "";
        image.style.margin = "";
        image.style.transformOrigin = "";
        if (stage) {
          stage.style.width = "";
          stage.style.height = "";
          stage.style.minWidth = "";
          stage.style.minHeight = "";
          stage.style.padding = "";
        }
      }
      // After a layout, not during one: the lock depends on scrollWidth, which is only
      // right once the browser has laid the new stage size out.
      requestAnimationFrame(reportPageLock);
    }

    // The fit is measured once the picture has a size of its own, and re-measured when the
    // window changes: a rotation or a drawer resize gives a different "fitted".
    function remeasure() {
      fitted = null;
      if (zoom === 1) measureFit();
    }
    if (image.complete) remeasure();
    else image.addEventListener("load", remeasure, { once: true });
    window.addEventListener("resize", remeasure);

    /**
     * Zoom about a point, so the thing under the fingers stays under them.
     *
     * Scaling about the centre is right for a slider and wrong for a pinch: the reader is
     * looking at a particular corner. The scroll position is adjusted by the ratio the
     * point moves, which is the same arithmetic a map uses.
     */
    function zoomAbout(next, clientX, clientY) {
      var clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next));
      if (clamped === zoom) return;
      var before = zoom;
      // Where the point sits relative to the scroll window, before and after scaling.
      var rect = image.getBoundingClientRect();
      var offsetX = clientX - rect.left;
      var offsetY = clientY - rect.top;
      zoom = clamped;
      applyZoom();
      var after = image.getBoundingClientRect();
      document.scrollingElement.scrollLeft += after.left + offsetX * (zoom / before) - clientX;
      document.scrollingElement.scrollTop += after.top + offsetY * (zoom / before) - clientY;
    }

    function distanceBetween(a, b) {
      return Math.hypot(a.x - b.x, a.y - b.y);
    }

    function midpointOf(a, b) {
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }

    document.addEventListener("pointerdown", function (event) {
      if (armed) return;                       // armed means selecting, not zooming
      pointers[event.pointerId] = { x: event.clientX, y: event.clientY };
      var ids = Object.keys(pointers);
      if (ids.length === 2) {
        // A second finger is a pinch. It also cancels a pan: the gesture that started as
        // one finger moving is now two fingers scaling.
        pan = null;
        pinch = { distance: distanceBetween(pointers[ids[0]], pointers[ids[1]]), zoom: zoom };
      } else if (ids.length === 1 && zoom > 1) {
        // Panning is only meaningful when zoomed in; at 1x the browser's own scrolling
        // (and the drawer's swipe) own the gesture.
        pan = { x: event.clientX, y: event.clientY,
                left: document.scrollingElement.scrollLeft, top: document.scrollingElement.scrollTop };
      }
    });

    document.addEventListener("pointermove", function (event) {
      if (!pointers[event.pointerId]) return;
      pointers[event.pointerId] = { x: event.clientX, y: event.clientY };
      if (armed) return;

      var ids = Object.keys(pointers);
      if (pinch && ids.length >= 2) {
        var distance = distanceBetween(pointers[ids[0]], pointers[ids[1]]);
        if (pinch.distance > 0) {
          var mid = midpointOf(pointers[ids[0]], pointers[ids[1]]);
          zoomAbout(pinch.zoom * (distance / pinch.distance), mid.x, mid.y);
        }
        event.preventDefault();
        return;
      }
      if (pan && ids.length === 1) {
        document.scrollingElement.scrollLeft = pan.left - (event.clientX - pan.x);
        document.scrollingElement.scrollTop = pan.top - (event.clientY - pan.y);
        event.preventDefault();
        // Reaching an edge is what hands the gesture to the drawer, so the answer changes
        // mid-gesture and has to be re-reported rather than decided at the start.
        reportPageLock();
      }
    });

    function lift(event) {
      delete pointers[event.pointerId];
      if (Object.keys(pointers).length < 2) pinch = null;
      if (Object.keys(pointers).length === 0) pan = null;
    }
    document.addEventListener("pointerup", lift);
    document.addEventListener("pointercancel", lift);

    // A trackpad's pinch arrives as ctrl+wheel, and so does a keyboard zoom. passive
    // false, because the browser's own page zoom has to be prevented for this to work.
    document.addEventListener("wheel", function (event) {
      if (armed || !event.ctrlKey) return;
      event.preventDefault();
      // A trackpad sends many small deltas and a mouse wheel sends one coarse click, so the
      // per-event factor is clamped: without it a single notch of a mouse wheel jumps
      // straight to the maximum, which reads as "zoom is broken" rather than "too fast".
      var factor = Math.exp(-event.deltaY * 0.01);
      factor = Math.max(0.7, Math.min(1.4, factor));
      zoomAbout(zoom * factor, event.clientX, event.clientY);
    }, { passive: false });

    // Double-tap or double-click: the gesture people reach for first. 1x and 2x, so it is
    // a toggle in both directions rather than a ladder nobody can get out of.
    function toggleZoom(clientX, clientY) {
      if (armed) return;
      if (zoom > 1) {
        // Back to fit, and back to the top-left: a picture reset to 1x but scrolled to
        // where it was when zoomed shows an empty corner and reads as still broken.
        zoom = MIN_ZOOM;
        applyZoom();
        document.scrollingElement.scrollLeft = 0;
        document.scrollingElement.scrollTop = 0;
        return;
      }
      zoomAbout(2, clientX, clientY);
    }
    image.addEventListener("dblclick", function (event) {
      event.preventDefault();
      toggleZoom(event.clientX, event.clientY);
    });

    /**
     * Whether a drag should draw a rectangle right now.
     *
     * The parent owns this decision — the comment button presses it — and it arrives as
     * a message, because a framed document cannot read the page that frames it. Until
     * it says so the picture belongs to the browser: panning, pinching and the drawer's
     * swipe all work, and a drag across it does nothing at all.
     */
    var armed = false;

    window.addEventListener("message", function (event) {
      var data = event.data;
      if (!data || data.t !== "pi-artifact-arm") return;
      armed = data.armed === true;
      image.classList.toggle("armed", armed);
      // The class goes on the document too: arming is about the whole page being selectable,
      // not about the picture element. See the stylesheet for why.
      document.documentElement.classList.toggle("armed", armed);
      document.body.classList.toggle("armed", armed);
      // Arming clears anything half-drawn: the state that allowed the box has changed,
      // and a box left on screen would look like a selection that no longer exists.
      if (!armed) clear();
      // Arming also gives up any gesture in progress: touch-action none is about to take
      // the touches, so a pinch under way would end mid-scale and leave the picture stuck
      // at a size nobody chose.
      pointers = {};
      pinch = null;
      pan = null;
      // Armed, a horizontal drag draws a rectangle: the drawer must not page underneath it.
      reportPageLock();
    });

    // The whole document, not just the picture: once the button has been pressed the reader
    // is choosing an area of *the page*, and a drag that begins in the margin beside a
    // letterboxed picture obviously meant the picture. Listening on the image alone left a
    // drag that started anywhere else doing nothing at all — it could not draw a rectangle,
    // and (because the page is locked while armed) it could not page either.
    document.addEventListener("pointerdown", function (event) {
      if (!armed) return;
      // Primary button or a finger; a right-click is the browser's menu.
      if (typeof event.button === "number" && event.button !== 0) return;
      // One finger only: a second is a pinch, and touch-action: none on the picture
      // means the browser will not take it back.
      if (event.pointerType === "touch" && drag) return;
      event.preventDefault();
      // Capture on the *document*, now that a drag may start anywhere: capturing on the
      // image would only work for presses it received, and would also lose a drag that
      // wandered off the picture mid-stroke.
      try {
        document.documentElement.setPointerCapture(event.pointerId);
      } catch (e) {
        // Capture is an optimisation; the handlers below work without it.
      }
      drag = { x: event.clientX, y: event.clientY };
      marquee = document.createElement("div");
      marquee.className = "marquee";
      marquee.style.left = drag.x + "px";
      marquee.style.top = drag.y + "px";
      marquee.style.width = "0px";
      marquee.style.height = "0px";
      document.body.appendChild(marquee);
    });

    document.addEventListener("pointermove", function (event) {
      if (!drag || !marquee) return;
      var left = Math.min(drag.x, event.clientX);
      var top = Math.min(drag.y, event.clientY);
      marquee.style.left = left + "px";
      marquee.style.top = top + "px";
      marquee.style.width = Math.abs(event.clientX - drag.x) + "px";
      marquee.style.height = Math.abs(event.clientY - drag.y) + "px";
    });

    /** The finger or the mouse came up: the rectangle is decided here, once. */
    function end(event) {
      if (!drag) return;
      // Nothing is sent while the box is being drawn: a message per pointermove would
      // have the drawer re-render a bar sixty times a second under the finger, and the
      // only rectangle that matters is the one the reader let go of.
      var region = regionOf(drag, { x: event.clientX, y: event.clientY });
      clear();
      // A press that ended where it began is a tap: no region, and no message — the
      // click that follows offers the hint instead.
      if (!region) return;
      parent.postMessage(
        {
          t: "pi-artifact-region",
          file: document.body.getAttribute("data-file") || "",
          // The page this rectangle is on, read from *this* document's own URL. The
          // parent cannot work it out for itself: a page turn is a navigation inside
          // this frame, so the parent's copy of the frame's address is stale, and
          // cross-origin it cannot read the real one at all.
          page: (function () {
            var found = /[?&]page=(\\d+)/.exec(location.search || "");
            var page = found ? Number(found[1]) : undefined;
            return page && page > 0 ? page : undefined;
          })(),
          region: region,
          // Where the comment box should be talked about: the reader let go here, and a
          // bar pinned to a fixed strip would be a separate place from the box they just
          // drew.
          at: { x: event.clientX, y: event.clientY },
          intent: "comment"
        },
        "*"
      );
    }

    document.addEventListener("pointerup", end);
    // A gesture the system claims (a scroll that turns into a back-swipe) ends here and
    // never at pointerup, so the box is taken down rather than left on the picture.
    document.addEventListener("pointercancel", clear);
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
 * Run `use` with a path to a PDF's bytes.
 *
 * The live file already has one. A *pinned revision* does not — its bytes came out of
 * jj — so they are written to a temporary file, because PyMuPDF opens paths rather
 * than buffers. That is the only reason this exists: keeping `?rev=` working for a PDF
 * rather than making the revision view refuse documents.
 *
 * The temporary file is removed in a `finally`, so a render that throws or times out
 * still cleans up. Its name carries the process id, so two bridges cannot collide, and
 * it lives in the OS temp directory rather than in the conversation's repository — a
 * scratch file for a render is not something to commit.
 */
async function withPdfBytes<T>(
  bytes: Buffer,
  key: string,
  use: (path: string) => Promise<T>,
  livePath?: string,
): Promise<T> {
  if (livePath !== undefined) return use(livePath);
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-pdf-"));
  const file = path.join(dir, (path.basename(key) || "document") + ".pdf");
  try {
    await fs.promises.writeFile(file, bytes);
    return await use(file);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * The paging strip under a rendered page.
 *
 * Links, not buttons: this document runs one script and that script's job is the
 * rectangle, so a page turn is an ordinary navigation of the frame — the same thing
 * clicking a link in a source view does. Both ends are drawn even at the ends of the
 * document, disabled, so the strip does not move under the pointer between pages.
 *
 * The page number is in the URL, so a reader who reloads, or who follows a link to
 * page 3, lands there.
 */
function pageControls(key: string, page: number, pageCount: number | undefined): string {
  const base = encodeURIComponent(key.split("/").at(-1) ?? key);
  const at = (n: number): string => `${base}?page=${n}`;
  const last = pageCount === undefined ? undefined : pageCount;
  const previous = page > 1 ? `<a href="${escapeHtml(at(page - 1))}" rel="prev">← page ${page - 1}</a>` : `<a aria-disabled="true">←</a>`;
  const next =
    last !== undefined && page >= last
      ? `<a aria-disabled="true">→</a>`
      : `<a href="${escapeHtml(at(page + 1))}" rel="next">page ${page + 1} →</a>`;
  return `<nav class="pages">${previous}<span>page ${page}${last === undefined ? "" : ` of ${last}`}</span>${next}</nav>`;
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
  /**
   * What `<img>` points at, **relative to this document**.
   *
   * The document is served at `<root>/c/<id>/<key>`, so a sibling is just the last path
   * segment: the full key again would resolve to `<root>/c/<id>/<key>/<key>` and quietly
   * 404. Relative also makes the URL work behind any mount prefix without this file
   * having to know what the prefix is.
   */
  href: string;
  /** A line under the picture — a truncation note, or "page 2 of 3". */
  note?: string;
  /** A second line, for the page controls a PDF needs and a PNG does not. */
  controls?: string;
  /** Per-response, for the swipe script — the same rule as every other scripted document. */
  nonce: string;
}): string {
  const note = input.note === undefined ? "" : `<p class="note">${escapeHtml(input.note)}</p>`;
  const controls = input.controls ?? "";
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
  /* No page zoom of this document, ever.
     
     Pinch-zoom here was a bug with a non-obvious cause: this document lives in an
     iframe, but a browser's pinch-zoom scales the *visual viewport*, which belongs to
     the top-level page. So pinching a picture zoomed the whole drawer — header, comment
     button, the lot — while the picture itself stayed the same size relative to its
     surroundings. The zoom has to be this document's own, applied to the picture, so
     nothing outside the frame can move.

     pan-y still lets the page scroll, and keeps the X axis for the swipe: without it a
     sideways drag is claimed by the platform (on iOS, as a back-navigation gesture) and
     the swipe script never sees an end to judge. */
  html { touch-action: pan-y; }
  /* border-box because a padded height of 100% overflows its own viewport: the
     padding is added outside the 100%, which pushes the picture's content box past
     the bottom of the frame and makes it sit visibly too high. */
  html, body { height: 100%; box-sizing: border-box; }
  /* The scrolling window. Its own overflow means a zoomed picture can be panned to its
     edges, and overscroll-behavior contain stops that pan continuing into the drawer
     behind it once an edge is reached. */
  body { margin: 0; height: 100%; overflow: auto; overscroll-behavior: contain;
         background: Canvas; color: CanvasText;
         font: 13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  /* A centring box, so a picture smaller than the window sits in the middle and a zoomed
     one can still be scrolled from its top-left. min-width and min-height rather than
     height, so it grows with the picture instead of clipping it.
     
     Centring is why the safe keyword matters. Plain center puts equal space on both sides of
     an item bigger than its container, and the overflow on the start side cannot be
     scrolled to: a flex container's scrollable area begins at its own origin, not at the
     child's. That is exactly the reported symptom — zoomed in, the top and left could never
     be reached. Safe center falls back to start alignment once the item no longer fits, so
     there is no space beyond the origin to lose. */
  .stage { min-width: 100%; min-height: 100%; display: flex;
           padding: 1rem; box-sizing: border-box; }
  /* Centred by margin auto rather than by justify-content, and the difference is not
     stylistic: a flex container's scrollable area begins at its own origin, so an item
     larger than the container with justify-content center overflows the start side into
     space that cannot be scrolled to. That is the reported bug — zoomed in, the top and left
     could never be reached. An auto margin gives way instead, collapsing to zero once the
     item no longer fits, so nothing ever sits outside the origin. */
  .stage > img { margin: auto; }
  /* Fitted, not stretched: a screenshot wider than the drawer is the ordinary case,
     and scaling it down to fit is what makes it readable at a glance. The height is
     capped too, so a tall one does not need a scroll to see what it is.
     
     A scale transform with a centre origin is how the zoom is applied: the layout size
     never changes, so the scroll extent has to be given to the stage by the script, and
     will-change keeps the gesture off the compositor's slow path. */
  img { max-width: 100%; max-height: 100%; object-fit: contain;
        image-rendering: auto; background: #8881; border-radius: .4rem;
        transform-origin: top left; will-change: transform; }
  /* The picture is *not* the gesture surface until somebody says they are commenting.
     Taking every touch away from the browser is what makes a rectangle possible on a
     phone, and it is also what made panning and pinching impossible: one finger cannot
     mean both "select" and "pan", and a pinched page that cannot be zoomed is a page
     that cannot be read. So the arming decides. Unarmed, the picture behaves like a
     picture — pan, pinch-zoom, double-tap — and the drawer's own gestures (swipe to
     page, scroll) work as they always did.

     Armed, the browser is told to keep its hands off: touch-action none hands every
     touch to the region script, and the cursor says what a drag will do. */
  img { touch-action: auto; }
  /* Armed, the *whole document* is the gesture surface, not just the picture.
     
     Taking touches only from the img left a drag that began in the margin beside a
     letterboxed picture owned by nobody: it could not draw a rectangle (the image never saw
     the pointerdown) and it could not page (the drawer had been told the document owns
     horizontal drags). Nothing happened at all, which is the worst of the three answers. */
  html.armed, body.armed { touch-action: none; }
  body.armed { cursor: crosshair; }
  html.armed img, img.crop-target.armed { touch-action: none; cursor: crosshair; user-select: none;
        -webkit-user-select: none; -webkit-user-drag: none; }
  /* The rectangle being dragged. Fixed, because the script works in client
     coordinates; pointer-events: none, because the box sits under the finger that is
     drawing it and would otherwise steal its own pointermove. */
  .marquee { position: fixed; z-index: 2147483647; pointer-events: none;
        border: 2px solid #4c9aff; background: #4c9aff33; border-radius: 2px;
        box-shadow: 0 0 0 1px #0006 inset; }
  .note { position: absolute; bottom: .5rem; left: .5rem; margin: 0; opacity: .7; }
  /* Page controls, for a document that has pages. A fixed strip at the foot rather
     than something over the picture: it must not cover the part being read, and it
     must not sit under the finger that is dragging a rectangle. */
  .pages { position: fixed; bottom: 0; left: 0; right: 0; display: flex; gap: .5rem;
        align-items: center; justify-content: center; padding: .35rem .5rem;
        background: Canvas; border-top: 1px solid #8886; font-size: 12px; }
  .pages a, .pages span { padding: .2rem .5rem; border-radius: .3rem; text-decoration: none;
        color: CanvasText; }
  .pages a { background: #8882; }
  .pages a[aria-disabled="true"] { opacity: .35; pointer-events: none; }
  /* Clear of the strip above, so the last line of a page is not hidden behind it. */
  body:has(.pages) { padding-bottom: 3rem; }
</style>
</head>
<body data-file="${escapeHtml(input.key)}">
${controls}
<div class="stage"><img class="crop-target" src="${escapeHtml(input.href)}" alt="${escapeHtml(input.key)}" draggable="false"></div>
${note}
<script nonce="${input.nonce}">${SWIPE_SCRIPT}</script>
<script nonce="${input.nonce}">${REGION_SCRIPT}</script>
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

  // A PDF is a document with pages, and a page has to be rasterised before it can be
  // drawn or commented on. It is answered here, before anything tries to read the file
  // as text: `readArtifact` reports a PDF as "binary" and returns no content, so a
  // check below it would never see one at all.
  //
  // Three URLs, and each means something different to a reader:
  //
  //   plain        — a document around page 1 (or `?page=N`), with paging controls.
  //                  What the drawer frames, and what drag-to-comment works over.
  //   `?page=N`    — the same document, at that page.
  //   `?raw`       — the PDF's own bytes, so ↗ opens the browser's real viewer, with
  //                  text selection, links and zoom. A rasterised page is for reviewing;
  //                  the PDF itself is for reading.
  //
  // `?page=N&raw=1` (or `?png`) answers the rendered page *as a PNG*, which is what the
  // region crop and the comment preview need — a crop of a page is a crop of a picture.
  if (isPdf(key)) {
    let bytes: Buffer;
    try {
      if (revision !== "" && revision !== "latest") {
        if (!repo) throw new Error("artifacts are not version controlled here");
        bytes = await showFileBytes(repo, revision, await repoPathOrThrow(repo, file.path, file.key));
      } else {
        bytes = readArtifactBytes(file).bytes;
      }
    } catch (error) {
      logger.error(`[artifacts] ${key}: ${(error as Error).message}`);
      send(res, 404, "text/html; charset=utf-8", documentCsp, unreadableDocument(key));
      return;
    }

    const raw = url.searchParams.has("raw");
    // Which of the three answers this is. `?region=` counts as an image request on its
    // own: the crop is cut from a rendered page, so it needs the render either way.
    const wantsRegion = url.searchParams.has("region");
    const wantsPageImage = wantsRegion || (url.searchParams.has("page") && (raw || url.searchParams.has("png")));

    if (raw && !wantsPageImage) {
      // The file itself. `application/pdf` inline is what makes ↗ a PDF tab rather than
      // a download, and it is the one content type here that the browser parses as a
      // document — which is safe only because it is *the browser's* PDF viewer, in its
      // own tab, not this origin's frame. The frame never asks for this URL.
      const filename = encodeURIComponent(key.split("/").at(-1) ?? key);
      send(res, 200, "application/pdf", IMAGE_CSP, bytes, {
        "Content-Disposition": `${url.searchParams.has("download") ? "attachment" : "inline"}; filename="${filename}"`,
        "Color-Scheme": "light dark",
      });
      return;
    }

    // No page named is page 1: the drawer asks for the first page of a document it has
    // not counted yet. A page that *is* named and is not a positive number is the
    // request being wrong, and is refused rather than quietly turned into page 1 —
    // `?page=0` must not show the first page as if nothing had happened.
    const asked = url.searchParams.get("page");
    const requested = asked === null ? 1 : Number.parseInt(asked, 10);
    if (!Number.isFinite(requested) || requested < 1) {
      send(res, 404, "text/plain; charset=utf-8", TEXT_CSP, `no page ${asked} in ${key}`);
      return;
    }
    // Past the end is answered by the renderer, which is the only party that knows how
    // many pages there are.
    const page = requested;

    // Rendering needs bytes on disk. The live file is already there; a *pinned
    // revision* is not, so its bytes go to a temporary file first. That is the only way
    // to keep `?rev=` working for a PDF, and the alternative — refusing a revision —
    // would make the two views of a document disagree about what they can show.
    const pinned = revision !== "" && revision !== "latest";
    const livePath = pinned ? undefined : file.path;
    const rendered = await withPdfBytes(bytes, key, (at) => renderPdfPage(at, page), livePath);
    if (rendered === undefined) {
      send(
        res,
        404,
        "text/plain; charset=utf-8",
        TEXT_CSP,
        `cannot render ${key} page ${page}; the document may be damaged, or page ${page} may not exist`,
      );
      return;
    }

    // A region of a page is a region of the *picture* the page renders as, so the crop
    // is the same code the image path uses — the rectangle is already in the rendered
    // page's pixels, because that is the picture the reader dragged over.
    if (wantsRegion) {
      const rectangle = parseRegion(url.searchParams.get("region") ?? "");
      const cropped = rectangle === undefined ? undefined : cropRegion(rendered.bytes, "image/png", rectangle);
      if (cropped === undefined) {
        send(res, 404, "text/plain; charset=utf-8", TEXT_CSP, `cannot crop ${key} page ${page} at that region`);
        return;
      }
      send(res, 200, cropped.mimeType, IMAGE_CSP, cropped.bytes, {
        "Content-Disposition": 'inline; filename="region.png"',
        "Color-Scheme": "light dark",
      });
      return;
    }

    if (wantsPageImage) {
      send(res, 200, "image/png", IMAGE_CSP, rendered.bytes, {
        "Content-Disposition": `inline; filename="page-${page}.png"`,
        "Color-Scheme": "light dark",
      });
      return;
    }

    const pageCount = await withPdfBytes(bytes, key, (at) => pdfPageCount(at), livePath);
    const nonce = randomBytes(16).toString("base64");
    send(
      res,
      200,
      "text/html; charset=utf-8",
      imageDocumentCsp(frameAncestorsFor(options.webOrigin), nonce),
      imageDocument({
        key,
        // The page as a PNG is a *sibling* URL: `?page=N&png`. Relative, for the same
        // reason the image's `?raw` is.
        href: `${encodeURIComponent(key.split("/").at(-1) ?? key)}?page=${page}&png`,
        ...(pageCount === undefined ? {} : { note: `page ${page} of ${pageCount}` }),
        controls: pageControls(key, page, pageCount),
        nonce,
      }),
    );
    return;
  }

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
    //
    // The *region* the reader dragged over, cut out of the same bytes. This lives on
    // the artifact origin and not on the API host because the bytes are already here:
    // fetching them again through `?raw` would be a second read of a file the
    // allow-list has already approved, and it would have to be fetched as base64 over
    // the session API to be cropped anywhere else. The rectangle is clamped here as
    // well as in `normalizeRegion` — two independent checks, because this is the one
    // that would index past the end of a decoded picture.
    if (url.searchParams.has("region")) {
      const asked = parseRegion(url.searchParams.get("region") ?? "");
      const cropped = asked === undefined ? undefined : cropRegion(image.bytes, imageType, asked);
      if (cropped === undefined) {
        send(res, 404, "text/plain; charset=utf-8", TEXT_CSP, `cannot crop ${key} at that region`);
        return;
      }
      send(res, 200, cropped.mimeType, IMAGE_CSP, cropped.bytes, {
        "Content-Disposition": "inline; filename=\"region.png\"",
        "Color-Scheme": "light dark",
      });
      return;
    }
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
        imageDocument({
          key,
          // Relative to this document: the last segment plus `?raw`, which is the
          // sibling bytes of the same artifact.
          href: `${encodeURIComponent(key.split("/").at(-1) ?? key)}?raw`,
          ...(image.size > image.bytes.length
            ? { note: `Showing the first ${Math.round(image.size / 1024)} KiB of ${image.size} bytes.` }
            : {}),
          nonce,
        }),
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
