/**
 * The web front end, in its own process.
 *
 * Forked by the session host when `BRIDGE_WEB_ENGINE=link`, and connected to it
 * over a Node IPC channel carrying a chord link. Everything it serves comes
 * through `SessionHost`, so this file holds no harness, no database and no
 * Chat credentials — which is the whole point: it can be restarted, or edited
 * and rebuilt, without touching a running turn.
 *
 * What it deliberately does *not* serve: `/healthz` and `/notify`. Those belong
 * to the session host, and an adapter process answering a health probe on its
 * behalf would be lying about which process is alive.
 *
 * Reports on stdout, never `process.send`: the IPC channel is chord's link, and
 * a second writer on it is parsed as link frames (a lesson from the S5 spike).
 */
import http from "node:http";

import { createHost, ipcLink } from "@earendil-works/chord";

import path from "node:path";

import { handleWebRequest } from "./adapter/web-routes.js";
import { identify } from "./durable/identity.js";
import { logger } from "./logger.js";
import { linkSessionHost } from "./session-host/link.js";
import { repoRelativePath } from "./durable/artifact-vcs.js";

const port = Number(process.env.BRIDGE_WEB_PORT ?? 0);
const bind = process.env.BRIDGE_BIND ?? "127.0.0.1";
const token = process.env.BRIDGE_WEB_TOKEN ?? "";
const artifactsBaseUrl = process.env.BRIDGE_ARTIFACTS_BASE_URL ?? "";
/**
 * Where artifact files live on disk, so a comment's message can name the real
 * path rather than the viewer's key.
 *
 * Read here rather than passed down because this process is the one that serves
 * the routes — with `BRIDGE_WEB_ENGINE=link` the session host never sees a browser
 * request. Empty means artifacts are not tracked, and the key is all there is.
 */
const artifactsDir = (process.env.BRIDGE_ARTIFACTS_DIR ?? "").trim();
const trustedProxy = process.env.BRIDGE_TRUSTED_PROXY ?? "";
const provider = process.env.BRIDGE_WEB_DEFAULT_PROVIDER ?? "";
const modelId = process.env.BRIDGE_WEB_DEFAULT_MODEL ?? "";

if (!port) {
  logger.error("[web-host] BRIDGE_WEB_PORT is not set — nothing to serve");
  process.exit(2);
}
if (!provider || !modelId) {
  logger.error("[web-host] BRIDGE_WEB_DEFAULT_PROVIDER/MODEL are not set");
  process.exit(2);
}

const client = createHost({
  self: "web-adapter",
  name: "web-adapter",
  kind: "client",
  // The IPC channel is a forked Node channel, not the isomorphic shape chord
  // types it against; the cast is the whole cost.
  upstream: { link: ipcLink(process as unknown as Parameters<typeof ipcLink>[0]), principal: "session-host" },
});
const seam = linkSessionHost({ host: client });
const model = { provider, modelId };

const server = http.createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const who = identify(req, trustedProxy);
    try {
      if (req.method === "GET" && url.pathname === "/healthz") {
        // This process's own liveness: the supervisor uses it to decide whether
        // the *adapter* came back, not whether the session host is healthy.
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
        return;
      }
      const handled = await handleWebRequest(req, res, url, {
        seam,
        model,
        ...(token ? { token } : {}),
        ...(artifactsBaseUrl ? { artifactsBaseUrl } : {}),
        ...(artifactsDir === ""
          ? {}
          : {
              // The comment names its file the way the viewer does
              // (`conversation/7/a.sh`); the repository is the conversation's
              // directory, so strip that much before joining.
              artifactPath: (conversationId: number, file: string): string => {
                const dir = path.join(artifactsDir, "conversation", String(conversationId));
                return path.join(dir, repoRelativePath(dir, file));
              },
            }),
        who,
      });
      if (handled) return;
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "not found" }));
    } catch (error) {
      logger.error("[web-host] request failed:", (error as Error).message);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: (error as Error).message }));
      }
    }
  })();
});

server.listen(port, bind, () => {
  // stdout is the only safe channel here (see the header), so startup says so
  // there: the session host reads it to know when to point the tunnel at us.
  process.stdout.write(`WEB_ADAPTER_LISTENING ${bind}:${port}\n`);
  logger.info(`[web-host] serving /web on ${bind}:${port} via the session host link`);
});

const shutdown = (): void => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
