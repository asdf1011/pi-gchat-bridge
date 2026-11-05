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
import http from "node:http";

import { isMarkdown, readArtifact, type ArtifactFile } from "../durable/artifacts.js";
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
const DOCUMENT_CSP =
  "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; " +
  "form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

/** Raw text is inert by content type; the CSP is a second belt in case of sniffing. */
const TEXT_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'";

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

/** One request. Split out so tests can drive it without a socket. */
async function handle(
  options: ArtifactsServerOptions,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://artifacts.invalid");

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
    send(res, 200, "text/html; charset=utf-8", DOCUMENT_CSP, indexPage(conversationId, files));
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

  let read;
  try {
    read = readArtifact(file, { ...(options.redact ? { redact: options.redact } : {}) });
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

  if (url.searchParams.has("render") && isMarkdown(key)) {
    const body = renderMarkdown(read.content);
    const note = read.truncated ? `<p class="meta">Truncated at ${read.content.length} of ${read.size} bytes.</p>` : "";
    send(res, 200, "text/html; charset=utf-8", DOCUMENT_CSP, markdownDocument(key, body + note));
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
