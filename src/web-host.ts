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

import fs from "node:fs";
import path from "node:path";
import { appDirOf, resolveAppFile } from "./durable/apps.js";

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
/**
 * Where the artifact listener is, when this process should proxy to it.
 *
 * Set only when `BRIDGE_ARTIFACTS_BASE_URL` is empty: that is the deployment
 * saying "serve artifacts on this origin". The separate listener still does all
 * the work — the allow-list, the sandbox, the nonces — and this is a loopback
 * forward, not a second implementation. What it buys is the session: the
 * artifact host is behind its own Cloudflare Access application, and a frame
 * cannot complete an Access login, so a cross-origin artifact is a blank pane.
 * Same origin means the cookie the page already has.
 *
 * It does give up what the second hostname was for. `cloudflared.yml` says a
 * request on the artifact origin cannot reach `/web/api/.../message`; once these
 * routes are on this origin, a same-origin artifact could address them. The
 * documents stay sandboxed and `default-src 'none'`, so nothing in a file can
 * make that request — but the isolation is now a property of the sandbox rather
 * than of the hostname, which is a weaker claim and worth knowing.
 */
const artifactsProxy = artifactsBaseUrl === "" ? (process.env.BRIDGE_ARTIFACTS_PROXY ?? "") : "";
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

/**
 * Forward one `/c/...` request to the artifact listener, unchanged.
 *
 * The path is passed through exactly as it arrived — the listener parses it, and
 * a proxy that rewrote keys would be a second place for the allow-list to be
 * wrong. Only the connection is new: `httpHostHeader` in `cloudflared.yml`
 * expects the artifact host, and nothing here inspects `Host` anyway.
 *
 * Streaming, not buffered, because a PDF's rendered page can be several
 * megabytes and there is no reason to hold it in this process's heap. The
 * upstream's own status and headers are copied verbatim: `Content-Security-Policy`
 * is the thing that makes an artifact safe to render, and a proxy that rebuilt
 * headers could only weaken it.
 */
function proxyArtifact(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  target: string,
): Promise<void> {
  const upstream = new URL(req.url ?? "/", target);
  return new Promise<void>((resolve) => {
    const forwarded = http.request(
      {
        hostname: upstream.hostname,
        port: upstream.port,
        path: upstream.pathname + upstream.search,
        method: req.method,
        headers: { ...req.headers, host: upstream.host },
      },
      (reply) => {
        res.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(res);
        reply.on("end", resolve);
        reply.on("error", () => {
          res.destroy();
          resolve();
        });
      },
    );
    forwarded.on("error", (error) => {
      logger.error(`[web-host] artifact proxy failed: ${error.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("artifacts are not reachable on this deployment\n");
      } else {
        res.destroy();
      }
      resolve();
    });
    req.pipe(forwarded);
  });
}

const server = http.createServer(  serveRoutes({
    trustedProxy,
    warn: (line) => logger.warn(line),
    onError: (error) => logger.error("[web-host] request failed:", (error as Error).message),
    routes: async ({ req, res, url, who }) => {
      // Artifacts, on this origin. Matched before anything else that could claim the
      // path, and before the request is read: the listener decides what a key means,
      // including which keys exist.
      if (artifactsProxy !== "" && (url.pathname === "/c" || url.pathname.startsWith("/c/"))) {
        await proxyArtifact(req, res, artifactsProxy);
        return true;
      }
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
        ...(artifactsProxy !== "" ? { artifactsSameOrigin: true } : {}),
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
              // Which app in this conversation reads text aloud, if any. Scanned from the app
              // manifests rather than named here: the web UI must not know that a TTS app
              // exists, only that one offered to speak.
              // The app's files, served from *this* origin. Talking mode needs the app in a frame
              // that inherits this page's cross-origin isolation, and only same-origin frames do.
              appDirFor: (conversationId: number, app: string): string | undefined =>
                appDirOf(path.join(artifactsDir, "conversation", String(conversationId)), app),
              appFileFor: (conversationId: number, app: string, relative: string): string | undefined => {
                const dir = appDirOf(path.join(artifactsDir, "conversation", String(conversationId)), app);
                return dir === undefined ? undefined : resolveAppFile(dir, relative);
              },
              speechAppFor: (conversationId: number): string | undefined => {
                const dir = path.join(artifactsDir, "conversation", String(conversationId));
                let names: string[];
                try {
                  names = fs.readdirSync(dir);
                } catch {
                  return undefined;
                }
                for (const name of names.sort()) {
                  try {
                    const manifest = JSON.parse(fs.readFileSync(path.join(dir, name, "app.json"), "utf8"));
                    if (manifest?.speech !== true) continue;
                    if (!fs.existsSync(path.join(dir, name, "speech.html"))) continue;
                    // Same origin, so the frame is isolated like the page that holds it.
                    return `/apps/${conversationId}/${name}/speech.html`;
                  } catch {
                    // Not an app, or a manifest that does not parse. Try the next.
                  }
                }
                return undefined;
              },
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
