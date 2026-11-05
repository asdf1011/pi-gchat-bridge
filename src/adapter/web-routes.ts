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
import type http from "node:http";

import { attachWebClient, webIndex, webPage, webPageVersion, webSubmit } from "./web.js";
import { renderMarkdown } from "./markdown.js";
import type { SessionHost } from "../session-host/api.js";
import { logger } from "../logger.js";

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

  // A proxy that mounts us at /pi/ and strips the prefix asks for "/". Redirect
  // to the app rather than serving it here: the page resolves every URL relative
  // to its own directory, so serving it at "/" made it request
  // "/api/conversations" — a 404 — and the conversation list came up empty on
  // exactly the URL a bookmark would use.
  if (
    (req.method === "GET" || req.method === "HEAD") &&
    (url.pathname === "/" || url.pathname === "")
  ) {
    const base = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
    res.writeHead(302, { Location: `${base}web/`, "Cache-Control": "no-store" });
    res.end();
    return true;
  }

  const path = webPath(url.pathname);

  if (req.method === "GET" && (path === "/web" || path === "/web/")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(webPage());
    return true;
  }

  // What the page needs to know about this deployment. One field today; a
  // separate route rather than a field on the conversation list, so the list's
  // shape stays the array the page already renders.
  if (req.method === "GET" && path === "/web/api/environment") {
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
  const history = /^\/web\/api\/c\/(\d+)\/history$/.exec(path);
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

  // The artifact list for one conversation, same-origin: the page links to the
  // artifact host but never fetches from it, so no CORS is needed anywhere.
  const artifactList = /^\/web\/api\/c\/(\d+)\/artifacts$/.exec(path);
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

  if (req.method === "GET" && path === "/web/api/conversations") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(await webIndex(handleOptions)));
    return true;
  }

  const events = /^\/web\/api\/c\/(\d+)\/events$/.exec(path);
  if (req.method === "GET" && events) {
    const conversationId = Number(events[1]);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      // No CORS: the page is served from this origin only.
    });
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

  const send = /^\/web\/api\/c\/(\d+)\/message$/.exec(path);
  if (req.method === "POST" && send) {
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return true;
    }
    const body = await readBody(req, 200_000);
    if (body === null) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "request body too large" }));
      return true;
    }
    let text = "";
    try {
      const parsed = JSON.parse(body) as { text?: unknown };
      text = typeof parsed.text === "string" ? parsed.text : "";
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "invalid JSON body" }));
      return true;
    }
    const result = await webSubmit(handleOptions, Number(send[1]), text);
    if (result.ok) {
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
