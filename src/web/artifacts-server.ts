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

import { audioTypeOf, imageTypeOf, isMarkdown, isPdf, readArtifact, readArtifactBytes, type ArtifactFile } from "../durable/artifacts.js";
import { repoRelativePath, showFile, showFileBytes } from "../durable/artifact-vcs.js";
import { APP_MANIFEST, appDirOf, appFileType, appsIn, resolveAppFile, type AppEntry } from "../durable/apps.js";
import { parseRegion } from "../durable/comments.js";
import { logger } from "../logger.js";
import type { SessionHost } from "../session-host/api.js";
import { cropRegion } from "./crop.js";
import { pdfPageCount, renderPdfPage } from "./pdf.js";
import { COMMENT_SCRIPT, MEDIA_PLAYER_SCRIPT, REGION_SCRIPT, RENDER_SCRIPT, SWIPE_SCRIPT } from "./client-scripts.js";

/**
 * Re-exported for the tests that serve a document carrying a real gesture.
 *
 * The scripts live in `client-scripts.ts` now — as `.js` files rather than template literals,
 * which is what stopped the escaping bugs. They are named here because this is the module
 * that splices them into documents, so it is the one a test is describing when it says "the
 * document really carries the swipe script".
 */
export { COMMENT_SCRIPT, MEDIA_PLAYER_SCRIPT, REGION_SCRIPT, RENDER_SCRIPT, SWIPE_SCRIPT };
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
  /**
   * The directory holding a conversation's own files, if this deployment has one.
   *
   * Separate from `repoFor` on purpose: that one answers "where is the jj repository",
   * which happens to be the same directory today but is a different question. An app is
   * a directory of files, and serving one needs the second answer and not the first.
   *
   * Absent, `/apps/...` explains that this deployment hosts no apps rather than 404ing as
   * if the app were missing.
   */
  conversationDirFor?: (conversationId: number) => string | undefined;
  /**
   * Told when an app leaves a report.
   *
   * The artifact origin deliberately knows nothing about turns: it stores a file and says
   * where. Whether that should interrupt somebody is a policy question, and policy belongs
   * where the conversation lives (see `durable/main.ts`), not in a file server.
   */
  onReport?: (report: {
    conversationId: number;
    appName: string;
    /** Absolute path of the stored file, so the caller can read it. */
    file: string;
    bytes: number;
  }) => void | Promise<void>;
}

/** Headers shared by every response: no sniffing, no caching, no framing by others. */
const BASE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Opener-Policy": "same-origin",
  // Everything this origin serves is meant to be embedded by this deployment's own UI, and the
  // chat page is cross-origin isolated (the speech apps need `SharedArrayBuffer`). Under
  // `COEP: require-corp` a cross-origin subresource without this header is *refused*, so without
  // it the comment composer's crop preview and every artifact image would stop loading — a
  // failure three steps away from the header that caused it.
  "Cross-Origin-Resource-Policy": "cross-origin",
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

/**
 * The CSP for the audio player document.
 *
 * `media-src 'self'` is the one allowance, and it is deliberately the narrowest that
 * works: the player embeds an `<audio>` pointing at this same origin's bytes and
 * nothing else. It cannot be folded into `scriptedDocumentCsp`, whose `img-src data:`
 * allowance is for a different document — widening the shared policy would give every
 * scripted document a fetch that only this one needs.
 *
 * `default-src 'none'` still covers fetch, frames and images, so the player cannot
 * become a page; the script is nonce'd and can talk to its parent and nothing else.
 * No `connect-src`: the script never fetches, it only drives the element.
 */
function mediaDocumentCsp(frameAncestors: string, nonce: string): string {
  return (
    `sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'; ` +
    `media-src 'self'; script-src 'nonce-${nonce}'; ` +
    `form-action 'none'; base-uri 'none'; frame-ancestors ${frameAncestors}`
  );
}

function mediaRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | "unsatisfiable" | undefined {
  // No header is the whole file: the ordinary first request from a player, and what a
  // download link gets.
  if (header === undefined) return undefined;
  const match = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*(?:,.*)?$/i.exec(header);
  if (!match) return undefined;
  const [, rawStart = "", rawEnd = ""] = match;
  // A multi-range request (`bytes=0-1,5-6`) falls back to the whole file rather than
  // answering 416: browsers do not send one for media, and a `multipart/byteranges`
  // reply is a lot of machinery to carry for a case nothing asks for.
  if (rawStart === "" && rawEnd === "") return undefined;
  let start: number;
  let end: number;
  if (rawStart === "") {
    // `bytes=-500`: the *last* 500 bytes. A player asks this to find a file's tail.
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    // An open-ended range is the ordinary seeking request: from here to the end.
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
    // A range past the end is not a failure of the request, it is a failure of the
    // ask — the player has a stale idea of the length. 416 is the honest answer and
    // tells it to re-read `Content-Range`.
    if (start >= size) return "unsatisfiable";
    if (end >= size) end = size - 1;
    if (end < start) return undefined;
  }
  if (size === 0) return "unsatisfiable";
  return { start, end };
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

/**
 * A key spelled relative to the conversation's own artifact directory.
 *
 * The stored key is relative to the artifacts *root*, which is what makes it
 * stable across revisions and identical for the origin, the pins and a comment
 * anchor (see `ArtifactFile.key`). That spelling leaks the deployment's layout
 * into every URL — `conversation/73131/notes.md` — so the same id appeared twice
 * in a link. Nothing about the key should change, so the short form is resolved
 * here instead: prefix the conversation's directory and match the result against
 * the derived list.
 *
 * Matched against the list rather than concatenated into a path, so this is an
 * alias lookup and not a second way to reach the filesystem: a `..` in the short
 * form simply fails to match anything. `undefined` when the conversation's
 * directory is not a prefix of any key, which is how a deployment whose keys are
 * already short (`notes.md`) keeps working unchanged.
 */
function findShortKey(
  files: readonly ArtifactFile[],
  conversationId: number,
  short: string,
): ArtifactFile | undefined {
  const prefix = `conversation/${conversationId}/`;
  // The short form must not escape its own conversation: resolve it the same way
  // a key is compared, and let a literal `../` match nothing.
  const normalised = path.posix.normalize(short);
  if (normalised.startsWith("../") || normalised === "..") return undefined;
  return files.find((candidate) => candidate.key === `${prefix}${normalised}`);
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
export function pageControls(key: string, page: number, pageCount: number | undefined): string {
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
export function imageDocument(input: {
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
 * A player for an audio artifact.
 *
 * Served as HTML around an `<audio>` rather than as the bare bytes, for two reasons
 * that both only show up on screen. A raw audio document in a frame gets the browser's
 * native controls, which are drawn by the *browser* and follow its theme rather than
 * this page's, so a dark drawer can get a light control strip. And the native element
 * cannot show a category of thing this drawer has — a file whose length is known
 * before it is read, a drag-to-seek bar sized to the container, an elapsed/total
 * readout, and a keyboard surface that matches the comment viewer's keys.
 *
 * The player is deliberately built out of `<audio>` plus our own controls rather than
 * a custom decoder: `preload="metadata"` means the browser fetches only the header
 * until somebody presses play, and `?raw` answers `Range` requests so a seek is a
 * small fetch rather than the whole file again.
 *
 * The safety rules are the image document's, unchanged. The key is escaped wherever it
 * reaches markup; the `<audio>` points at this same origin and nothing else; and the
 * CSP allows `media-src 'self'` with a nonce'd script and no `connect-src`, so the
 * document can read the file it was made for and talk to its parent, and nothing more.
 */
export function audioDocument(input: {
  key: string;
  /**
   * What `<audio>` points at, **relative to this document** — the same rule as
   * `imageDocument.href`, and for the same reason: the document is served at
   * `<root>/c/<id>/<key>`, so a sibling is just the last path segment, and a full
   * key would resolve to `<root>/c/<id>/<key>/<key>` and 404.
   */
  href: string;
  /** The content type the bytes will arrive as, so the player can name the format. */
  type: string;
  /** A line under the player — a truncation note. */
  note?: string;
  /** Per-response, for the player script — the same rule as every other scripted document. */
  nonce: string;
}): string {
  const note = input.note === undefined ? "" : `<p class="note">${escapeHtml(input.note)}</p>`;
  // The format, said plainly. `audio/wav` in a panel is jargon; "WAV" is a word.
  const format = input.type.replace(/^audio\//, "").replace("mpeg", "mp3").toUpperCase();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.key)}</title>
<style>
  :root { color-scheme: light dark; }
  /* pan-y, like the image document: the page may still scroll, and a sideways drag
     belongs to the drawer's swipe rather than to the scrubber. */
  html { touch-action: pan-y; }
  html, body { height: 100%; box-sizing: border-box; }
  body { margin: 0; height: 100%; overflow: auto; overscroll-behavior: contain;
         background: Canvas; color: CanvasText;
         font: 13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
         display: flex; flex-direction: column; justify-content: center;
         padding: 1rem; gap: .75rem; }
  /* The player is a card, not a full-bleed bar: it sits in the middle of the panel
     like a picture does, so it reads as the artifact rather than as chrome. */
  .player { border: 1px solid #8883; border-radius: .6rem; padding: .85rem .9rem;
            background: #8881; display: flex; flex-direction: column; gap: .6rem; }
  .row { display: flex; align-items: center; gap: .7rem; }
  /* The play/pause button. Sized generously: it is the one control a person reaches
     for, and it is also the tap target on a phone. */
  button.play { flex: none; width: 2.6rem; height: 2.6rem; border-radius: 999px;
                border: 1px solid #8886; background: Canvas; color: inherit; cursor: pointer;
                display: grid; place-items: center; padding: 0; }
  button.play:hover { background: #8882; }
  button.play:focus-visible { outline: 2px solid #a51f34; outline-offset: 2px; }
  button.play svg { width: 1.1rem; height: 1.1rem; fill: currentColor; }
  /* The pause bars are hidden while paused and the play triangle while playing, so the
     button is one element rather than two that have to be kept in step. */
  button.play[data-playing="1"] .icon-play { display: none; }
  button.play[data-playing="0"] .icon-pause { display: none; }
  .scrub { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: .25rem; }
  /* The progress bar is a native range input, made to look like a scrubber.
     
     A plain input type=range rather than a div with pointer handlers, because it brings
     keyboard seeking, screen-reader announcement and drag semantics that otherwise have
     to be rebuilt badly. Only its appearance is replaced. */
  input.seek { -webkit-appearance: none; appearance: none; width: 100%; height: 1.1rem;
               margin: 0; background: transparent; cursor: pointer; }
  input.seek:focus-visible { outline: 2px solid #a51f34; outline-offset: 2px; border-radius: 999px; }
  /* The filled part is a gradient stop at a CSS variable the script moves, so a drag
     repaints nothing but that one value. */
  input.seek::-webkit-slider-runnable-track { height: .35rem; border-radius: 999px;
    background: linear-gradient(to right, #a51f34 var(--p, 0%), #8883 var(--p, 0%)); }
  input.seek::-moz-range-track { height: .35rem; border-radius: 999px; background: #8883; }
  input.seek::-moz-range-progress { height: .35rem; border-radius: 999px; background: #a51f34; }
  input.seek::-webkit-slider-thumb { -webkit-appearance: none; appearance: none;
    width: .9rem; height: .9rem; margin-top: -.27rem; border-radius: 999px;
    background: CanvasText; border: 1px solid Canvas; box-shadow: 0 1px 3px #0004; }
  input.seek::-moz-range-thumb { width: .9rem; height: .9rem; border-radius: 999px;
    background: CanvasText; border: 1px solid Canvas; box-shadow: 0 1px 3px #0004; }
  /* Elapsed and total, monospaced so the digits do not shuffle sideways as they count. */
  .times { display: flex; justify-content: space-between;
           font: .75rem/1 var(--mono, ui-monospace, monospace); opacity: .75; }
  .meta { display: flex; justify-content: space-between; align-items: baseline;
          gap: .5rem; font-size: .75rem; opacity: .65; }
  .meta .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta .fmt { flex: none; }
  .note { margin: 0; font-size: .75rem; opacity: .7; }
  /* The audio element is the engine and never the interface: it is not shown, so a
     browser that draws its own controls cannot disagree with ours. It still has to be
     in the document, and not display: none, for play() to be allowed at all. */
  audio { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
</style>
</head>
<body data-file="${escapeHtml(input.key)}">
<div class="player">
  <div class="meta"><span class="name">${escapeHtml(input.key.split("/").at(-1) ?? input.key)}</span><span class="fmt">${escapeHtml(format)}</span></div>
  <div class="row">
    <button class="play" type="button" data-playing="0" aria-label="Play" title="Play (space)">
      <svg class="icon-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
      <svg class="icon-pause" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>
    </button>
    <div class="scrub">
      <input class="seek" type="range" min="0" max="1000" value="0" step="1" aria-label="Seek">
      <div class="times"><span class="elapsed">0:00</span><span class="total">--:--</span></div>
    </div>
  </div>
</div>
${note}
<audio preload="metadata" src="${escapeHtml(input.href)}"></audio>
<script nonce="${input.nonce}">
${MEDIA_PLAYER_SCRIPT}
</script>
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

/**
 * The CSP for an app page.
 *
 * Apps are the one surface here that deliberately runs author-written code, so this is
 * permissive in a way every other policy in this file is not. It is still a policy rather
 * than nothing, and it is worth saying what each allowance buys:
 *
 * `'wasm-unsafe-eval'` is not optional — without it `WebAssembly.instantiate` is blocked
 * outright, and a bundled WASM app is a blank page with a console error.
 *
 * `'unsafe-inline'` is deliberate and is *not* the weakening it looks like. An inline
 * `<script>` is how a hand-written single-file app is built, and a static file host has no
 * nonce to give one: the first version of this policy without it produced a page that
 * loaded and did nothing, with the reason only in the console. The allowance that matters
 * is still enforced — `'self'` means no remote script can be loaded, which is what stops
 * a page behind Access from pulling in someone else's code.
 *
 * `worker-src blob:` because a bundler that ships its worker as a blob is ordinary, and
 * `media-src blob:` because an app that generates audio plays it from an object URL.
 * `connect-src https:` rather than `*`: an app may fetch a model from a CDN, and must not
 * be able to reach plaintext origins or the local network from a page behind Access.
 *
 * There is no `sandbox`, unlike every other document in this file, and that is the whole
 * point of an app.
 */
function appCsp(frameAncestors: string): string {
  return (
    `default-src 'self'; ` +
    `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; ` +
    `worker-src 'self' blob:; ` +
    `style-src 'self' 'unsafe-inline'; ` +
    `img-src 'self' data: blob:; ` +
    `media-src 'self' data: blob:; ` +
    `connect-src 'self' https: data: blob:; ` +
    `frame-ancestors ${frameAncestors}`
  );
}

/**
 * Headers every app response carries, on top of the shared ones.
 *
 * `Cross-Origin-Embedder-Policy: require-corp` is the load-bearing one and the reason this
 * is not just `BASE_HEADERS`. A page can only use `SharedArrayBuffer` when it is
 * cross-origin isolated, and isolation requires COOP *and* COEP. A pthread-built WASM
 * bundle asks for `SharedArrayBuffer` during startup; without these it does not fail — it
 * waits, forever, with no error, which is the worst possible failure and cost real time to
 * diagnose.
 *
 * `Cross-Origin-Resource-Policy: cross-origin` lets the same files be fetched from another
 * origin of ours (the web app), which is what a future in-drawer app frame would need.
 * `Accept-Ranges` is not set: these are small assets, and range support is the audio
 * player's concern, not an app directory's.
 */
const APP_HEADERS: Record<string, string> = {
  ...BASE_HEADERS,
  // An app's assets are immutable within a turn and small, but `no-store` above is wrong
  // here: a 6 MB wasm bundle re-downloaded on every reload is the difference between a
  // usable page and an unusable one. `no-cache` still revalidates.
  "Cache-Control": "no-cache",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "cross-origin",
};

/**
 * The list of apps a conversation has published.
 *
 * Inert HTML under the sandboxed document policy, like the artifact index: it is the
 * bridge's own markup, and nothing about a listing needs a script. The app itself is one
 * click away and is where the code runs.
 */
function appIndexPage(conversationId: number, apps: readonly AppEntry[]): string {
  const rows = apps
    .map((app) => {
      const href = `/apps/${conversationId}/${encodeURIComponent(app.id)}/`;
      const description = app.description === "" ? "" : `<br><small>${escapeHtml(app.description)}</small>`;
      return `<li><a href="${escapeHtml(href)}">${escapeHtml(app.name)}</a>${description}</li>`;
    })
    .join("\n");
  const body =
    apps.length === 0
      ? `<p>No apps in this conversation.</p>
<p class="meta">A directory becomes an app when it contains <code>${APP_MANIFEST}</code>.</p>`
      : `<ul class="files">\n${rows}\n</ul>`;
  return markdownDocument(
    `apps \u00b7 conversation ${conversationId}`,
    `<h1>Apps</h1>
<p class="meta">Conversation ${conversationId} \u00b7 ${apps.length} app${apps.length === 1 ? "" : "s"}</p>
${body}`,
  );
}

/**
 * Serve an app, or the index of a conversation's apps.
 *
 * Three shapes, and the trailing slash matters only to a reader:
 *
 *   `/apps/<id>/`             — the apps this conversation published
 *   `/apps/<id>/<name>/`      — that app's `index.html`
 *   `/apps/<id>/<name>/<file>`— one file of it
 *
 * The index is inert HTML under the same sandboxed policy as every other document here,
 * because it is ours. The files are the app's, and are served as they are.
 */
async function serveApp(
  options: ArtifactsServerOptions,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  parts: readonly string[],
): Promise<void> {
  const conversationDirFor = options.conversationDirFor;
  if (conversationDirFor === undefined) {
    send(res, 404, "text/plain; charset=utf-8", TEXT_CSP, "this deployment does not host apps");
    return;
  }

  const [rawId, appName, ...rest] = parts;
  const conversationId = rawId === undefined ? Number.NaN : Number(rawId);
  if (!Number.isInteger(conversationId) || conversationId < 1) {
    send(res, 404, "text/plain; charset=utf-8", TEXT_CSP, "apps are addressed by conversation: /apps/<id>/");
    return;
  }

  const conversationDir = conversationDirFor(conversationId);
  if (conversationDir === undefined) {
    send(res, 404, "text/plain; charset=utf-8", TEXT_CSP, `no such conversation: ${conversationId}`);
    return;
  }

  if (appName === undefined) {
    const apps = appsIn(conversationDir);
    send(res, 200, "text/html; charset=utf-8", documentCspFor(options.webOrigin), appIndexPage(conversationId, apps));
    return;
  }

  const appDir = appDirOf(conversationDir, appName);
  if (appDir === undefined) {
    send(
      res,
      404,
      "text/plain; charset=utf-8",
      TEXT_CSP,
      `not an app of conversation ${conversationId}: ${appName} (a directory becomes an app when it holds ${APP_MANIFEST})`,
    );
    return;
  }

  // A directory URL or the app root serves its index. Done here rather than with a
  // redirect so that a relative `<script src="app.js">` resolves against the same
  // directory whether or not the visitor typed the trailing slash.
  const wanted = rest.length === 0 ? "index.html" : rest.join("/");
  const file = resolveAppFile(appDir, wanted);
  if (file === undefined) {
    send(res, 404, "text/plain; charset=utf-8", TEXT_CSP, `no such file in app ${appName}: ${wanted}`);
    return;
  }

  let body: Buffer;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
    body = fs.readFileSync(file);
  } catch (error) {
    logger.error(`[apps] ${appName}/${wanted}: ${(error as Error).message}`);
    send(res, 404, "text/plain; charset=utf-8", TEXT_CSP, `cannot read ${appName}/${wanted}`);
    return;
  }

  // A validator, because `Cache-Control: no-cache` is not sufficient without one.
  //
  // `no-cache` means "revalidate before use", and revalidation needs something to revalidate
  // *against*. With no `ETag` and no `Last-Modified`, browsers fall back to heuristic
  // freshness and can serve a stale module — which is exactly what happened: a fixed
  // `diagnostics.js` kept running from cache and threw at a line that no longer existed.
  // Size plus mtime is free, changes whenever the file does, and makes the 304 cheap enough
  // that a development loop can poll without caring.
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const headers = { ...APP_HEADERS, ETag: etag };
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  send(res, 200, appFileType(file), appCsp(frameAncestorsFor(options.webOrigin)), body, headers);
}

/**
 * The largest report the bridge will store.
 *
 * 8 MiB, raised from 256 KiB. The old figure was sized for a log and nothing else; a report that
 * carries the audio a transcription was given needs room for it, and 30 s of 16 kHz 16-bit audio is
 * ~1.2 MiB once base64-encoded. Downsampling to fit 256 KiB was tried and was the wrong trade: it
 * made the one artifact you would use to debug a bad transcription a lossy copy of the audio that
 * caused it.
 *
 * Still a bound rather than an absence of one. The point is unchanged -- a runaway client cannot
 * fill the disk a request at a time -- and it is refused rather than truncated, because half a
 * report is a report that lies.
 */
export const MAX_REPORT_BYTES = 8 * 1024 * 1024;

/**
 * Store a report an app sends about itself.
 *
 * The only write this origin accepts, and it exists because the interesting failures happen
 * in a browser the developer cannot open: a GPU abort leaves its evidence in a console that
 * nobody is watching. An app that can say "here is what happened" turns that into a file
 * somebody can read.
 *
 * Deliberately narrow, because this origin is otherwise GET-only by design:
 *
 * - The **filename is generated here**, never taken from the request, so there is no path to
 *   traverse even in principle.
 * - The **body is capped** and refused rather than truncated, so a runaway client cannot fill
 *   the disk one request at a time.
 * - The report lands **inside the app's own directory**, under `reports/`, which is where the
 *   person debugging it is already looking.
 * - Only a directory that is already an app can be written to, so the marker file is still
 *   the thing that grants the capability.
 *
 * It answers 204 with no body: there is nothing useful to say back, and an app posting
 * diagnostics should not have to parse a response.
 */
async function receiveReport(
  options: ArtifactsServerOptions,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  conversationId: number,
  appName: string,
): Promise<void> {
  const conversationDir = options.conversationDirFor?.(conversationId);
  if (conversationDir === undefined) {
    send(res, 404, "text/plain; charset=utf-8", TEXT_CSP, `no such conversation: ${conversationId}`);
    return;
  }
  const appDir = appDirOf(conversationDir, appName);
  if (appDir === undefined) {
    send(res, 404, "text/plain; charset=utf-8", TEXT_CSP, `not an app: ${appName}`);
    return;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_REPORT_BYTES) {
      // Refused, not truncated: half a report is a report that lies.
      send(res, 413, "text/plain; charset=utf-8", TEXT_CSP, `report larger than ${MAX_REPORT_BYTES} bytes`);
      return;
    }
    chunks.push(chunk as Buffer);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `${stamp}-${randomBytes(3).toString("hex")}.json`;
  const dir = path.join(appDir, "reports");
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), Buffer.concat(chunks));
  } catch (error) {
    logger.error(`[apps] report ${appName}: ${(error as Error).message}`);
    send(res, 500, "text/plain; charset=utf-8", TEXT_CSP, "could not store the report");
    return;
  }
  logger.info(`[apps] ${appName}: report stored as reports/${name} (${size} bytes)`);

  // Fire and forget: the report is already stored, and a caller that fails to act on it must
  // not turn a successful upload into an error the browser has to make sense of.
  try {
    void Promise.resolve(
      options.onReport?.({ conversationId, appName, file: path.join(dir, name), bytes: size }),
    ).catch((error: unknown) => logger.warn(`[apps] report handler failed: ${String(error)}`));
  } catch (error) {
    logger.warn(`[apps] report handler failed: ${String(error)}`);
  }

  res.writeHead(204, { ...BASE_HEADERS });
  res.end();
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
  // Apps may leave a report for whoever is debugging them; everything else here is read-only.
  // Matched before the method check because that check refuses the one write this origin
  // accepts.
  const reportMatch = /^\/apps\/(\d+)\/([^/]+)\/report$/.exec(url.pathname);
  if (reportMatch && req.method === "POST") {
    await receiveReport(options, req, res, Number(reportMatch[1]), decodeURIComponent(reportMatch[2]));
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, "text/plain; charset=utf-8", TEXT_CSP, "method not allowed", { Allow: "GET, HEAD" });
    return;
  }

  // Apps, before the artifact match: `/apps/...` is its own namespace and must not be
  // mistaken for a conversation key. What an app *is* lives in `durable/apps.ts`; this
  // branch only serves files and sets the headers a bundled page needs.
  const appsMatch = /^\/apps(?:\/(.*))?$/.exec(url.pathname);
  if (appsMatch) {
    await serveApp(options, req, res, url, (appsMatch[1] ?? "").split("/").filter((part) => part !== ""));
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
  const file = files.find((candidate) => candidate.key === key) ?? findShortKey(files, conversationId, key);
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

  // Audio is answered from its bytes, before anything tries to decode it as text, for
  // the same reason a picture is: `readArtifact` reports a WAV as "binary" and returns
  // no content, so a check below this point would never see one.
  //
  // Two URLs, and the split is the same one the image makes:
  //
  //   `?raw`   — the bytes, with their real content type. What the player document
  //              below reads, and what ↗ opens (where the browser's own controls
  //              appear, with its own scrubber).
  //   plain    — a player document around those bytes, because a raw audio document in
  //              a frame gets the browser's native `<audio>` chrome, which follows the
  //              *browser's* theme rather than this page's, and cannot show a waveform
  //              or a elapsed/total readout.
  //
  // Both honour `Range`. That is not an optimisation here — it is what makes seeking
  // work at all: a player scrubbed to 0:12 must not have to download the first 12
  // seconds again, and Safari refuses to play a media element from a server that
  // never answers 206.
  const audioType = audioTypeOf(key);
  if (audioType !== undefined) {
    let audio;
    try {
      if (revision !== "" && revision !== "latest") {
        if (!repo) throw new Error("artifacts are not version controlled here");
        audio = await readImageAtRevision(options, repo, revision, file);
      } else {
        audio = readArtifactBytes(file);
      }
    } catch (error) {
      logger.error(`[artifacts] ${key}: ${(error as Error).message}`);
      send(res, 404, "text/html; charset=utf-8", documentCsp, unreadableDocument(key));
      return;
    }

    if (!url.searchParams.has("raw")) {
      const nonce = randomBytes(16).toString("base64");
      send(
        res,
        200,
        "text/html; charset=utf-8",
        mediaDocumentCsp(frameAncestorsFor(options.webOrigin), nonce),
        audioDocument({
          key,
          // Relative to this document, so it works behind any mount prefix: the
          // sibling bytes of the same artifact.
          href: `${encodeURIComponent(key.split("/").at(-1) ?? key)}?raw`,
          type: audioType,
          ...(audio.size > audio.bytes.length
            ? { note: `Playing the first ${Math.round(audio.bytes.length / 1024)} KiB of ${audio.size} bytes.` }
            : {}),
          nonce,
        }),
      );
      return;
    }

    const filename = encodeURIComponent(key.split("/").at(-1) ?? key);
    const headers: Record<string, string> = {
      "Content-Disposition": `${url.searchParams.has("download") ? "attachment" : "inline"}; filename="${filename}"`,
      // A media element scrubs by asking for ranges; without this header a browser
      // will not try, and the progress bar cannot be dragged.
      "Accept-Ranges": "bytes",
      "Color-Scheme": "light dark",
    };
    const range = mediaRange(req.headers.range, audio.bytes.length);
    if (range === "unsatisfiable") {
      send(res, 416, "text/plain; charset=utf-8", TEXT_CSP, "range not satisfiable", {
        ...headers,
        "Content-Range": `bytes */${audio.bytes.length}`,
      });
      return;
    }
    if (range === undefined) {
      send(res, 200, audioType, IMAGE_CSP, audio.bytes, headers);
      return;
    }
    send(res, 206, audioType, IMAGE_CSP, audio.bytes.subarray(range.start, range.end + 1), {
      ...headers,
      "Content-Range": `bytes ${range.start}-${range.end}/${audio.bytes.length}`,
      "Content-Length": String(range.end - range.start + 1),
    });
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
  // `?download` asks for the bytes as an attachment rather than to be shown. Without
  // it a text artifact is always inline — which is right for the frame, and wrong for
  // the drawer's download button, where the point is to save the file rather than
  // to open another view of it. The filename is the artifact's own, so a save lands
  // as `run_tts.sh` rather than as whatever the browser derives from the URL.
  send(res, 200, "text/plain; charset=utf-8", TEXT_CSP, read.content + suffix, {
    "Content-Disposition": `${url.searchParams.has("download") ? "attachment" : "inline"}; filename="${encodeURIComponent(key.split("/").at(-1) ?? key)}"`,
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
