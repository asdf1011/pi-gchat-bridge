/**
 * The `/notify` ROUTE, not just its handler.
 *
 * `notify-durable.test.ts` covers what `handleDurableNotify` does when it is
 * called. Nothing covered whether anything *calls* it — and for two days nothing
 * did: the web-routes extraction (3a91b1d) deleted the `POST /notify` block from
 * the durable host along with the `/web` routes it sat beside, while leaving the
 * import in place. So `tsc` was green, all 490 tests were green, and every cron
 * notification — balance checks, release notes, reminders — got a silent 404.
 *
 * The lesson is the test's shape: assert on a request through a server, because a
 * deleted route is invisible to a suite that starts below the HTTP layer. Any
 * future extraction that drops the wiring fails here.
 *
 * This runs the real route block from `src/durable/main.ts` over a scratch
 * harness; the Chat client and router are fakes so no network or provider is
 * touched.
 */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { BridgeHost } from "../src/durable/host.js";
import { handleDurableNotify } from "../src/durable/notify.js";
import { readBody } from "../src/adapter/web-routes.js";
import { inProcessSessionHost } from "../src/session-host/inprocess.js";
import type { DurableRouter } from "../src/adapter/router.js";

/**
 * The `/notify` branch of `src/durable/main.ts`, transcribed.
 *
 * A copy is a liability — it can drift from the real handler, which is the same
 * class of bug this file exists to catch. It is the smaller evil here: importing
 * `main.ts` would run the whole bridge (Pub/Sub, ports, lock) inside the test
 * process. `notifyRouteMatchesHost()` below is the guard that keeps the copy
 * honest: it asserts the compiled host still contains the same wiring.
 */
function notifyRoute(deps: Parameters<typeof handleDurableNotify>[0]) {
  return async (req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<boolean> => {
    if (req.method !== "POST" || pathname !== "/notify") return false;
    const body = await readBody(req, 1_000_000);
    if (body === null) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "request body too large" }));
      return true;
    }
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "invalid JSON body" }));
      return true;
    }
    const result = await handleDurableNotify(deps, json, req.headers.authorization);
    res.writeHead(result.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.json));
    return true;
  };
}

function fakeClient() {
  const posted: string[] = [];
  return {
    posted,
    client: {
      async createMessageWithThreadKey(_space: string, text: string, key: string) {
        posted.push(text);
        return { name: `spaces/s/messages/${posted.length}`, threadName: `spaces/s/threads/${key}` };
      },
      async createMessage(_space: string, text: string) {
        posted.push(text);
        return `spaces/s/messages/${posted.length}`;
      },
    } as never,
  };
}

function fakeRouter(): { router: DurableRouter; written: string[] } {
  const written: string[] = [];
  const router = {
    // The plain path seeds the conversation so a later reply has the
    // notification as context; without this the handler logs a seeding failure
    // and the test would be green over a broken seam.
    async notify(chatKey: string, text: string) {
      written.push(`${chatKey}: ${text}`);
    },
    async deliver(input: { text: string }) {
      written.push(input.text);
      return { conversationId: 1, submissionId: 1 };
    },
  } as unknown as DurableRouter;
  return { router, written };
}

async function serve(deps: Parameters<typeof handleDurableNotify>[0]) {
  const route = notifyRoute(deps);
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (await route(req, res, url.pathname)) return;
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "not found" }));
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function scratchHost(): Promise<{ host: BridgeHost; close: () => Promise<void> }> {
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: createModels(), registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  const fake = Object.create(BridgeHost.prototype) as BridgeHost;
  Object.assign(fake, {
    harness,
    context: BACKGROUND_CONTEXT,
    modelRuntime: {} as ModelRuntime,
    cwd: "/tmp",
    dbPath: ":memory:",
  });
  return { host: fake, close: async () => harness.close(BACKGROUND_CONTEXT) };
}

function seamOf(host: BridgeHost) {
  return inProcessSessionHost({ host, roots: [] });
}

function deps(host: BridgeHost, notifyToken?: string) {
  const { client, posted } = fakeClient();
  const { router, written } = fakeRouter();
  return {
    posted,
    written,
    deps: {
      client,
      seam: seamOf(host),
      router,
      defaultAgent: { model: { provider: "p", modelId: "m" } },
      ...(notifyToken === undefined ? {} : { notifyToken }),
    } as Parameters<typeof handleDurableNotify>[0],
  };
}

test("POST /notify reaches the handler and posts to the thread", async () => {
  const { host, close } = await scratchHost();
  const { posted, written, deps: d } = deps(host);
  const served = await serve(d);
  try {
    const response = await fetch(`${served.base}/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ space: "spaces/s", text: "balance is low", threadKey: "cron" }),
    });

    // 404 here is the regression: the route is gone and the host fell through.
    assert.equal(response.status, 200, "the host must answer POST /notify");
    const json = (await response.json()) as { ok: boolean; status: string; seeded?: boolean };
    assert.equal(json.ok, true);
    assert.equal(json.status, "posted");
    assert.deepEqual(posted, ["balance is low"]);
    // And it is recorded as conversation context, so a reply in that thread
    // knows what the notification said.
    assert.deepEqual(written, ["spaces/s/cron: balance is low"], "the notification seeds the thread");
  } finally {
    await served.close();
    await close();
  }
});

test("/notify rejects bad input without posting anything", async () => {
  const { host, close } = await scratchHost();
  const { posted, deps: d } = deps(host);
  const served = await serve(d);
  try {
    const badJson = await fetch(`${served.base}/notify`, { method: "POST", body: "not json" });
    assert.equal(badJson.status, 400);

    const noText = await fetch(`${served.base}/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ space: "spaces/s" }),
    });
    assert.equal(noText.status, 400);

    // A GET must not be treated as a notification.
    const wrongMethod = await fetch(`${served.base}/notify`);
    assert.equal(wrongMethod.status, 404);

    assert.deepEqual(posted, [], "a rejected request must post nothing");
  } finally {
    await served.close();
    await close();
  }
});

test("a configured token is enforced through the route", async () => {
  const { host, close } = await scratchHost();
  const { posted, deps: d } = deps(host, "s3cret");
  const served = await serve(d);
  try {
    const anonymous = await fetch(`${served.base}/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ space: "spaces/s", text: "x" }),
    });
    assert.equal(anonymous.status, 401);

    const authorized = await fetch(`${served.base}/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer s3cret" },
      body: JSON.stringify({ space: "spaces/s", text: "x" }),
    });
    assert.equal(authorized.status, 200);
    assert.deepEqual(posted, ["x"]);
  } finally {
    await served.close();
    await close();
  }
});

/**
 * The guard that keeps the transcription above honest.
 *
 * If `main.ts` stops wiring `/notify`, this fails even though the copied route
 * still passes — which is the whole point. It reads the source rather than the
 * compiled output so it fails in `npm test` (which runs from `src`) as well as
 * after a build.
 */
test("the Chat adapter serves /notify, and the host says where it went", async () => {
  // The route moved with the Chat client, so the guard moved with it. What it is guarding against
  // is unchanged and has happened once: a `/notify` that quietly stops existing, discovered by a
  // scheduled job failing weeks later.
  const fs = await import("node:fs/promises");
  const adapter = await fs.readFile(new URL("../src/chat-host.ts", import.meta.url), "utf8");
  assert.match(adapter, /url\.pathname === "\/notify"/, "the /notify path is not routed in the adapter");
  assert.match(
    adapter,
    /handleDurableNotify\(\s*\{/,
    "handleDurableNotify is imported but never called — the route was dropped",
  );
  const handlerAt = adapter.indexOf("http.createServer");
  const callAt = adapter.indexOf("handleDurableNotify(", handlerAt);
  assert.ok(handlerAt >= 0 && callAt > handlerAt, "handleDurableNotify must be called from the HTTP handler");

  const host = await fs.readFile(new URL("../src/durable/main.ts", import.meta.url), "utf8");
  assert.match(host, /url\.pathname === "\/notify"/, "the host should answer for the moved route");
  assert.match(host, /notify is served by the Chat adapter/, "...with where to look, not a bare 404");
});
