/**
 * The HTTP skeleton all three processes were writing by hand.
 *
 * Every server in this repository — the host's, the Chat adapter's, the web adapter's — did the same
 * five things in the same order: parse the URL, resolve who is asking, warn when an identity header
 * arrived from somewhere untrusted, try the route table, and turn an exception into a JSON 500 unless
 * the headers had already gone out. Three copies is three places to change the day the answer is
 * different, and the failure mode of getting one of them wrong is a request that hangs.
 *
 * So the skeleton lives here and each process supplies only what is actually its own: a route table,
 * and the address identity headers are trusted from.
 */
import type http from "node:http";

import { identify, type RequestIdentity } from "../durable/identity.js";

/** What a route is handed: the request, the response, the parsed URL, and who is asking. */
export interface ServedRequest {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  who: RequestIdentity;
}

/** A route table answers `true` when it wrote the response, `false` to let the next one look. */
export type RouteTable = (request: ServedRequest) => boolean | Promise<boolean>;

export interface ServeRoutesOptions {
  routes: RouteTable;
  /** Socket peer whose identity headers are believed. Empty trusts none, which is the safe default. */
  trustedProxy?: string;
  /** Where the untrusted-header warning goes. Tests pass a collector; production passes the logger. */
  warn?(line: string): void;
  /** The answer when nothing matched. A JSON 404 unless a process needs something else. */
  notFound?(req: http.IncomingMessage, res: http.ServerResponse): void;
  /** Where a thrown route is reported. */
  onError?(error: unknown, res: http.ServerResponse): void;
}

/** The request listener: one function, ready for `http.createServer`. */
export function serveRoutes(options: ServeRoutesOptions): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  const warn = options.warn ?? ((line: string) => console.warn(line));
  return (req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      // Resolved once per request. The header is only believed when the socket peer is the configured
      // proxy, so it cannot be forged by anything that can merely reach the port.
      const who = identify(req, options.trustedProxy ?? "");
      if (who.untrustedHeader) {
        warn(`[web] identity header from untrusted peer ${req.socket.remoteAddress} — ignored`);
      }
      try {
        if (await options.routes({ req, res, url, who })) return;
        if (options.notFound) {
          options.notFound(req, res);
          return;
        }
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "not found" }));
      } catch (error) {
        (options.onError ?? defaultError)(error, res);
      }
    })();
  };
}

function defaultError(error: unknown, res: http.ServerResponse): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[http] request failed: ${message}`);
  // Headers already sent means the body is partially written: there is no status left to change, and
  // appending a JSON error to a half-written response is worse than ending it.
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(500, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: message }));
}
