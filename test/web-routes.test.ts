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

import { apiPath, handleWebRequest, webPath } from "../src/adapter/web-routes.js";
import type { NamedConversation, SessionHost } from "../src/session-host/api.js";
import type { ProjectedView } from "../src/session-host/projection.js";

const view: ProjectedView = { liveText: "", busy: false, lastAssistantText: "", tools: [] };

const announced: string[] = [];
const submitted: unknown[] = [];

function fakeSeam(
  options: { conversations?: NamedConversation[]; artifacts?: unknown[]; history?: unknown[] } = {},
): SessionHost {
  return {
    history: async (id: number) => (id === 1 ? (options.history ?? []) : undefined),
    image: async (id: number, entryId: number, index: number) =>
      id === 1 && entryId === 5 && index === 0
        ? { mimeType: "image/png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64") }
        : undefined,
    announce: async (_id: number, text: string) => {
      announced.push(text);
      return true;
    },
    list: async () => options.conversations ?? [],
    resolve: async () => undefined,
    snapshot: async () => view,
    attach: async (_id: number, onFrame: (v: ProjectedView) => void) => {
      onFrame(view);
      return { snapshot: view, detach() {} };
    },
    artifacts: async (id: number) => (id === 1 ? (options.artifacts ?? []) : undefined),
    submit: async (id: number, request: { content: unknown }) => {
      submitted.push(request.content);
      return id === 1 ? { submissionId: 7 } : { error: `no such conversation: ${id}` };
    },
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

test("the root and a conversation URL both serve the page", async () => {
  const served = await serve(fakeSeam());
  try {
    for (const path of ["/", "/web/", "/7/", "/7"]) {
      const response = await fetch(`${served.base}${path}`, { redirect: "manual" });
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get("content-type") ?? "", /text\/html/, path);
      // One document, two modes: the script reads the id out of the URL.
      assert.match(await response.text(), /id="index"/, path);
    }

    // A mount prefix is still stripped for API routes, and a bare prefixed root
    // is not a page: cloudflared forwards "/", and inventing a route for "/pi/"
    // would hide a proxy that is not stripping what it should.
    assert.equal((await fetch(`${served.base}/pi/`, { redirect: "manual" })).status, 404);
    assert.equal(webPath("/pi/web/api/conversations"), "/web/api/conversations");
    // The page resolves API calls against the mount root, so the same route has to
    // answer at "/api/..." and at "/web/api/..." depending on where it is mounted.
    assert.equal(apiPath("/api/conversations"), "/api/conversations");
    assert.equal(apiPath("/pi/web/api/c/7/history"), "/api/c/7/history");
  } finally {
    await served.close();
  }
});

test("the API answers at the mount root as well as under /web", async () => {
  const served = await serve(fakeSeam());
  try {
    // The page at "/32/" asks for "/api/..."; the same page behind a prefix asks
    // for "/pi/web/api/...". Both name the same route.
    for (const path of ["/api/environment", "/web/api/environment", "/pi/web/api/environment"]) {
      const response = await fetch(`${served.base}${path}`);
      assert.equal(response.status, 200, path);
    }
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

test("a pasted image reaches the host as a content part", async () => {
  const served = await serve(fakeSeam());
  try {
    submitted.length = 0;
    announced.length = 0;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
    const response = await fetch(`${served.base}/web/api/c/1/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "look", images: [{ data: png, mimeType: "image/png" }] }),
    });
    assert.equal(response.status, 202);

    // Text first, then the image, as Chat sends it: the transcript and the model
    // both see the same shape.
    assert.deepEqual(submitted[0], [
      { type: "text", text: "look" },
      { type: "image", data: png, mimeType: "image/png" },
    ]);
    // And the Chat thread's notice says an image came with it.
    assert.equal(announced[0], "someone (webui): look [1 image]");
  } finally {
    await served.close();
  }
});

test("a non-image or oversized attachment is refused", async () => {
  const served = await serve(fakeSeam());
  try {
    const notImage = await fetch(`${served.base}/web/api/c/1/message`, {
      method: "POST",
      body: JSON.stringify({ text: "x", images: [{ data: "aGk=", mimeType: "text/html" }] }),
    });
    assert.equal(notImage.status, 400);

    const tooBig = await fetch(`${served.base}/web/api/c/1/message`, {
      method: "POST",
      body: JSON.stringify({
        text: "x",
        images: [{ data: Buffer.alloc(9 * 1024 * 1024).toString("base64"), mimeType: "image/png" }],
      }),
    });
    assert.equal(tooBig.status, 400);
  } finally {
    await served.close();
  }
});

test("an image is served as bytes, with its own content type", async () => {
  const served = await serve(fakeSeam());
  try {
    const response = await fetch(`${served.base}/web/api/c/1/image/5/0`);
    assert.equal(response.status, 200);
    // The browser must not be told this is text: an image served as anything else
    // either renders as mojibake or refuses to render at all.
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("cache-control"), "private, max-age=3600");
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual([...bytes], [0x89, 0x50, 0x4e, 0x47]);

    assert.equal((await fetch(`${served.base}/web/api/c/1/image/9/9`)).status, 404);
  } finally {
    await served.close();
  }
});

test("a conversation is listed by title, else by its opening words, else by key", async () => {
  const served = await serve(
    fakeSeam({
      conversations: [
        { conversationId: 1, name: "threads/titled", label: "Disk images", model: "p/m", createdAt: 1 },
        { conversationId: 2, name: "threads/preview", preview: "how do I shrink a disk image…", model: "p/m", createdAt: 2 },
        { conversationId: 3, name: "threads/bare", model: "p/m", createdAt: 3 },
      ],
    }),
  );
  try {
    const page = (await (await fetch(`${served.base}/api/conversations`)).json()) as {
      items: { chatKey: string; name?: string }[];
    };
    assert.deepEqual(page.items.map((item) => item.name), [
      "Disk images",
      "how do I shrink a disk image…",
      undefined,
    ]);
    // The key is still there for anything that needs an address.
    assert.deepEqual(page.items.map((item) => item.chatKey), ["threads/titled", "threads/preview", "threads/bare"]);
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
    // The list is paged now: `{items, more, offset, limit}`.
    const page = (await (await fetch(`${served.base}/web/api/conversations`)).json()) as {
      items: { chatKey: string }[];
      more: boolean;
    };
    assert.deepEqual(page.items.map((row) => row.chatKey), ["threads/A"]);
    assert.equal(page.more, false);

    announced.length = 0;
    const sent = await fetch(`${served.base}/web/api/c/1/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    assert.equal(sent.status, 202);
    // The echo carries the rendered message, so the pane can show what you sent
    // before the transcript comes back.
    assert.deepEqual(await sent.json(), { ok: true, submissionId: 7, html: "<p>hello</p>" });

    // The Chat thread learns who spoke and what they said, so it reads as a
    // conversation the person can follow from either surface.
    assert.deepEqual(announced, ["someone (webui): hello"]);

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

test("the environment reports a page version, so a client can tell it changed", async () => {
  const served = await serve(fakeSeam());
  try {
    const first = (await (await fetch(`${served.base}/web/api/environment`)).json()) as { pageVersion: string };
    const second = (await (await fetch(`${served.base}/web/api/environment`)).json()) as { pageVersion: string };

    assert.match(first.pageVersion, /^[0-9a-f]{12}$/, "a short fingerprint, not a timestamp");
    // Stable for the life of the process: a page that compared this on every
    // reconnect and saw it change every time would reload in a loop.
    assert.equal(first.pageVersion, second.pageVersion);
  } finally {
    await served.close();
  }
});
