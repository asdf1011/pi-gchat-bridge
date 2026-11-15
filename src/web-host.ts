/**
 * The web front end, in its own process.
 *
 * Forked by the session host, and connected to it
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

import { handleWebRequest } from "./web/routes.js";
import { logger } from "./logger.js";
import { linkSessionHost } from "./session-host/link.js";
import { serveRoutes } from "./shared/serve-routes.js";

const port = Number(process.env.BRIDGE_WEB_PORT ?? 0);
const bind = process.env.BRIDGE_BIND ?? "127.0.0.1";
const token = process.env.BRIDGE_WEB_TOKEN ?? "";
const artifactsBaseUrl = process.env.BRIDGE_ARTIFACTS_BASE_URL ?? "";
/**
 * Where artifact files live on disk, so a comment's message can name the real
 * path rather than the viewer's key.
 *
 * Read here rather than passed down because this process is the one that serves
 * the routes — the session host never sees a browser
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

const server = http.createServer(
  serveRoutes({
    trustedProxy,
    warn: (line) => logger.warn(line),
    onError: (error) => logger.error("[web-host] request failed:", (error as Error).message),
    routes: async ({ req, res, url, who }) => {
      if (req.method === "GET" && url.pathname === "/healthz") {
        // This process's own liveness: the supervisor uses it to decide whether the *adapter* came
        // back, not whether the session host is healthy.
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
        return true;
      }
      return handleWebRequest(req, res, url, {
        seam,
        model,
        ...(token ? { token } : {}),
        ...(artifactsBaseUrl ? { artifactsBaseUrl } : {}),
        ...(artifactsDir === ""
          ? {}
          : {
              // The comment names its file the way the viewer does — a key relative to
              // whichever artifact root holds it (`conversation/7/a.sh`, or
              // `src/durable/host.ts` for a file in the checkout). The artifact directory is
              // where the first kind is rooted; the second is left to the model to resolve,
              // because guessing a cwd for it is how a message ends up naming the wrong file.
              //
              // A file already named absolutely is taken as it is.
              artifactPath: (conversationId: number, file: string): string => {
                if (path.isAbsolute(file)) return file;
                const scope = `conversation/${conversationId}/`;
                return file.startsWith(scope)
                  ? path.join(artifactsDir, file)
                  : file;
              },
            }),
        who,
      });
    },
  }),
);

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
