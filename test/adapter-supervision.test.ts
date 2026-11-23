/**
 * The supervision wiring, with real children.
 *
 * The fork + `ipcLink` + chord-accept path used to be exercised only in production, which is the one
 * place a mistake costs a surface instead of a test run. Everything here is the code `main.ts` runs —
 * `forkAdapter`, the supervisor, `acceptAdapterLink` — against a real child process and a real link
 * pair, with a fake seam so no store or model is involved.
 *
 * What it proves, in the order the deployment would hit it:
 *
 *   1. a child that starts can reach the host through its link;
 *   2. killing it does not stop the supervisor, which starts a *second* generation;
 *   3. the second generation gets its own link — a dead child's channel is gone, and reusing it would
 *      leave the adapter serving a host it can no longer talk to;
 *   4. what the child reads lives in the host, so a restart of the adapter is invisible to it.
 */
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";

import { createHost, memoryLinkPair } from "@earendil-works/chord";

import { acceptAdapterLink, forkAdapter } from "../src/session-host/fork-adapter.js";
import { serveSessionHost } from "../src/session-host/link.js";
import type { SessionHost } from "../src/session-host/api.js";

/** A seam with no store behind it: two facts a child can read back. */
function fakeSeam(): SessionHost {
  return {
    info: async () => ({ dbPath: "/tmp/fixture.sqlite", cwd: process.cwd(), startedAt: 1 }),
    attach: async () => ({ snapshot: {}, detach() {} }),
    models: async () => [],
    list: async () => [],
  } as unknown as SessionHost;
}

/** A port nobody is using, so the child can bind it and the test can talk to it. */
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path, timeout: 2000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timed out")));
  });
}

/** Poll until the child answers, or give up: a forked process is not ready when `fork` returns. */
async function eventually(port: number, path: string, ms = 30_000): Promise<string> {
  const deadline = Date.now() + ms;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await get(port, path);
      if (response.status === 200) return response.body;
      last = response.status;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`adapter never answered ${path} (last: ${String(last)})`);
}

test("a forked adapter reaches the host, and its replacement gets a fresh link", { timeout: 120_000 }, async () => {
  const objectHost = serveSessionHost(fakeSeam());
  const port = await freePort();
  const ready = Promise.withResolvers<void>();

  const supervisor = forkAdapter(
    {
      entry: new URL("./fixtures/link-adapter.ts", import.meta.url),
      // The fixture is TypeScript, so the child runs under the same loader this test does.
      execArgv: ["--import", "tsx"],
      env: { FIXTURE_PORT: String(port) },
      marker: "FIXTURE_ADAPTER_LISTENING ",
      onReady: () => ready.resolve(),
      log: () => {},
    },
    (child) => acceptAdapterLink(objectHost, child, "fixture-adapter"),
  );

  try {
    const first = JSON.parse(await eventually(port, "/state")) as { pid: number; cwd: string };
    assert.equal(first.cwd, process.cwd(), "the child read the host's info through its link");

    // Kill it the way a deploy does: no warning, no cleanup.
    const child = supervisor.current();
    assert.ok(child?.pid, "a child is running");
    child!.kill("SIGKILL");

    // The same port, answered by a *different* process: the supervisor restarted it, and the new
    // generation was given its own link (otherwise `/state` could not reach the host at all).
    const deadline = Date.now() + 30_000;
    let second: { pid: number; cwd: string } | undefined;
    while (Date.now() < deadline) {
      const body = await eventually(port, "/state").catch(() => undefined);
      if (body) {
        const parsed = JSON.parse(body) as { pid: number; cwd: string };
        if (parsed.pid !== first.pid) {
          second = parsed;
          break;
        }
      }
    }
    assert.ok(second, "a second generation answered");
    assert.notEqual(second!.pid, first.pid, "it is a new process, not the old one");
    assert.equal(second!.cwd, first.cwd, "and it reads the same host state");
  } finally {
    supervisor.stop();
  }
});

test("a link that dies is treated as a crash: the stranded adapter is replaced", { timeout: 120_000 }, async () => {
  const objectHost = serveSessionHost(fakeSeam());
  const port = await freePort();

  const supervisor = forkAdapter(
    {
      entry: new URL("./fixtures/link-adapter.ts", import.meta.url),
      execArgv: ["--import", "tsx"],
      env: { FIXTURE_PORT: String(port) },
      marker: "FIXTURE_ADAPTER_LISTENING ",
      log: () => {},
    },
    (child) => acceptAdapterLink(objectHost, child, "fixture-adapter"),
  );

  try {
    const first = JSON.parse(await eventually(port, "/state")) as { pid: number };

    // Close the host's side of the link, which is what a keepalive timeout does. The child is still
    // running and still accepting HTTP, so nothing but this wiring can notice that it can no longer
    // reach the host — the exact state that left the web and Chat adapters serving 500s until the
    // bridge was restarted by hand.
    await objectHost.invalidatePrincipal((principal: unknown) => principal === "fixture-adapter");

    // Not just "answers again" — it answered before, by hanging. The proof is a new pid: the host
    // killed the stranded generation and the supervisor forked one with a fresh channel.
    const deadline = Date.now() + 30_000;
    let second: { pid: number } | undefined;
    while (Date.now() < deadline) {
      const body = await eventually(port, "/state").catch(() => undefined);
      if (body) {
        const parsed = JSON.parse(body) as { pid: number };
        if (parsed.pid !== first.pid) {
          second = parsed;
          break;
        }
      }
    }
    assert.ok(second, "a second generation answered — the stranded one was replaced");
  } finally {
    supervisor.stop();
  }
});

test("a chord host accepts more than one generation, one link each", async () => {
  // The narrower claim, without a process: two links from one host, both usable. If `accept` were
  // once-only, the second adapter generation would start and then fail every call.
  const objectHost = serveSessionHost(fakeSeam());
  const clients = [0, 1].map(() => {
    const [down, up] = memoryLinkPair();
    objectHost.accept(down, { principal: "fixture-adapter", kind: "client" });
    return createHost({
      self: "fixture-adapter",
      name: "fixture-adapter",
      kind: "client",
      upstream: { link: up, principal: "session-host" },
    });
  });

  const { linkSessionHost } = await import("../src/session-host/link.js");
  for (const client of clients) {
    const seam = linkSessionHost({ host: client });
    const info = await seam.info();
    assert.equal(info.cwd, process.cwd());
  }
});
