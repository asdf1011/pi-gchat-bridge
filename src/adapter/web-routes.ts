/**
 * The browser front end's HTTP surface, in one place.
 *
 * Extracted so the same routes can be served from either side of the seam: the
 * bridge process today, and a separate adapter process once
 * `BRIDGE_WEB_ENGINE=link` is on. The routes only ever touch `SessionHost`, so
 * moving them is a deployment change rather than a port.
 *
 * It handles `/` (redirect), `/web/` (the page), and the three API routes. It
 * deliberately does **not** handle `/healthz` or `/notify`: those belong to the
 * session host, and an adapter process should never be able to answer a health
 * probe on its behalf.
 */
import { randomUUID } from "node:crypto";
import type http from "node:http";

import {
  attachWebClient,
  MAX_WEB_IMAGE_BYTES,
  MAX_WEB_IMAGES,
  WEB_ICON,
  WEB_RENDER_OPTIONS,
  webPage,
  webPageVersion,
  webSubmit,
  type PastedImage,
} from "./web.js";
import { renderMarkdown } from "./markdown.js";
import { anchorAddress, chatReplyText, chatText, MAX_COMMENT_CHARS, modelText } from "../durable/comments.js";
import type { SessionHost } from "../session-host/api.js";
import { logger } from "../logger.js";

/** Keep a number inside a range, without trusting the query string. */
function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** The shape the page renders for one conversation. */
function toJson(conversation: {
  conversationId: number;
  name: string;
  label?: string;
  preview?: string;
  model: string;
  createdAt: number;
  lastActivityAt?: number;
}): Record<string, unknown> {
  return {
    conversationId: conversation.conversationId,
    chatKey: conversation.name,
    model: conversation.model,
    // A title if one exists, the opening words if not, and the thread key only
    // when neither does — which is a conversation nobody has spoken in.
    ...(conversation.label !== undefined
      ? { name: conversation.label }
      : conversation.preview !== undefined
        ? { name: conversation.preview }
        : {}),
    createdAt: conversation.createdAt,
    lastActivityAt: conversation.lastActivityAt ?? conversation.createdAt,
  };
}

/** Who the reverse proxy said is asking. */
export interface Identity {
  email?: string;
  untrustedHeader?: boolean;
}

export interface WebRouteOptions {
  seam: SessionHost;
  /** Default model for conversations started from the web. */
  model: { provider: string; modelId: string };
  /** Bearer token required for writes. Empty disables the check. */
  token?: string;
  /**
   * Where the artifact origin is, for the pane's links. Empty hides the panel's
   * buttons: an artifact link that cannot be opened is worse than no link.
   */
  artifactsBaseUrl?: string;
  /**
   * Where a comment's file lives on disk, for the message the model receives.
   *
   * Absolute, because the model has tools: `a.sh` alone does not say which of the
   * directories a session can see. Supplied by the caller, which is the only place
   * that knows where artifacts are rooted.
   */
  artifactPath?: (conversationId: number, file: string) => string;
  /** Resolved by the caller, so this module does no header trust of its own. */
  who: Identity;
  log?: { info(message: string): void };
}

/**
 * Strip a reverse proxy's mount prefix, so route matching is independent of
 * whether the proxy passes "/pi/web/..." or rewrites it to "/web/...".
 */
export function webPath(pathname: string): string {
  const at = pathname.indexOf("/web");
  return at > 0 ? pathname.slice(at) : pathname;
}

/**
 * The API path, wherever the app is mounted.
 *
 * The page resolves API calls against the mount root, so a page at `/32/` asks for
 * `/api/...` while the same page behind a prefix asks for `/pi/web/api/...`.
 * Matching on the `/api/` suffix accepts both, and any future mount, without the
 * page having to know its own depth.
 */
export function apiPath(pathname: string): string {
  const at = pathname.indexOf("/api/");
  return at > 0 ? pathname.slice(at) : pathname;
}

/**
 * Handle one request. Returns `true` when it was a web route and the response
 * has been written, `false` to let the caller keep looking.
 */
export async function handleWebRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  options: WebRouteOptions,
): Promise<boolean> {
  const { seam, model, token, who } = options;
  const log = options.log ?? logger;
  const handleOptions = { seam, model, ...(token ? { token } : {}) };

  const path = webPath(url.pathname);

  // --- Pages ---
  //
  // One document, two modes, chosen by the URL: the mount root lists recent
  // conversations, `/<id>/` opens one. `/web/` is kept because it is what the
  // address bar and old bookmarks hold.
  //
  // The favicon is matched by suffix like the API below, for the same reason: the
  // page may be mounted at `/web/` or behind a proxy at `/pi/web/`, and a browser
  // asks for whichever path the `<link rel="icon">` resolved to from `<base>`.
  if (
    (req.method === "GET" || req.method === "HEAD") &&
    (path.endsWith("/favicon.svg") || path.endsWith("/icon.svg"))
  ) {
    res.writeHead(200, {
      "Content-Type": "image/svg+xml; charset=utf-8",
      // A day: the icon is a build artifact, so it changes rarely, but it is not
      // immutable either — a day of the previous icon after a deploy beats an hour
      // of 404s, and a hard reload always refetches it.
      "Cache-Control": "public, max-age=86400",
      // SVG is only rendered as a document when navigated to directly, and this one
      // carries no script, so no CSP is needed. It does get its own content type:
      // served as text/html it would be a place to reflect a query string into.
    });
    res.end(req.method === "HEAD" ? undefined : WEB_ICON);
    return true;
  }
  const isPage =
    path === "/" || path === "" || path === "/web" || path === "/web/" || /^\/\d+\/?$/.test(path);
  if ((req.method === "GET" || req.method === "HEAD") && isPage) {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      // A second barrier behind the renderer's source check, not a replacement
      // for it: `img-src 'self' data:` means that even if a source slipped past
      // `safeImageSrc`, the browser would refuse to fetch another host — and
      // would refuse `data:` too if the list did not name it. `data:` is here
      // for the composer's optimistic preview of a just-pasted image, which is
      // this origin's own bytes. No CDN, no avatars, no remote anything.
      "Content-Security-Policy": "img-src 'self' data:; object-src 'none'; base-uri 'self'",
    });
    res.end(webPage());
    return true;
  }

  // What the page needs to know about this deployment. One field today; a
  // separate route rather than a field on the conversation list, so the list's
  // shape stays the array the page already renders.
  const api = apiPath(path);
  if (req.method === "GET" && api === "/api/environment") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        artifactsBaseUrl: (options.artifactsBaseUrl ?? "").replace(/\/$/, ""),
        // The open page compares this on every reconnect and reloads itself when
        // it changes, so a rebuilt front end reaches the browser without a manual
        // refresh.
        pageVersion: webPageVersion(),
      }),
    );
    return true;
  }

  // The last few messages, so opening a conversation shows what was being
  // discussed instead of a blank pane (the stream only carries the live answer).
  const history = /^\/api\/c\/(\d+)\/history$/.exec(api);
  if (req.method === "GET" && history) {
    // A screenful by default rather than the whole conversation: the pane pages
    // backwards from here on scroll, so the first paint stays small on a phone
    // even for a thread with a thousand entries.
    const limit = clamp(Number(url.searchParams.get("limit") ?? 50) || 50, 1, 200);
    // Counted back from the newest message, which is the direction the pane
    // pages in. Zero means "the most recent page".
    const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
    const messages = await seam.history(Number(history[1]), { limit, offset });
    if (messages === undefined) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: `no such conversation: ${history[1]}` }));
      return true;
    }
    // Rendered here, not in the browser: the renderer escapes every byte of
    // source before it emits a tag, so what reaches the page's innerHTML can
    // only be our markup. Doing it client-side would mean shipping either a
    // second renderer or an unsanitised `innerHTML` — and this origin can submit
    // messages, so an injected script would be able to run tools.
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(messages.map((m) => ({ ...m, html: renderMarkdown(m.text, WEB_RENDER_OPTIONS) }))));
    return true;
  }

  // One image from the transcript. Bytes are served from here rather than inlined
  // into `history`, so a page of messages stays small and only the images on
  // screen are fetched.
  const image = /^\/api\/c\/(\d+)\/image\/(\d+)\/(\d+)$/.exec(api);
  if (req.method === "GET" && image) {
    const found = await seam.image(Number(image[1]), Number(image[2]), Number(image[3]));
    if (!found) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "no such image" }));
      return true;
    }
    const bytes = Buffer.from(found.data, "base64");
    res.writeHead(200, {
      "Content-Type": found.mimeType,
      "Content-Length": String(bytes.length),
      // Private: the image is a user's, not a public asset.
      "Cache-Control": "private, max-age=3600",
    });
    res.end(bytes);
    return true;
  }

  // The artifact list for one conversation, same-origin: the page links to the
  // artifact host but never fetches from it, so no CORS is needed anywhere.
  const artifactList = /^\/api\/c\/(\d+)\/artifacts$/.exec(api);
  if (req.method === "GET" && artifactList) {
    const artifacts = await seam.artifacts(Number(artifactList[1]));
    if (artifacts === undefined) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: `no such conversation: ${artifactList[1]}` }));
      return true;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        artifacts.map((artifact) => ({
          key: artifact.key,
          wrote: artifact.wrote,
          edited: artifact.edited,
          markdown: /\.(md|markdown)$/i.test(artifact.key),
        })),
      ),
    );
    return true;
  }

  if (req.method === "GET" && api === "/api/conversations") {
    const limit = clamp(Number(url.searchParams.get("limit") ?? 30) || 30, 1, 100);
    const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
    // One extra row tells the client whether another page exists without a
    // second count query.
    const rows = await seam.list({ limit: limit + 1, offset });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        items: rows.slice(0, limit).map(toJson),
        more: rows.length > limit,
        offset,
        limit,
      }),
    );
    return true;
  }

  // One conversation, for the page's own heading. Scanning the bindings is fine:
  // they are one document, and this is asked once per page load.
  const one = /^\/api\/c\/(\d+)$/.exec(api);
  if (req.method === "GET" && one) {
    const found = (await seam.list()).find((c) => c.conversationId === Number(one[1]));
    if (!found) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: `no such conversation: ${one[1]}` }));
      return true;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(toJson(found)));
    return true;
  }

  // "New chat": a conversation nobody has named yet, created from the default
  // model. The client navigates to /<id>/ afterwards.
  if (req.method === "POST" && api === "/api/conversations") {
    const name = `web:${randomUUID()}`;
    const created = await seam.create(name, { model });
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify(toJson(created)));
    return true;
  }

  const events = /^\/api\/c\/(\d+)\/events$/.exec(api);
  if (req.method === "GET" && events) {
    const conversationId = Number(events[1]);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      // No CORS: the page is served from this origin only.
    });
    // Node does not put headers on the wire until the first write or an explicit
    // flush. Without this, a conversation whose first frame is slow (idle threads,
    // where nothing arrives to flush) leaves the browser waiting for headers that
    // exist only in memory — the page showed a blank pane for exactly this reason.
    res.flushHeaders();
    // And a first byte now, so the headers are actually on the wire rather than
    // waiting for the first frame.
    res.write(": stream open\n\n");
    let alive = true;
    const client = {
      open: alive,
      send(event: string, data: unknown) {
        if (!alive) return;
        try {
          // Answer frames carry the raw text *and* its rendering. Rendering here
          // rather than in the page is deliberate: our renderer escapes every
          // byte before emitting a tag, so the HTML the pane assigns cannot
          // contain a script — and this origin can submit messages, so an
          // injected one could drive tools.
          const payload =
            event === "text" && typeof (data as { text?: unknown }).text === "string"
              ? { ...(data as object), html: renderMarkdown((data as { text: string }).text, WEB_RENDER_OPTIONS) }
              : data;
          res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
        } catch {
          alive = false;
        }
      },
    };
    // A comment line keeps proxies from closing an idle stream.
    const keepalive = setInterval(() => {
      if (!alive) return;
      try {
        res.write(": keepalive\n\n");
      } catch {
        alive = false;
      }
    }, 15_000);
    const handle = await attachWebClient(handleOptions, conversationId, client);
    req.on("close", () => {
      alive = false;
      clearInterval(keepalive);
      handle.close();
    });
    return true;
  }

  const send = /^\/api\/c\/(\d+)\/message$/.exec(api);
  if (req.method === "POST" && send) {
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return true;
    }
    // Room for several images: base64 inflates by a third, and the cap below is
    // per image. The page caps the count before it sends; this is the backstop
    // for anything posting here directly.
    const body = await readBody(req, 24_000_000);
    if (body === null) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "request body too large" }));
      return true;
    }
    let text = "";
    let images: PastedImage[] = [];
    try {
      const parsed = JSON.parse(body) as { text?: unknown; images?: unknown };
      text = typeof parsed.text === "string" ? parsed.text : "";
      images = Array.isArray(parsed.images)
        ? parsed.images.flatMap((entry) => {
            const image = entry as { data?: unknown; mimeType?: unknown };
            if (typeof image.data !== "string" || typeof image.mimeType !== "string") return [];
            // An attached file is untrusted input, whether it came from the
            // clipboard or the file picker: refuse anything that is not an
            // image, and anything too big to send to a model.
            if (!image.mimeType.startsWith("image/")) return [];
            if (Buffer.byteLength(image.data, "base64") > MAX_WEB_IMAGE_BYTES) return [];
            return [{ data: image.data, mimeType: image.mimeType }];
          })
        : [];
      if (Array.isArray(parsed.images) && images.length !== parsed.images.length) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "unsupported or oversized image" }));
        return true;
      }
      // Its own message, because it is the one refusal a person can act on
      // without knowing anything about bytes: send fewer pictures.
      if (images.length > MAX_WEB_IMAGES) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: `at most ${MAX_WEB_IMAGES} images per message` }));
        return true;
      }
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "invalid JSON body" }));
      return true;
    }
    const result = await webSubmit(handleOptions, Number(send[1]), text, "steer", images);
    if (result.ok) {
      // Chat cannot show this as the person who typed it, but the conversation
      // has to read the same on both surfaces: the prompt rides into Chat with
      // the answer, quoted above it, so there is no message missing from the
      // thread and no notification about words the person typed themselves
      // (`durable/mirror.ts`). Failure is logged and ignored — a missing mirror
      // must never fail the submission.
      const speaker = (who.email ?? "someone").split("@")[0];
      // Truncated: a long paste would be a Chat API error, and the notice is a
      // signpost to the conversation, not a copy of it. "attached", not
      // "pasted": the image may have come from a file picker or a drop.
      const attachment = images.length === 0 ? "" : ` [${images.length} image${images.length === 1 ? "" : "s"} attached]`;
      const notice = (text.length > 1200 ? `${text.slice(0, 1200)}…` : text) + attachment;
      void seam
        .mirrorTurn(Number(send[1]), result.submissionId, `${speaker} (webui): ${notice}`)
        .catch((error: unknown) => log.info(`[web] mirror failed: ${(error as Error).message}`));
      // Who asked, and which conversation: this bridge can run shell commands,
      // so "who submitted this" belongs in the log.
      log.info(
        `[web] ${who.email ?? "anonymous"}: submitted to conversation ${send[1]} (submission ${result.submissionId})`,
      );
    }
    res.writeHead(result.ok ? 202 : 400, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return true;
  }

  // --- Review comments -----------------------------------------------------
  //
  // A comment is two things at once, and the order matters: a durable record
  // (so the review survives a restart) and a turn (so the agent can act on it).
  // The record is written first — losing the answer is recoverable, losing the
  // reviewer's words is not.
  const commentList = /^\/api\/c\/(\d+)\/comments$/.exec(api);
  if (req.method === "GET" && commentList) {
    const comments = await seam.comments(Number(commentList[1]));
    if (comments === undefined) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: `no such conversation: ${commentList[1]}` }));
      return true;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        comments.map((comment) => ({
          id: comment.id,
          file: comment.file,
          // The address is formatted here, so the page and the Chat message can
          // never disagree about how a comment is cited.
          address: anchorAddress(comment),
          anchors: comment.anchors,
          ...(comment.quote === undefined ? {} : { quote: comment.quote }),
          text: comment.text,
          at: comment.at,
          ...(comment.author === undefined ? {} : { author: comment.author }),
          state: comment.state,
          resolved: comment.resolved === true,
          positions: comment.positions,
          // Where the lines went, when the revision that replaced them is known.
          // The page draws the note against that section instead of filing it under
          // "orphaned", which was the successful review being reported as a failure.
          ...(comment.successor === undefined ? {} : { successor: comment.successor }),
          replies: (comment.submissions ?? []).length,
        })),
      ),
    );
    return true;
  }

  const commentCreate = /^\/api\/c\/(\d+)\/comments$/.exec(api);
  if (req.method === "POST" && commentCreate) {
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return true;
    }
    const body = await readBody(req, 64_000);
    if (body === null) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "request body too large" }));
      return true;
    }
    let parsed: {
      file?: unknown;
      line?: unknown;
      endLine?: unknown;
      charStart?: unknown;
      charEnd?: unknown;
      quote?: unknown;
      occurrence?: unknown;
      text?: unknown;
    };
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "invalid JSON body" }));
      return true;
    }
    const conversationId = Number(commentCreate[1]);
    if (typeof parsed.file !== "string" || parsed.file === "") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "missing file" }));
      return true;
    }
    if (typeof parsed.text !== "string" || parsed.text.trim() === "") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "empty comment" }));
      return true;
    }
    const number = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isFinite(value) ? value : undefined;
    const selection = {
      ...(number(parsed.line) === undefined ? {} : { line: number(parsed.line)! }),
      ...(number(parsed.endLine) === undefined ? {} : { endLine: number(parsed.endLine)! }),
      ...(number(parsed.charStart) === undefined ? {} : { charStart: number(parsed.charStart)! }),
      ...(number(parsed.charEnd) === undefined ? {} : { charEnd: number(parsed.charEnd)! }),
      ...(typeof parsed.quote === "string" && parsed.quote.trim() !== "" ? { quote: parsed.quote } : {}),
      ...(number(parsed.occurrence) === undefined ? {} : { occurrence: number(parsed.occurrence)! }),
    };
    const speaker = (who.email ?? "someone").split("@")[0]!;
    const created = await seam.addComment(conversationId, {
      file: parsed.file,
      selection,
      text: parsed.text,
      author: speaker,
    });
    if ("error" in created) {
      // Not a 500: "this deployment does not version artifacts" is an ordinary
      // answer, and the page shows it next to the selection.
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: created.error }));
      return true;
    }

    // The turn. Rendered by the host's own rule for what a comment looks like to
    // a model, so the message and the review pane cannot drift apart.
    const path = options.artifactPath?.(conversationId, parsed.file) ?? parsed.file;
    // The host returns the comment it stored — anchors and resolved quote
    // included — so the message is worded from what was recorded, never from
    // what the request claimed.
    const stored = created.comment;
    const message = modelText({ ...stored, author: speaker }, { path });
    const result = await seam.submit(conversationId, {
      content: message,
      whenBusy: "steer",
      // A review comment is words from the browser, whoever typed them.
      origin: "webui",
      // One comment, one turn: a double-click or a retry must not start two.
      requestId: `comment:${stored.id}`,
    });
    if ("error" in result) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: result.error, id: stored.id }));
      return true;
    }
    await seam.noteCommentSubmission(conversationId, stored.id, result.submissionId).catch(() => {});

    // A Chat reader cannot see the web pane, so the thread is told what is being
    // reviewed — with the address as a link into the viewer — and then the answer
    // follows it, in one message (see the submit path above).
    void seam
      .mirrorTurn(
        conversationId,
        result.submissionId,
        chatText({ ...stored, author: speaker }, { url: viewerUrl(options, conversationId, stored), speaker }),
      )
      .catch((error: unknown) => log.info(`[web] mirror failed: ${(error as Error).message}`));
    log.info(`[web] ${who.email ?? "anonymous"}: commented on ${parsed.file} (submission ${result.submissionId})`);

    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, id: stored.id, submissionId: result.submissionId }));
    return true;
  }

  const commentReply = /^\/api\/c\/(\d+)\/comments\/([^/]+)\/reply$/.exec(api);
  if (req.method === "POST" && commentReply) {
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return true;
    }
    const conversationId = Number(commentReply[1]);
    const commentId = decodeURIComponent(commentReply[2]!);
    const body = await readBody(req, 64_000);
    if (body === null) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "request body too large" }));
      return true;
    }
    let text = "";
    try {
      text = (JSON.parse(body) as { text?: unknown }).text as string;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "invalid JSON body" }));
      return true;
    }
    if (typeof text !== "string" || text.trim() === "" || text.length > MAX_COMMENT_CHARS) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "a reply needs text, under the length limit" }));
      return true;
    }
    const stored = (await seam.comments(conversationId))?.find((candidate) => candidate.id === commentId);
    if (!stored) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "no such comment" }));
      return true;
    }
    // A reply is a follow-up in the same thread, so it names the comment it
    // belongs to — the model sees the address again and knows what it is about.
    const path = options.artifactPath?.(conversationId, stored.file) ?? stored.file;
    const reply = `${modelText(stored, { path })}\n\n(reply from ${(who.email ?? "someone").split("@")[0]})\n\n${text.trim()}`;
    const result = await seam.submit(conversationId, {
      content: reply,
      whenBusy: "followUp",
      origin: "webui",
    });
    if ("error" in result) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: result.error }));
      return true;
    }
    await seam.noteCommentSubmission(conversationId, commentId, result.submissionId).catch(() => {});
    // Mirrored like every other submission. It used to be missing here, which made
    // a review reply the one kind of message Chat never saw: the thread showed the
    // agent answering a reply that was only in the drawer.
    const speaker = (who.email ?? "someone").split("@")[0]!;
    void seam
      .mirrorTurn(
        conversationId,
        result.submissionId,
        chatReplyText(stored, text.trim(), { url: viewerUrl(options, conversationId, stored), speaker }),
      )
      .catch((error: unknown) => log.info(`[web] mirror failed: ${(error as Error).message}`));
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, submissionId: result.submissionId }));
    return true;
  }

  const commentThread = /^\/api\/c\/(\d+)\/comments\/([^/]+)\/thread$/.exec(api);
  if (req.method === "GET" && commentThread) {
    const replies = await seam.commentThread(Number(commentThread[1]), decodeURIComponent(commentThread[2]!));
    if (replies === undefined) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "no such comment" }));
      return true;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        replies.map((reply) => ({
          kind: reply.kind,
          ...(reply.submissionId === undefined ? {} : { submissionId: reply.submissionId }),
          ...(reply.at === undefined ? {} : { at: reply.at }),
          ...(reply.author === undefined ? {} : { author: reply.author }),
          text: reply.text,
          html: renderMarkdown(reply.text),
        })),
      ),
    );
    return true;
  }

  const commentResolve = /^\/api\/c\/(\d+)\/comments\/([^/]+)\/resolve$/.exec(api);
  if (req.method === "POST" && commentResolve) {
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return true;
    }
    const body = await readBody(req, 4096);
    let resolved = true;
    if (body !== null && body.trim() !== "") {
      try {
        const parsed = JSON.parse(body) as { resolved?: unknown };
        if (typeof parsed.resolved === "boolean") resolved = parsed.resolved;
      } catch {
        // A body-less resolve is the common case; a malformed one resolves too.
      }
    }
    const changed = await seam.resolveComment(
      Number(commentResolve[1]),
      decodeURIComponent(commentResolve[2]!),
      resolved,
    );
    res.writeHead(changed ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: changed, resolved }));
    return true;
  }

  return false;
}

/**
 * A link into the viewer for one comment's address.
 *
 * Empty when `artifactsBaseUrl` is unset — the side-panel deployment has no origin
 * to link to, and a plain label still says which line is being discussed. The
 * anchor suffix is the address's own tail (`#L3C126-L3C131`), sliced rather than
 * rebuilt so a person reading Chat links to exactly what a person reading the
 * drawer sees.
 */
function viewerUrl(
  options: { artifactsBaseUrl?: string },
  conversationId: number,
  comment: { file: string; anchors: readonly { originalLine: number }[]; charStart?: number; charEnd?: number },
): string {
  const base = (options.artifactsBaseUrl ?? "").replace(/\/$/, "");
  if (base === "") return "";
  const suffix = anchorAddress(comment).slice(comment.file.length);
  const framePath = comment.file.split("/").map(encodeURIComponent).join("/");
  return `${base}/c/${conversationId}/${framePath}?view=source${suffix}`;
}

/** Read a request body up to `maxBytes`; returns null when the cap is exceeded. */
export function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > maxBytes) {
        done = true;
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (error) => {
      if (done) return;
      done = true;
      reject(error);
    });
  });
}
