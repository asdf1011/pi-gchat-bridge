/**
 * A stand-in adapter, for the supervision test.
 *
 * It does the three things a real adapter does and nothing else: connect over the IPC channel, answer
 * one question through the linked seam, and serve one HTTP route. That is enough to prove the wiring
 * the deployment depends on — that a *new* child generation gets its own link, and that what it can
 * see lives in the host rather than in itself.
 */
import http from "node:http";

import { createHost, ipcLink } from "@earendil-works/chord";

import { linkSessionHost } from "../../src/session-host/link.js";

const port = Number(process.env.FIXTURE_PORT ?? 0);

const client = createHost({
  self: "fixture-adapter",
  name: "fixture-adapter",
  kind: "client",
  upstream: {
    link: ipcLink(process as unknown as Parameters<typeof ipcLink>[0]),
    principal: "session-host",
  },
});
const seam = linkSessionHost({ host: client });

const server = http.createServer((req, res) => {
  void (async () => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }
    if (req.url === "/state") {
      // Read *through the link*: if this answers, the host is reachable from a child generation.
      const info = await seam.info();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ pid: process.pid, cwd: info.cwd, dbPath: info.dbPath }));
      return;
    }
    res.writeHead(404);
    res.end();
  })();
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`FIXTURE_ADAPTER_LISTENING 127.0.0.1:${port}\n`);
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
});
