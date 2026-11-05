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
  webPage,
  webPageVersion,
  webSubmit,
  type PastedImage,
} from "./web.js";
import { renderMarkdown } from "./markdown.js";
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
  const isPage =
    path === "/" || path === "" || path === "/web" || path === "/web/" || /^\/\d+\/?$/.test(path);
  if ((req.method === "GET" || req.method === "HEAD") && isPage) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
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
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 20) || 20, 100);
    const messages = await seam.history(Number(history[1]), { limit });
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
    res.end(JSON.stringify(messages.map((m) => ({ ...m, html: renderMarkdown(m.text) }))));
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
              ? { ...(data as object), html: renderMarkdown((data as { text: string }).text) }
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
    // Room for a couple of pasted images: base64 inflates by a third, and the
    // cap below is per image.
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
            // A pasted file is untrusted input: refuse anything that is not an
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
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "invalid JSON body" }));
      return true;
    }
    const result = await webSubmit(handleOptions, Number(send[1]), text, "steer", images);
    if (result.ok) {
      // Chat cannot show this as the person who typed it, but the thread should
      // read as a conversation: say who spoke and what they said. Failure is
      // logged and ignored — a missing notice must never fail the submission.
      const speaker = (who.email ?? "someone").split("@")[0];
      // Truncated: a long paste would be a Chat API error, and the notice is a
      // signpost to the conversation, not a copy of it.
      const attachment = images.length === 0 ? "" : ` [${images.length} image${images.length === 1 ? "" : "s"}]`;
      const notice = (text.length > 1200 ? `${text.slice(0, 1200)}…` : text) + attachment;
      void seam
        .announce(Number(send[1]), `${speaker} (webui): ${notice}`)
        .catch((error: unknown) => log.info(`[web] announce failed: ${(error as Error).message}`));
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

  return false;
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
