#!/usr/bin/env node
/**
 * The smallest server that can serve the web page to a Playwright test.
 *
 * The page's own routes do not need a session host: the document, the icon and the
 * manifest are pure functions of the request, and the e2e spec answers every `/api`
 * call with `page.route()`. The *built* routes are used anyway, rather than copies of
 * them, so a change to the document's headers or to how the manifest is mounted is
 * still under test — only the `SessionHost` is faked, and only for the handful of
 * endpoints the page touches before its first stub.
 *
 * This exists because the old `webServer` ran `dist/durable/main.js` with
 * `BRIDGE_WEB_ENGINE=inprocess`, a mode that no longer exists: the web adapter is a
 * forked process that speaks IPC to a session host, which is a lot of ceremony to
 * prove that a popup is on screen. The tests are about the page, so this serves the
 * page.
 */
import http from "node:http";

import { handleWebRequest } from "../dist/web/routes.js";

const port = Number(process.env.E2E_PAGE_PORT ?? 8099);
const bind = "127.0.0.1";

/**
 * A seam that refuses every call, loudly but over HTTP.
 *
 * Every call the spec cares about is intercepted in the browser before it is sent, so
 * this only has to cover a request that slips through — a route a later test adds and
 * forgets to stub. Answering with a 503 keeps the page under test alive to say what
 * went wrong; throwing would reset the connection and the browser would report
 * `ERR_CONNECTION_RESET`, which says nothing about which route was missed.
 */
const seam = new Proxy(
  {},
  {
    get: (_target, name) => async () => {
      process.stderr.write(`e2e page server: seam.${String(name)}() has no session host\n`);
      throw Object.assign(new Error("no session host in the e2e page server"), { status: 503 });
    },
  },
);

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${bind}:${port}`}`);
  void handleWebRequest(req, res, url, {
    seam,
    model: { provider: "deepseek", modelId: "deepseek-flash" },
    // The artifact origin the specs stub. The page's `img-src` names it so the comment
    // composer's crop preview can load, which is a real deployment rule and not a test
    // convenience: without it the preview silently fails to load and shows nothing.
    artifactsBaseUrl: "https://artifacts.example",
  })
    .then((handled) => {
      if (handled || res.headersSent) return;
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "not found" }));
    })
    .catch((error) => {
      if (res.headersSent) return;
      const status = typeof error?.status === "number" ? error.status : 500;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
    });
});

server.listen(port, bind, () => {
  process.stdout.write(`e2e page server listening on ${bind}:${port}\n`);
});
