/**
 * The browser page, driven in a real DOM without a browser.
 *
 * `test/web-page.test.ts` catches undeclared identifiers by reading the source.
 * This file is the layer above: it loads the actual page into jsdom, lets its
 * script run, and asserts what a person would see — that clicking a conversation
 * opens a stream, that a `text` frame paints the pane, that sending posts to the
 * right URL.
 *
 * The page needs exactly three endpoints and nothing else:
 *
 *     GET  api/conversations
 *     GET  api/c/:id/events     (SSE)
 *     POST api/c/:id/message
 *
 * So there is no bridge here, no SQLite and no Pub/Sub. A handful of stubs are
 * enough, which is the point: the page's contract with the server is small
 * enough to test exhaustively, and a failure here can only be the page.
 *
 * `EventSource` is stubbed rather than emulated because jsdom does not provide
 * one. The stub records instances so a test can push frames into them the way a
 * server would — that is what makes "a text frame paints the log" testable
 * without a socket.
 */
import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { JSDOM } from "jsdom";

import { WEB_PAGE } from "../src/adapter/web.js";

/** One recorded EventSource, so a test can emit frames on it. */
interface FakeSource {
  url: string;
  closed: boolean;
  listeners: Map<string, ((event: { data: string }) => void)[]>;
  emit(event: string, data: unknown): void;
  triggerError(): void;
}

interface Harness {
  dom: JSDOM;
  /** Tear down the window (stops the page's 30s poll). */
  close(): void;
  /** Every EventSource the page created, in order. */
  sources: FakeSource[];
  /** Every fetch the page made, with method and body. */
  requests: { url: string; method: string; body?: string }[];
  /** Console errors the page produced — an empty list is the pass condition. */
  errors: string[];
  /** Resolve pending microtasks so the page's async work completes. */
  settle(): Promise<void>;
}

/**
 * Load the page at `pathname` with the given canned responses.
 *
 * `conversations` is what `api/conversations` returns; everything else is
 * recorded so a test can assert on it.
 */
async function loadPage(
  options: {
    pathname?: string;
    conversations?: { conversationId: number; chatKey: string; model: string; name?: string }[];
    postStatus?: number;
  } = {},
): Promise<Harness> {
  const pathname = options.pathname ?? "/web/";
  const conversations = options.conversations ?? [];

  const sources: FakeSource[] = [];
  const requests: Harness["requests"] = [];
  const errors: string[] = [];

  // The stubs must exist BEFORE the page's script runs, and jsdom runs an inline
  // <script> during parsing. `beforeParse` is the only hook early enough — putting
  // them on `dom.window` afterwards threw "fetch is not defined" inside load(),
  // because the page calls it at the bottom of its own script.
  const dom = new JSDOM(WEB_PAGE, {
    url: `http://127.0.0.1:8081${pathname}`,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(win) {

      // EventSource: record instances, let tests emit frames.
      class StubEventSource {
        url: string;
        closed = false;
        listeners = new Map<string, ((event: { data: string }) => void)[]>();
        constructor(url: string) {
          this.url = url;
          sources.push(this as unknown as FakeSource);
        }
        addEventListener(event: string, fn: (event: { data: string }) => void) {
          const list = this.listeners.get(event) ?? [];
          list.push(fn);
          this.listeners.set(event, list);
        }
        close() {
          this.closed = true;
        }
        emit(event: string, data: unknown) {
          for (const fn of this.listeners.get(event) ?? []) fn({ data: JSON.stringify(data) });
        }
        triggerError() {
          for (const fn of this.listeners.get("error") ?? []) fn({ data: "" });
        }
      }
      (win as unknown as Record<string, unknown>).EventSource = StubEventSource;

      // jsdom implements no fetch at all, so this is not optional.
      (win as unknown as Record<string, unknown>).fetch = async (
        input: unknown,
        init?: { method?: string; body?: string },
      ) => {
        const url = String(input);
        requests.push({ url, method: init?.method ?? "GET", ...(init?.body ? { body: init.body } : {}) });
        if (url.endsWith("api/conversations")) {
          return { ok: true, status: 200, json: async () => conversations };
        }
        if (url.includes("/message")) {
          return { ok: true, status: options.postStatus ?? 202, json: async () => ({ ok: true }) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      };
    },
  });

  // Collect uncaught errors the way a browser console would show them.
  dom.window.addEventListener("error", (event) => {
    errors.push(String((event as ErrorEvent).message ?? event));
  });
  dom.virtualConsole.on("jsdomError", (error) => errors.push(String(error.message)));

  // The page calls load() at parse time; let it finish.
  const settle = async () => {
    for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  await settle();

  return {
    dom,
    sources,
    requests,
    errors,
    settle,
    close() {
      // Stop the page's own setInterval, or the process never exits: jsdom holds
      // the timer, node sees a live handle, and `tsx --test` hangs after the last
      // assertion. That is why every test below closes its harness even when it
      // asserts nothing about teardown.
      dom.window.close();
    },
  };
}

/** The conversation rows currently rendered. */
function rows(h: Harness): HTMLElement[] {
  return [...h.dom.window.document.querySelectorAll("#list li")] as HTMLElement[];
}

// --- Loading -----------------------------------------------------------------

test("the page renders one row per conversation", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({
      conversations: [
        { conversationId: 7, chatKey: "spaces/A/threads/T1", model: "deepseek/deepseek-flash", name: "deploy notes" },
        { conversationId: 9, chatKey: "spaces/A/threads/T2", model: "llama-local/lfm3" },
      ],
    });
    assert.deepEqual(h.errors, []);
    const list = rows(h);
    assert.equal(list.length, 2);
    // A named conversation shows its name; an unnamed one falls back to the key.
    assert.equal(list[0]?.querySelector("span")?.textContent, "deploy notes");
    assert.equal(list[1]?.querySelector("span")?.textContent, "spaces/A/threads/T2");
    // The second line carries the id and model.
    assert.equal(list[0]?.querySelector("small")?.textContent, "#7 · deepseek/deepseek-flash");
  } finally {
    h?.close();
  }
});

test("an empty index renders no rows and opens no stream", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({ conversations: [] });
    assert.deepEqual(h.errors, []);
    assert.equal(rows(h).length, 0);
    assert.equal(h.sources.length, 0);
  } finally {
    h?.close();
  }
});

test("the first conversation opens automatically", async () => {
  let h: Harness | undefined;
  try {
    // This is the behaviour that makes the page useful on load — and the code path
    // that threw `source is not defined` before it was fixed.
    h = await loadPage({
      conversations: [
        { conversationId: 7, chatKey: "k1", model: "m" },
        { conversationId: 9, chatKey: "k2", model: "m" },
      ],
    });
    assert.deepEqual(h.errors, []);
    assert.equal(h.sources.length, 1, "the first row must be clicked on load");
    assert.match(h.sources[0]!.url, /api\/c\/7\/events$/);
    assert.equal(rows(h)[0]?.classList.contains("on"), true);
  } finally {
    h?.close();
  }
});

// --- Streaming ---------------------------------------------------------------

test("a text frame paints the answer pane", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({ conversations: [{ conversationId: 7, chatKey: "k", model: "m" }] });
    const log = h.dom.window.document.getElementById("log")!;
    h.sources[0]!.emit("text", { text: "hello from the model", busy: true });
    // The pane labels each block, so assert on the live message's body: history
    // and the answer share #log, and the label is presentation.
    const live = log.querySelector(".msg.live")!;
    assert.equal(live.lastChild!.textContent, "hello from the model");
    assert.equal(live.querySelector(".who")!.textContent, "pi");
  } finally {
    h?.close();
  }
});

test("a later text frame replaces the earlier one, not appends", async () => {
  let h: Harness | undefined;
  try {
    // Frames are whole snapshots, which is what makes a dropped frame harmless.
    h = await loadPage({ conversations: [{ conversationId: 7, chatKey: "k", model: "m" }] });
    const log = h.dom.window.document.getElementById("log")!;
    h.sources[0]!.emit("text", { text: "first" });
    h.sources[0]!.emit("text", { text: "second" });
    assert.equal(log.querySelectorAll(".msg.live").length, 1, "one live block, not two");
    assert.equal(log.querySelector(".msg.live")!.lastChild!.textContent, "second");
  } finally {
    h?.close();
  }
});

test("a tool frame shows the tool, and null clears it", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({ conversations: [{ conversationId: 7, chatKey: "k", model: "m" }] });
    const tool = h.dom.window.document.getElementById("tool")!;
    h.sources[0]!.emit("tool", { name: "bash", status: "running" });
    assert.equal(tool.textContent, "bash · running");
    h.sources[0]!.emit("tool", null);
    assert.equal(tool.textContent, "");
  } finally {
    h?.close();
  }
});

test("a stream error says reconnecting rather than going blank", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({ conversations: [{ conversationId: 7, chatKey: "k", model: "m" }] });
    const tool = h.dom.window.document.getElementById("tool")!;
    h.sources[0]!.triggerError();
    assert.equal(tool.textContent, "reconnecting…");
  } finally {
    h?.close();
  }
});

test("switching conversation closes the old stream and opens the new one", async () => {
  let h: Harness | undefined;
  try {
    // A leaked EventSource keeps painting a conversation nobody is looking at.
    h = await loadPage({
      conversations: [
        { conversationId: 7, chatKey: "k1", model: "m" },
        { conversationId: 9, chatKey: "k2", model: "m" },
      ],
    });
    rows(h)[1]!.click();
    assert.equal(h.sources[0]!.closed, true, "the previous stream must be closed");
    assert.equal(h.sources.length, 2);
    assert.match(h.sources[1]!.url, /api\/c\/9\/events$/);
    assert.equal(rows(h)[1]?.classList.contains("on"), true);
    assert.equal(rows(h)[0]?.classList.contains("on"), false);
  } finally {
    h?.close();
  }
});

// --- Sending -----------------------------------------------------------------

test("submitting posts the text to the open conversation", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({ conversations: [{ conversationId: 7, chatKey: "k", model: "m" }] });
    const doc = h.dom.window.document;
    (doc.getElementById("text") as HTMLTextAreaElement | HTMLInputElement).value = "  hello  ";
    doc.getElementById("send")!.dispatchEvent(new h.dom.window.Event("submit", { cancelable: true }));
    await h.settle();

    const post = h.requests.find((r) => r.method === "POST");
    assert.ok(post, "expected a POST");
    assert.match(post.url, /api\/c\/7\/message$/);
    // Trimmed on the way out.
    assert.deepEqual(JSON.parse(post.body!), { text: "hello" });
  } finally {
    h?.close();
  }
});

test("the box is cleared after sending", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({ conversations: [{ conversationId: 7, chatKey: "k", model: "m" }] });
    const doc = h.dom.window.document;
    const box = doc.getElementById("text") as HTMLInputElement;
    box.value = "hello";
    doc.getElementById("send")!.dispatchEvent(new h.dom.window.Event("submit", { cancelable: true }));
    await h.settle();
    assert.equal(box.value, "");
  } finally {
    h?.close();
  }
});

test("an empty box sends nothing", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({ conversations: [{ conversationId: 7, chatKey: "k", model: "m" }] });
    const doc = h.dom.window.document;
    (doc.getElementById("text") as HTMLInputElement).value = "   ";
    doc.getElementById("send")!.dispatchEvent(new h.dom.window.Event("submit", { cancelable: true }));
    await h.settle();
    assert.equal(
      h.requests.filter((r) => r.method === "POST").length,
      0,
    );
  } finally {
    h?.close();
  }
});

// --- Mount points ------------------------------------------------------------

test("API paths resolve under a reverse-proxy prefix", async () => {
  let h: Harness | undefined;
  try {
    // The page is mount-agnostic: served at /pi/web, its fetches must go to
    // /pi/web/api/... and not to the proxy's root.
    h = await loadPage({ pathname: "/pi/web/", conversations: [] });
    assert.deepEqual(h.errors, []);
    const urls = h.requests.map((request) => request.url);
    // Every request stays under the proxy's prefix — including the environment
    // probe the artifact button needs, which is fetched once at load.
    for (const url of urls) assert.ok(url.startsWith("/pi/web/api/"), url);
    assert.ok(urls.includes("/pi/web/api/conversations"), urls.join(", "));
    assert.ok(urls.includes("/pi/web/api/environment"), urls.join(", "));
  } finally {
    h?.close();
  }
});

test("a path without a trailing slash is normalised before loading", async () => {
  let h: Harness | undefined;
  try {
    // Otherwise relative paths resolve one level too high and 404.
    h = await loadPage({ pathname: "/web" });
    assert.equal(
      h.requests.filter((r) => r.url.includes("api/conversations")).length,
      0,
      "no API call should happen before the URL is normalised",
    );
  } finally {
    h?.close();
  }
});
