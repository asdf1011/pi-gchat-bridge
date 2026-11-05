/**
 * The web routes, driven through a fake seam.
 *
 * The routes were extracted from `main.ts` so they could be served from either
 * process; these pin the two things extraction can silently break — that a route
 * still answers what it used to, and that the module stays out of the session
 * host's own surface (`/healthz`, `/notify`) so an adapter can never answer a
 * health probe on the host's behalf.
 */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { handleWebRequest, webPath } from "../src/adapter/web-routes.js";
import type { NamedConversation, SessionHost } from "../src/session-host/api.js";
import type { ProjectedView } from "../src/session-host/projection.js";

const view: ProjectedView = { liveText: "", busy: false, lastAssistantText: "", tools: [] };

function fakeSeam(
  options: { conversations?: NamedConversation[]; artifacts?: unknown[]; history?: unknown[] } = {},
): SessionHost {
  return {
    history: async (id: number) => (id === 1 ? (options.history ?? []) : undefined),
    list: async () => options.conversations ?? [],
    resolve: async () => undefined,
    snapshot: async () => view,
    attach: async (_id: number, onFrame: (v: ProjectedView) => void) => {
      onFrame(view);
      return { snapshot: view, detach() {} };
    },
    artifacts: async (id: number) => (id === 1 ? (options.artifacts ?? []) : undefined),
    submit: async (id: number, request: { content: unknown }) =>
      id === 1 ? { submissionId: 7 } : { error: `no such conversation: ${id}` },
  } as unknown as SessionHost;
}

interface Served {
  base: string;
  close(): Promise<void>;
}

/** A real socket, so the SSE and body-reading paths are exercised as they are. */
async function serve(seam: SessionHost, artifactsBaseUrl?: string): Promise<Served> {
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const handled = await handleWebRequest(req, res, url, {
        seam,
        model: { provider: "p", modelId: "m" },
        who: { email: "someone@example.com" },
        ...(artifactsBaseUrl === undefined ? {} : { artifactsBaseUrl }),
      });
      if (!handled) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "not found" }));
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("the root redirects to the app", async () => {
  const served = await serve(fakeSeam());
  try {
    const response = await fetch(`${served.base}/`, { redirect: "manual" });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/web/");

    // A proxy's mount prefix is stripped for *routes* but a bare "/pi/" is not a
    // route: it falls through to the caller's 404. Recorded rather than asserted
    // away, because the tunnel never sends it — cloudflared forwards "/" — and
    // inventing a redirect for it would hide a misconfigured proxy.
    const prefixed = await fetch(`${served.base}/pi/`, { redirect: "manual" });
    assert.equal(prefixed.status, 404);

    // The helper the routes use agrees with the production proxy shape.
    assert.equal(webPath("/pi/web/api/conversations"), "/web/api/conversations");
    assert.equal(webPath("/web/api/conversations"), "/web/api/conversations");
  } finally {
    await served.close();
  }
});

test("the environment route reports where artifacts live", async () => {
  const withBase = await serve(fakeSeam(), "https://artifacts.example/");
  try {
    const body = (await (await fetch(`${withBase.base}/web/api/environment`)).json()) as { artifactsBaseUrl: string };
    // Trailing slash trimmed: the page appends "/c/<id>/…" itself.
    assert.equal(body.artifactsBaseUrl, "https://artifacts.example");
  } finally {
    await withBase.close();
  }

  const without = await serve(fakeSeam());
  try {
    const body = (await (await fetch(`${without.base}/web/api/environment`)).json()) as { artifactsBaseUrl: string };
    // Empty means "no artifact host here", and the page hides its button.
    assert.equal(body.artifactsBaseUrl, "");
  } finally {
    await without.close();
  }
});

test("history comes back bounded, so an idle conversation is not a blank pane", async () => {
  const seam = fakeSeam({
    history: [
      { role: "user", text: "can you check the logs" },
      { role: "assistant", text: "Found it — the lock was stale." },
    ],
  });
  const served = await serve(seam);
  try {
    const rows = (await (await fetch(`${served.base}/web/api/c/1/history`)).json()) as {
      role: string;
      text: string;
    }[];
    assert.deepEqual(rows.map((row) => row.role), ["user", "assistant"]);
    assert.match(rows[1].text, /stale/);

    // The limit is clamped: a viewer cannot ask the host to serialise everything.
    const clamped = await fetch(`${served.base}/web/api/c/1/history?limit=99999`);
    assert.equal(clamped.status, 200);

    const missing = await fetch(`${served.base}/web/api/c/999/history`);
    assert.equal(missing.status, 404);
  } finally {
    await served.close();
  }
});

test("history arrives rendered, and the rendering cannot carry a script", async () => {
  const seam = fakeSeam({
    history: [
      { role: "assistant", text: "## Heading\n\nUse `npm test` — see [docs](https://example.com)." },
      { role: "user", text: "<img src=x onerror=alert(1)>" },
    ],
  });
  const served = await serve(seam);
  try {
    const rows = (await (await fetch(`${served.base}/web/api/c/1/history`)).json()) as {
      role: string;
      text: string;
      html: string;
    }[];
    // Markdown becomes real markup, and code spans stay code.
    assert.match(rows[0].html, /<h2>Heading<\/h2>/);
    assert.match(rows[0].html, /<code>npm test<\/code>/);
    assert.match(rows[0].html, /href="https:\/\/example.com"/);
    // Raw HTML in a message is escaped, never passed through: the page assigns
    // this into innerHTML, and this origin can submit messages.
    assert.ok(!rows[1].html.includes("<img"), rows[1].html);
    assert.match(rows[1].html, /&lt;img/);
  } finally {
    await served.close();
  }
});

test("the artifact list is same-origin, small, and says which files render", async () => {
  const seam = fakeSeam({
    artifacts: [
      { key: "docs/design.md", root: "/workspace", path: "/workspace/docs/design.md", wrote: 1, edited: 2 },
      { key: "src/app.ts", root: "/workspace", path: "/workspace/src/app.ts", wrote: 1, edited: 0 },
    ],
  });
  const served = await serve(seam);
  try {
    const rows = (await (await fetch(`${served.base}/web/api/c/1/artifacts`)).json()) as {
      key: string;
      wrote: number;
      edited: number;
      markdown: boolean;
    }[];
    assert.deepEqual(rows.map((row) => row.key), ["docs/design.md", "src/app.ts"]);
    // Markdown is the only thing the artifact host will render as HTML.
    assert.deepEqual(rows.map((row) => row.markdown), [true, false]);
    assert.equal(rows[0].wrote, 1);
    assert.equal(rows[0].edited, 2);

    const missing = await fetch(`${served.base}/web/api/c/999/artifacts`);
    assert.equal(missing.status, 404);
  } finally {
    await served.close();
  }
});

test("the conversation list and a submit still answer as before", async () => {
  const seam = fakeSeam({
    conversations: [{ conversationId: 1, name: "threads/A", model: "p/m", createdAt: 5 }],
  });
  const served = await serve(seam);
  try {
    const rows = (await (await fetch(`${served.base}/web/api/conversations`)).json()) as { chatKey: string }[];
    assert.deepEqual(rows.map((row) => row.chatKey), ["threads/A"]);

    const sent = await fetch(`${served.base}/web/api/c/1/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    assert.equal(sent.status, 202);
    // The echo carries the rendered message, so the pane can show what you sent
    // before the transcript comes back.
    assert.deepEqual(await sent.json(), { ok: true, submissionId: 7, html: "<p>hello</p>" });

    const missing = await fetch(`${served.base}/web/api/c/9/message`, {
      method: "POST",
      body: JSON.stringify({ text: "hello" }),
    });
    assert.equal(missing.status, 400);

    const badJson = await fetch(`${served.base}/web/api/c/1/message`, { method: "POST", body: "not json" });
    assert.equal(badJson.status, 400);
  } finally {
    await served.close();
  }
});

test("health and notify are not the adapter's to answer", async () => {
  const served = await serve(fakeSeam());
  try {
    for (const path of ["/healthz", "/notify"]) {
      const response = await fetch(`${served.base}${path}`, { method: path === "/notify" ? "POST" : "GET" });
      // Falls through to the caller's 404: the session host owns both, and an
      // adapter answering them would misreport which process is alive.
      assert.equal(response.status, 404, path);
    }
  } finally {
    await served.close();
  }
});
