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
  /** Each history request's paging parameters, in order. */
  historyRequests: { limit: number; offset: number }[];
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
    /** Whether the fake server claims another page exists after this one. */
    more?: boolean;
    /** Messages the fake host returns for one conversation's history. */
    history?: { role: string; text: string; at?: number; html: string; entryId?: number; images?: { mimeType: string }[] }[];
    /** Page version the fake server reports; a different value asks for a reload. */
    pageVersion?: string;
    /** Draft text to seed into localStorage before the page's script runs. */
    draft?: { conversationId: number; text: string };
    postStatus?: number;
    /** The artifact host's address, and the files this conversation is said to have written. */
    artifactsBaseUrl?: string;
    artifacts?: { key: string; markdown?: boolean; wrote?: number; edited?: number }[];
    /** A URL fragment, as a reload would arrive with one. */
    hash?: string;
    /** What the fake answers `POST api/c/<id>/commands` with. */
    commandResponse?: unknown;
  } = {},
): Promise<Harness> {
  // Conversation mode: the URL carries the conversation id.
  const pathname = options.pathname ?? "/7/";
  const conversations = options.conversations ?? [];

  const sources: FakeSource[] = [];
  const requests: Harness["requests"] = [];
  const errors: string[] = [];
  /** Every history request, so a test can assert how it paged. */
  const historyRequests: { limit: number; offset: number }[] = [];

  // The stubs must exist BEFORE the page's script runs, and jsdom runs an inline
  // <script> during parsing. `beforeParse` is the only hook early enough — putting
  // them on `dom.window` afterwards threw "fetch is not defined" inside load(),
  // because the page calls it at the bottom of its own script.
  const dom = new JSDOM(WEB_PAGE, {
    url: `http://127.0.0.1:8081${pathname}${options.hash ?? ""}`,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(win) {

      // EventSource: record instances, let tests emit frames.
      class StubEventSource {
        url: string;
        closed = false;
        /**
         * `readyState`, so the page's own reconnect can be tested: the browser stops retrying
         * permanently once a stream closes, and the pane has to notice that rather than wait.
         */
        readyState = 1;
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
          this.readyState = 2; // EventSource.CLOSED
        }
        emit(event: string, data: unknown) {
          for (const fn of this.listeners.get(event) ?? []) fn({ data: JSON.stringify(data) });
        }
        triggerError() {
          for (const fn of this.listeners.get("error") ?? []) fn({ data: "" });
        }
      }
      (win as unknown as Record<string, unknown>).EventSource = StubEventSource;

      // A draft that was saved before a reload, as localStorage would hold it.
      if (options.draft) {
        win.localStorage.setItem(`pi-draft:${options.draft.conversationId}`, options.draft.text);
      }

      // jsdom implements no fetch at all, so this is not optional.
      (win as unknown as Record<string, unknown>).fetch = async (
        input: unknown,
        init?: { method?: string; body?: string },
      ) => {
        const url = String(input);
        requests.push({ url, method: init?.method ?? "GET", ...(init?.body ? { body: init.body } : {}) });
        if (url.includes("api/conversations")) {
          // The paged shape, which is what the index and the sidebar read.
          return { ok: true, status: 200, json: async () => ({ items: conversations, more: options.more ?? false }) };
        }
        const one = /\/api\/c\/(\d+)$/.exec(url);
        if (one) {
          const found = conversations.find((c) => c.conversationId === Number(one[1]));
          return { ok: Boolean(found), status: found ? 200 : 404, json: async () => found ?? {} };
        }
        if (url.includes("/history")) {
          // Paged the way the real route pages: `offset` counts back from the
          // newest message. Honouring it matters — a stub that always returned
          // the full list would report every first page as "short" and the page
          // would decide it had reached the beginning of the conversation.
          const all = options.history ?? [];
          const query = new URL(url, "http://127.0.0.1").searchParams;
          const limit = Number(query.get("limit") ?? 50) || 50;
          const offset = Math.max(0, Number(query.get("offset") ?? 0) || 0);
          historyRequests.push({ limit, offset });
          const end = Math.max(0, all.length - offset);
          const start = Math.max(0, end - limit);
          return { ok: true, status: 200, json: async () => all.slice(start, end) };
        }
        if (url.endsWith("api/environment")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              artifactsBaseUrl: options.artifactsBaseUrl ?? "",
              pageVersion: options.pageVersion ?? "v1",
            }),
          };
        }
        if (/\/api\/c\/\d+\/artifacts$/.test(url)) {
          return { ok: true, status: 200, json: async () => options.artifacts ?? [] };
        }
        if (/\/api\/c\/\d+\/commands$/.test(url)) {
          return {
            ok: true,
            status: 200,
            json: async () => options.commandResponse ?? { kind: "text", text: "nothing to report" },
          };
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
    historyRequests,
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

test("a conversation page shows the conversation, not a list of them", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({
      conversations: [
        { conversationId: 7, chatKey: "spaces/A/threads/T1", model: "deepseek/deepseek-flash", name: "deploy notes" },
        { conversationId: 9, chatKey: "spaces/A/threads/T2", model: "llama-local/lfm3" },
      ],
    });
    assert.deepEqual(h.errors, []);
    const doc = h.dom.window.document;
    // No sidebar: one page, one conversation.
    assert.equal(doc.getElementById("list"), null, "the conversation list must be gone");
    assert.equal(doc.getElementById("app")!.hidden, false);
    // The header names it, and offers the way back to the index.
    assert.equal(doc.getElementById("conv-title")!.textContent, "deploy notes");
    assert.equal(doc.getElementById("back")!.getAttribute("href"), "/");
  } finally {
    h?.close();
  }
});

test("an empty index renders no rows and opens no stream", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({ pathname: "/", conversations: [] });
    assert.deepEqual(h.errors, []);
    assert.equal(h.dom.window.document.querySelectorAll("#index-list li").length, 1, "one placeholder row");
    assert.equal(h.sources.length, 0, "nothing to stream on an empty index");
  } finally {
    h?.close();
  }
});

test("the conversation in the URL is the one opened", async () => {
  let h: Harness | undefined;
  try {
    // The URL is the state now: /9/ opens 9, not the newest conversation. This is
    // also the code path that threw `source is not defined` before it was fixed.
    h = await loadPage({
      pathname: "/9/",
      conversations: [
        { conversationId: 7, chatKey: "k1", model: "m" },
        { conversationId: 9, chatKey: "k2", model: "m" },
      ],
    });
    assert.deepEqual(h.errors, []);
    assert.equal(h.sources.length, 1);
    assert.match(h.sources[0]!.url, /api\/c\/9\/events$/);
    // The header names the conversation the URL asked for, not the newest one.
    // This fixture has no title, so the key is the name — the point is that it is
    // k2's, not k1's.
    const title = h.dom.window.document.getElementById("conv-title")!.textContent ?? "";
    assert.equal(title, "k2");
  } finally {
    h?.close();
  }
});

test("the index lists conversations, and no stream is opened there", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({
      pathname: "/",
      conversations: [
        { conversationId: 7, chatKey: "spaces/A/threads/T1", model: "m", name: "deploy notes" },
        { conversationId: 9, chatKey: "spaces/A/threads/T2", model: "m" },
      ],
    });
    assert.deepEqual(h.errors, []);
    const items = [...h.dom.window.document.querySelectorAll("#index-list li")];
    assert.equal(items.length, 2);
    assert.equal(items[0]!.querySelector(".who")!.textContent, "deploy notes");
    // Clicking navigates to the conversation's own URL.
    assert.equal(h.sources.length, 0, "the index opens no stream");
  } finally {
    h?.close();
  }
});

test("the index asks for a page, and offers Older only when there is one", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({
      pathname: "/",
      conversations: [{ conversationId: 7, chatKey: "k1", model: "m", name: "a" }],
      more: true,
    });
    assert.deepEqual(h.errors, []);
    const doc = h.dom.window.document;
    // It asks for a bounded page rather than everything: the whole point of the
    // list on a phone is that it can end, and say so.
    const asked = h.requests.find((request) => request.url.includes("api/conversations"));
    assert.ok(asked, "the index asked for conversations");
    assert.match(asked.url, /api\/conversations\?limit=\d+&offset=0$/);
    const pager = doc.getElementById("index-pager")!;
    assert.equal(pager.hidden, false, "more rows exist, so the pager is shown");
    assert.equal((doc.getElementById("index-older") as HTMLButtonElement).disabled, false);
    assert.equal((doc.getElementById("index-newer") as HTMLButtonElement).disabled, true);
    assert.equal(doc.getElementById("index-range")!.textContent, "1–1");

    (doc.getElementById("index-older") as HTMLButtonElement).click();
    await h.settle();
    assert.match(h.requests.at(-1)!.url, /offset=\d+$/);
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
    // The pane is chat-shaped now: a name line and the bubble.
    const live = log.querySelector(".msg.live")!;
    assert.equal(live.querySelector(".bubble")!.textContent, "hello from the model");
    assert.equal(live.querySelector(".meta .name")!.textContent, "pi");
    // No avatar disc: it cost a 1.9rem column on every row, which on a narrow
    // screen is space the answer could be using.
    assert.equal(live.querySelector(".avatar"), null, "the pi marker is gone");
    assert.equal(live.classList.contains("me"), false);
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
    assert.equal(log.querySelector(".msg.live .bubble")!.textContent, "second");
  } finally {
    h?.close();
  }
});

test("a tool frame shows in the pane, and null clears it", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({ conversations: [{ conversationId: 7, chatKey: "k", model: "m" }] });
    const log = h.dom.window.document.getElementById("log")!;
    h.sources[0]!.emit("tool", { name: "bash", status: "running", line: "Running: sleep 10" });
    // Inside the reply's own bubble, where Chat paints it — and the bubble exists
    // before there is any text, so the turn has somewhere to land.
    const bubble = log.querySelector(".msg.live .bubble")!;
    assert.ok(bubble, "the reply box is created as soon as the turn starts");
    assert.equal(bubble.querySelector(".status")!.textContent, "Running: sleep 10");
    // With no tool and no answer text there is nothing to say about the turn, so
    // the live row goes away rather than leaving an empty bubble behind.
    h.sources[0]!.emit("tool", null);
    assert.equal(log.querySelector(".msg.live"), null);
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
    // Trimmed on the way out, and `images` is always present (empty here), because
    // the route treats a missing list as "no attachments" and a present one as
    // something to validate.
    assert.deepEqual(JSON.parse(post.body!), { text: "hello", images: [] });
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

/**
 * The box being cleared is not the draft being cleared.
 *
 * `saveDraft()` is wired to `input` events only. Sending sets `box.value = ''`
 * *programmatically*, which fires no `input`, so the saved draft survived the
 * send — and `open()` restores it the next time the conversation is opened. The
 * message was sent, the transcript showed it, and the input box was refilled
 * with it later, which reads as the bridge having lost the message.
 */
test("sending clears the saved draft, so coming back does not refill the box", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({ conversations: [{ conversationId: 7, chatKey: "k", model: "m" }] });
    const doc = h.dom.window.document;
    const win = h.dom.window;
    const box = doc.getElementById("text") as HTMLTextAreaElement;

    // Type it the way a person does — this is what saves the draft.
    box.value = "ship it";
    box.dispatchEvent(new win.Event("input"));
    assert.equal(win.localStorage.getItem("pi-draft:7"), "ship it", "precondition: the draft was saved");

    doc.getElementById("send")!.dispatchEvent(new win.Event("submit", { cancelable: true }));
    await h.settle();

    assert.equal(
      win.localStorage.getItem("pi-draft:7"),
      null,
      "the draft must not survive a send, or it comes back in the box later",
    );
  } finally {
    h?.close();
  }
});

test("coming back after a send leaves the box empty", async () => {
  // The same failure, asserted the way it was reported. A cold page load is what
  // refilled the input box, so the honest test carries the storage state across
  // two loads: send on the first, reopen on the second. Reading localStorage
  // between them (rather than asserting `null` twice) is the point — whatever the
  // send left behind is exactly what the second load sees.
  let first: Harness | undefined;
  let leftover: string | null = "unset";
  try {
    first = await loadPage({ conversations: [{ conversationId: 7, chatKey: "k", model: "m" }] });
    const doc = first.dom.window.document;
    const win = first.dom.window;
    const box = doc.getElementById("text") as HTMLTextAreaElement;

    box.value = "ship it";
    box.dispatchEvent(new win.Event("input"));
    doc.getElementById("send")!.dispatchEvent(new win.Event("submit", { cancelable: true }));
    await first.settle();

    leftover = win.localStorage.getItem("pi-draft:7");
  } finally {
    first?.close();
  }

  assert.equal(leftover, null, "precondition: a send leaves no draft behind");

  // Reopen the conversation in a fresh page, carrying over what the send left.
  let second: Harness | undefined;
  try {
    second = await loadPage({
      conversations: [{ conversationId: 7, chatKey: "k", model: "m" }],
      ...(leftover === null ? {} : { draft: { conversationId: 7, text: leftover } }),
    });
    const box = second.dom.window.document.getElementById("text") as HTMLTextAreaElement;
    assert.equal(box.value, "", "the message already sent must not be refilled into the box");
  } finally {
    second?.close();
  }
});

test("a draft survives a reload that is not a send", async () => {
  // The counterpart to the test above: clearing on send must not become
  // "clearing on every navigation". A draft is still restored after a reload.
  let h: Harness | undefined;
  try {
    h = await loadPage({
      conversations: [{ conversationId: 7, chatKey: "k", model: "m" }],
      draft: { conversationId: 7, text: "half a thought" },
    });
    const box = h.dom.window.document.getElementById("text") as HTMLTextAreaElement;
    assert.equal(box.value, "half a thought");
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
    h = await loadPage({ pathname: "/pi/7/", conversations: [] });
    assert.deepEqual(h.errors, []);
    const urls = h.requests.map((request) => request.url);
    // The mount root, not the document's own directory: a conversation lives at
    // /pi/7/, so its API calls must still be /pi/api/... and not /pi/7/api/...
    for (const url of urls) assert.ok(url.startsWith("/pi/api/"), url);
    assert.ok(urls.includes("/pi/api/c/7"), urls.join(", "));
    assert.ok(urls.includes("/pi/api/environment"), urls.join(", "));
    // The stream is an EventSource, not a fetch, so it is checked where it lives.
    assert.match(h.sources[0]!.url, /^\/pi\/api\/c\/7\/events$/);
  } finally {
    h?.close();
  }
});

test("history renders as chat rows: you on the right, pi on the left, with times", async () => {
  let h: Harness | undefined;
  try {
    // The fake serves history for the conversation the page opens.
    h = await loadPage({
      conversations: [{ conversationId: 7, chatKey: "k", model: "m" }],
      history: [
        { role: "user", text: "hi", at: Date.now(), html: "<p>hi</p>" },
        { role: "assistant", text: "hello", at: Date.now(), html: "<p>hello</p>" },
      ],
    });

    const log = h.dom.window.document.getElementById("log")!;
    const rows = [...log.querySelectorAll(".msg")] as HTMLElement[];
    const chat = rows.filter((row) => !row.classList.contains("live"));
    assert.equal(chat.length, 2);

    assert.equal(chat[0].classList.contains("me"), true, "your message is the 'me' row");
    assert.equal(chat[0].querySelector(".bubble")!.textContent, "hi");

    assert.equal(chat[1].classList.contains("pi"), true, "pi's message is the 'pi' row");
    assert.equal(chat[1].querySelector(".meta .name")!.textContent, "pi");
    assert.equal(chat[1].querySelector(".bubble")!.textContent, "hello");

    // Timestamps: a time for today, and the full one on hover.
    const when = chat[1].querySelector("time.at") as HTMLTimeElement;
    assert.ok(when.textContent && when.textContent.length > 0, "a message from today shows a clock time");
    assert.ok(when.title.includes(":"), "hover keeps the full timestamp");
  } finally {
    h?.close();
  }
});

// --- Paging backwards ---------------------------------------------------------

/** `n` messages, oldest first, each distinguishable by its text. */
function transcriptOf(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    text: "message " + i,
    html: "<p>message " + i + "</p>",
    at: Date.now(),
  }));
}

/** The texts of the rendered chat rows, top to bottom. */
function renderedTexts(h: Harness): string[] {
  return [...h.dom.window.document.querySelectorAll("#log .msg")]
    .filter((row) => !row.classList.contains("live"))
    .map((row) => row.querySelector(".bubble")!.textContent ?? "");
}

test("the pane opens at the newest page, not the whole conversation", async () => {
  let h: Harness | undefined;
  try {
    // 120 messages: more than one page, so this is the case that used to show
    // only the newest 20 and look like the conversation started mid-sentence.
    h = await loadPage({
      conversations: [{ conversationId: 7, chatKey: "k", model: "m" }],
      history: transcriptOf(120),
    });
    assert.deepEqual(h.errors, []);

    // One page, and it is the *last* one: the newest messages.
    assert.equal(h.historyRequests.length, 1, "one request to open");
    assert.equal(h.historyRequests[0]!.offset, 0, "the newest page");
    const shown = renderedTexts(h);
    assert.equal(shown.length, 50);
    assert.equal(shown[0], "message 70", "starts one page back from the end");
    assert.equal(shown.at(-1), "message 119");
  } finally {
    h?.close();
  }
});

test("scrolling to the top brings in the page before it", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({
      conversations: [{ conversationId: 7, chatKey: "k", model: "m" }],
      history: transcriptOf(120),
    });
    const log = h.dom.window.document.getElementById("log")!;

    // jsdom has no layout, so there is nothing to scroll: the scroll handler only
    // compares scrollTop with a constant, and the anchoring maths is a no-op when
    // scrollHeight is 0. Firing the event is therefore what a real scroll does to
    // this code, without pretending to be a browser.
    log.scrollTop = 0;
    log.dispatchEvent(new h.dom.window.Event("scroll"));
    await h.settle();

    // The second page, offset by what is already held — counted in messages, not
    // pages, so a short page cannot make it re-request the same window.
    assert.equal(h.historyRequests.length, 2);
    assert.equal(h.historyRequests[1]!.offset, 50);
    const shown = renderedTexts(h);
    assert.equal(shown.length, 100, "both pages are in the log");
    assert.equal(shown[0], "message 20");
    assert.equal(shown.at(-1), "message 119", "the newest is still at the bottom");
  } finally {
    h?.close();
  }
});

test("paging stops at the beginning and says so", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({
      conversations: [{ conversationId: 7, chatKey: "k", model: "m" }],
      history: transcriptOf(60),
    });
    const doc = h.dom.window.document;
    const log = doc.getElementById("log")!;

    log.scrollTop = 0;
    log.dispatchEvent(new h.dom.window.Event("scroll"));
    await h.settle();

    // 60 messages in pages of 50: the second page is short, which is the signal
    // that the beginning has been reached.
    assert.equal(renderedTexts(h).length, 60);
    assert.equal(renderedTexts(h)[0], "message 0", "the first message of the thread");

    const earlier = doc.getElementById("earlier") as HTMLButtonElement;
    assert.equal(earlier.disabled, true);
    assert.equal(earlier.textContent, "Start of conversation");

    // And asking again does nothing rather than looping on an empty page.
    const asked = h.historyRequests.length;
    earlier.click();
    log.dispatchEvent(new h.dom.window.Event("scroll"));
    await h.settle();
    assert.equal(h.historyRequests.length, asked, "no further requests once complete");
  } finally {
    h?.close();
  }
});

test("a short conversation says it is at the start rather than offering a page", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({
      conversations: [{ conversationId: 7, chatKey: "k", model: "m" }],
      history: transcriptOf(3),
    });
    const doc = h.dom.window.document;
    // One page came back short, so the page already knows it has everything.
    assert.equal(renderedTexts(h).length, 3);
    // The marker is shown but inert: hiding it would leave the pane looking like
    // it might have failed to load something above the first message.
    const earlier = doc.getElementById("earlier") as HTMLButtonElement;
    assert.equal(earlier.hidden, false);
    assert.equal(earlier.disabled, true);
    assert.equal(earlier.textContent, "Start of conversation");
    assert.equal(h.historyRequests.length, 1, "no paging for a single page");
  } finally {
    h?.close();
  }
});

test("an empty conversation asks nothing and shows no pager", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({ conversations: [{ conversationId: 7, chatKey: "k", model: "m" }], history: [] });
    assert.equal(renderedTexts(h).length, 0);
    // Nothing to page through, so no marker at all.
    assert.equal(h.dom.window.document.getElementById("earlier")!.hidden, true);
    assert.equal(h.historyRequests.length, 1, "only the opening request");
  } finally {
    h?.close();
  }
});

test("paging state is per conversation, so a reload does not resume someone else's offset", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({
      conversations: [{ conversationId: 7, chatKey: "k", model: "m" }],
      history: transcriptOf(120),
    });
    const win = h.dom.window;
    const log = win.document.getElementById("log")!;

    // Page 7 back once, so its offset has advanced past the first page.
    log.scrollTop = 0;
    log.dispatchEvent(new win.Event("scroll"));
    await h.settle();
    assert.equal(h.historyRequests.at(-1)!.offset, 50);

    // Switching conversations is a full navigation in this page (the index links
    // to `/<id>/`), so the equivalent of "opening another one" is a fresh load.
    // What matters is that every load starts from `offset: 0`: a counter carried
    // over would ask for a window measured against a different thread.
    const second = await loadPage({
      conversations: [{ conversationId: 9, chatKey: "k2", model: "m" }],
      pathname: "/9/",
      history: transcriptOf(120),
    });
    try {
      assert.equal(second.historyRequests[0]!.offset, 0, "a new conversation starts at its newest page");
      assert.equal(second.historyRequests.length, 1, "and asks for exactly one page");
    } finally {
      second.close();
    }
  } finally {
    h?.close();
  }
});

test("an image sent over Chat shows up in the transcript", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({
      conversations: [{ conversationId: 7, chatKey: "k", model: "m" }],
      history: [
        {
          role: "user",
          text: "what is this",
          html: "<p>what is this</p>",
          at: Date.now(),
          entryId: 42,
          images: [{ mimeType: "image/png" }],
        },
      ],
    });
    assert.deepEqual(h.errors, []);
    const images = [...h.dom.window.document.querySelectorAll("#log .bubble img")] as HTMLImageElement[];
    assert.equal(images.length, 1, "the photo must be in the transcript");
    // Fetched from this origin by entry and index, so the payload stays text.
    assert.match(images[0]!.getAttribute("src") ?? "", /^\/api\/c\/7\/image\/42\/0$/);
  } finally {
    h?.close();
  }
});

test("a pasted image rides along with the message and shows straight away", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({ conversations: [{ conversationId: 7, chatKey: "k", model: "m" }] });
    const doc = h.dom.window.document;
    const win = h.dom.window;

    // jsdom has no clipboard files, so the event carries one the way a browser
    // would: kind "file", type "image/png", with a real Blob behind it.
    const png = new win.File([new win.Uint8Array([0x89, 0x50, 0x4e, 0x47])], "shot.png", { type: "image/png" });
    const paste = new win.Event("paste", { cancelable: true }) as unknown as {
      clipboardData: { items: unknown[] };
    };
    paste.clipboardData = { items: [{ kind: "file", type: "image/png", getAsFile: () => png }] };
    doc.getElementById("text")!.dispatchEvent(paste as unknown as Event);
    await h.settle();

    // A thumbnail appears before sending, so you can see what you attached.
    const thumbs = doc.querySelectorAll("#attachments img");
    assert.equal(thumbs.length, 1);
    assert.match(thumbs[0]!.getAttribute("src") ?? "", /^data:image\/png;base64,/);

    // And it goes with the message.
    doc.getElementById("send")!.dispatchEvent(new win.Event("submit", { cancelable: true }));
    await h.settle();
    const post = h.requests.find((request) => request.method === "POST");
    const body = JSON.parse(post!.body!) as { text: string; images: { data: string; mimeType: string }[] };
    assert.equal(body.images.length, 1);
    assert.equal(body.images[0]!.mimeType, "image/png");
    assert.ok(body.images[0]!.data.length > 0, "the bytes go, not a reference");
  } finally {
    h?.close();
  }
});

test("a file picked with the attach button waits in the strip and is sent", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({ conversations: [{ conversationId: 7, chatKey: "k", model: "m" }] });
    const doc = h.dom.window.document;
    const win = h.dom.window;

    // The attach button is a visible handle on a hidden file input: jsdom cannot
    // open a picker, so the test sets the files and fires `change`, which is what
    // the browser does after a choice.
    const input = doc.getElementById("attach-input") as HTMLInputElement;
    assert.ok(input, "the page must have a file input");
    assert.equal(input.multiple, true, "several photos at once is the normal case");
    assert.match(input.getAttribute("accept") ?? "", /image/);

    const jpg = new win.File([new win.Uint8Array([0xff, 0xd8, 0xff])], "beach.jpg", { type: "image/jpeg" });
    const png = new win.File([new win.Uint8Array([0x89, 0x50, 0x4e, 0x47])], "chart.png", { type: "image/png" });
    Object.defineProperty(input, "files", { value: [jpg, png], configurable: true });
    input.dispatchEvent(new win.Event("change"));
    await h.settle();

    // Both in the strip, named so you can tell which is which.
    const thumbs = [...doc.querySelectorAll("#attachments img")] as HTMLImageElement[];
    assert.equal(thumbs.length, 2);
    assert.match(thumbs[0]!.getAttribute("src") ?? "", /^data:image\/jpeg;base64,/);
    assert.equal(thumbs[0]!.getAttribute("alt"), "beach.jpg");

    // The input is cleared, so picking the same file again still fires `change`.
    assert.equal(input.value, "");

    doc.getElementById("send")!.dispatchEvent(new win.Event("submit", { cancelable: true }));
    await h.settle();
    const post = h.requests.find((request) => request.method === "POST");
    const body = JSON.parse(post!.body!) as { images: { mimeType: string }[] };
    assert.deepEqual(body.images.map((image) => image.mimeType), ["image/jpeg", "image/png"]);
  } finally {
    h?.close();
  }
});

test("a file dropped on the pane is attached, and the highlight goes away", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({ conversations: [{ conversationId: 7, chatKey: "k", model: "m" }] });
    const doc = h.dom.window.document;
    const win = h.dom.window;
    const pane = doc.getElementById("pane")!;

    const png = new win.File([new win.Uint8Array([0x89, 0x50, 0x4e, 0x47])], "dropped.png", { type: "image/png" });
    const dataTransfer = { types: ["Files"], files: [png], dropEffect: "none" };

    const dragenter = new win.Event("dragenter", { cancelable: true }) as unknown as { dataTransfer: unknown };
    dragenter.dataTransfer = dataTransfer;
    pane.dispatchEvent(dragenter as unknown as Event);
    assert.ok(pane.classList.contains("dropping"), "the pane shows it is a drop target");

    // `dragover` must be cancelled or the browser navigates to the file and the
    // conversation is lost — the one bug a drop handler can cause.
    const dragover = new win.Event("dragover", { cancelable: true }) as unknown as { dataTransfer: unknown };
    dragover.dataTransfer = dataTransfer;
    const notCancelled = pane.dispatchEvent(dragover as unknown as Event);
    assert.equal(notCancelled, false, "dragover must be prevented");
    assert.equal(dataTransfer.dropEffect, "copy");

    const drop = new win.Event("drop", { cancelable: true }) as unknown as { dataTransfer: unknown };
    drop.dataTransfer = dataTransfer;
    pane.dispatchEvent(drop as unknown as Event);
    await h.settle();

    assert.equal(pane.classList.contains("dropping"), false, "the highlight must clear");
    const thumbs = doc.querySelectorAll("#attachments img");
    assert.equal(thumbs.length, 1);
    assert.equal(doc.getElementById("attach-notice")!.hidden, true, "nothing to complain about");
  } finally {
    h?.close();
  }
});

test("a dropped file that is not an image says why instead of vanishing", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({ conversations: [{ conversationId: 7, chatKey: "k", model: "m" }] });
    const doc = h.dom.window.document;
    const win = h.dom.window;

    const pdf = new win.File([new win.Uint8Array([0x25, 0x50])], "invoice.pdf", { type: "application/pdf" });
    const drop = new win.Event("drop", { cancelable: true }) as unknown as { dataTransfer: unknown };
    drop.dataTransfer = { types: ["Files"], files: [pdf] };
    doc.getElementById("pane")!.dispatchEvent(drop as unknown as Event);
    await h.settle();

    const notice = doc.getElementById("attach-notice")!;
    assert.equal(notice.hidden, false);
    assert.match(notice.textContent ?? "", /invoice\.pdf.*is not an image/);
    assert.equal(doc.querySelectorAll("#attachments img").length, 0);
  } finally {
    h?.close();
  }
});

test("an image over the size limit is refused here, naming its size", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({ conversations: [{ conversationId: 7, chatKey: "k", model: "m" }] });
    const doc = h.dom.window.document;
    const win = h.dom.window;

    const huge = new win.File([new win.Uint8Array([0x89])], "raw.png", { type: "image/png" });
    // jsdom computes `size` from the bytes, so the limit is exercised by lying
    // about it rather than allocating 9 MB per test run.
    Object.defineProperty(huge, "size", { value: 9 * 1024 * 1024 });
    const input = doc.getElementById("attach-input") as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [huge], configurable: true });
    input.dispatchEvent(new win.Event("change"));
    await h.settle();

    // Refused before sending, so a message is never lost to a file the server
    // would have rejected anyway.
    assert.equal(doc.querySelectorAll("#attachments img").length, 0);
    assert.match(doc.getElementById("attach-notice")!.textContent ?? "", /raw\.png.*9\.0 MB.*8\.0 MB/);
  } finally {
    h?.close();
  }
});

test("several images in one message all go, and one can be taken back off", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({ conversations: [{ conversationId: 7, chatKey: "k", model: "m" }] });
    const doc = h.dom.window.document;
    const win = h.dom.window;

    const first = new win.File([new win.Uint8Array([1])], "a.png", { type: "image/png" });
    const second = new win.File([new win.Uint8Array([2])], "b.png", { type: "image/png" });
    const paste = new win.Event("paste", { cancelable: true }) as unknown as { clipboardData: unknown };
    paste.clipboardData = {
      items: [
        { kind: "file", type: "image/png", getAsFile: () => first },
        { kind: "file", type: "image/png", getAsFile: () => second },
      ],
    };
    doc.getElementById("text")!.dispatchEvent(paste as unknown as Event);
    await h.settle();
    assert.equal(doc.querySelectorAll("#attachments img").length, 2);

    // One can be taken back off, and only that one.
    (doc.querySelector("#attachments figure button") as HTMLButtonElement).click();
    assert.equal(doc.querySelectorAll("#attachments img").length, 1);
    assert.equal(
      doc.querySelector("#attachments img")!.getAttribute("alt"),
      "b.png",
      "the one that was not removed stays",
    );
  } finally {
    h?.close();
  }
});

test("typing saves a draft, so a reload does not lose it", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({ conversations: [{ conversationId: 7, chatKey: "k", model: "m" }] });
    const win = h.dom.window;
    const box = win.document.getElementById("text") as HTMLTextAreaElement;

    box.value = "half a thought";
    box.dispatchEvent(new win.Event("input"));

    assert.equal(win.localStorage.getItem("pi-draft:7"), "half a thought");

    // An empty box clears the draft rather than storing whitespace.
    box.value = "   ";
    box.dispatchEvent(new win.Event("input"));
    assert.equal(win.localStorage.getItem("pi-draft:7"), null);
  } finally {
    h?.close();
  }
});

test("a draft is restored when the conversation opens", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({
      conversations: [{ conversationId: 7, chatKey: "k", model: "m" }],
      draft: { conversationId: 7, text: "restored from before the reload" },
    });
    const box = h.dom.window.document.getElementById("text") as HTMLTextAreaElement;
    assert.equal(box.value, "restored from before the reload");
    // Cheap confidence the box was refitted to the restored text, not left at
    // one line.
    assert.ok(box.style.height !== "", "fitBox ran for the restored draft");
  } finally {
    h?.close();
  }
});

test("an inline image from the renderer is rebased onto the mount", async () => {
  // The renderer emits a *relative* source (`safeImageSrc` refuses anything
  // absolute, so the markup stays portable across mounts). On a conversation
  // page the document sits one level too deep — `/web/1/` — so a bare
  // `api/c/...` would resolve to `/web/1/api/c/...` and 404. The page rebases it
  // through `rel()`, which is what this pins: the failure was invisible in unit
  // tests of the renderer, because the markup itself was correct.
  const harness = await loadPage({
    pathname: "/web/1/",
    conversations: [{ conversationId: 1, chatKey: "c", model: "m", name: "pie" }],
    history: [
      {
        role: "assistant",
        text: "here ![pie](api/c/1/image/5/0)",
        html: '<p>here <img src="api/c/1/image/5/0" alt="pie" loading="lazy"></p>',
        entryId: 5,
      },
    ],
  });
  try {
    await harness.settle();
    const img = harness.dom.window.document.querySelector(".bubble img");
    assert.ok(img, "the inline image should be in the bubble");
    assert.equal(img.getAttribute("src"), "/web/api/c/1/image/5/0");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a data: image source is left alone", async () => {
  // The composer previews a just-pasted image from a data: URI; rebasing one
  // would corrupt it. Only relative paths take the `rel()` treatment.
  const harness = await loadPage({
    pathname: "/web/1/",
    conversations: [{ conversationId: 1, chatKey: "c", model: "m", name: "pie" }],
    history: [
      {
        role: "assistant",
        text: "x",
        html: '<p><img src="data:image/png;base64,AAAA" alt="p"></p>',
        entryId: 5,
      },
    ],
  });
  try {
    await harness.settle();
    const img = harness.dom.window.document.querySelector(".bubble img");
    assert.ok(img, "the data: image should be in the bubble");
    assert.equal(img.getAttribute("src"), "data:image/png;base64,AAAA");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

// --- Review comments ---------------------------------------------------------

/** The framed artifact document, which is the only source of selection messages. */
function artifactFrame(dom: JSDOM): HTMLIFrameElement {
  const frame = dom.window.document.getElementById("artifact-frame");
  assert.ok(frame instanceof dom.window.HTMLIFrameElement);
  return frame as HTMLIFrameElement;
}

/** Post a message as the artifact document would, and let the handlers run. */
async function fromFrame(h: Harness, data: unknown): Promise<void> {
  const frame = artifactFrame(h.dom);
  h.dom.window.dispatchEvent(
    new h.dom.window.MessageEvent("message", { data, source: frame.contentWindow as Window }),
  );
  await h.settle();
}

test("a selection opens the composer without taking focus", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({ pathname: "/7/", conversations: [{ conversationId: 7, chatKey: "k", model: "m" }] });
    assert.deepEqual(h.errors, []);
    const doc = h.dom.window.document;
    const bar = doc.getElementById("comment-bar")!;
    assert.equal(bar.hidden, true, "nothing selected yet");

    await fromFrame(h, { t: "pi-artifact-select", file: "notes.md", quote: "the kitten was a stowaway" });

    assert.equal(bar.hidden, false, "the composer is offered");
    assert.match(doc.getElementById("comment-addr")!.textContent ?? "", /notes\.md/);

    // The rule this test exists for: focusing the field here raises the mobile
    // keyboard, and raising the keyboard collapses the selection, so the reader can
    // never drag the native grabbers to select more words.
    assert.notEqual(doc.activeElement, doc.getElementById("comment-text"), "the field must not steal focus");
  } finally {
    h?.close();
  }
});

test("adjusting the selection updates the address but keeps what was typed", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({ pathname: "/7/", conversations: [{ conversationId: 7, chatKey: "k", model: "m" }] });
    const doc = h.dom.window.document;
    const field = doc.getElementById("comment-text") as HTMLTextAreaElement;
    await fromFrame(h, { t: "pi-artifact-select", file: "notes.md", quote: "crumbs" });
    field.value = "instead of crumbs, ";

    // A handle drag: same file, a longer quote.
    await fromFrame(h, { t: "pi-artifact-select", file: "notes.md", quote: "instead of crumbs, mutant mice" });

    assert.equal(field.value, "instead of crumbs, ", "a drag must not wipe the draft");
    assert.match(doc.getElementById("comment-quote")!.textContent ?? "", /mutant mice/);
  } finally {
    h?.close();
  }
});

test("deselecting closes the composer, unless a draft is in it", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({ pathname: "/7/", conversations: [{ conversationId: 7, chatKey: "k", model: "m" }] });
    const doc = h.dom.window.document;
    const bar = doc.getElementById("comment-bar")!;
    const field = doc.getElementById("comment-text") as HTMLTextAreaElement;

    await fromFrame(h, { t: "pi-artifact-select", file: "notes.md", quote: "crumbs" });
    await fromFrame(h, { t: "pi-artifact-clear", file: "notes.md" });
    assert.equal(bar.hidden, true, "an empty composer closes with the selection");

    await fromFrame(h, { t: "pi-artifact-select", file: "notes.md", quote: "crumbs" });
    field.value = "half a thought";
    await fromFrame(h, { t: "pi-artifact-clear", file: "notes.md" });
    assert.equal(bar.hidden, false, "a draft is never thrown away by a stray tap");
  } finally {
    h?.close();
  }
});

// --- Stream lifecycle -------------------------------------------------------

test("a stream the browser has given up on is reopened by the page", async () => {
  // The reported bug: coming back to an inactive tab showed "reconnecting…" for ever, because the
  // page trusted the browser's retry — which stops permanently once an EventSource closes.
  let h: Harness | undefined;
  try {
    h = await loadPage({ pathname: "/7/", conversations: [{ conversationId: 7, chatKey: "k", model: "m" }] });
    const doc = h.dom.window.document;
    assert.equal(h.sources.length, 1, "one stream for the open conversation");

    // The browser closes it (frozen tab, locked phone, restart that answered 5xx).
    const first = h.sources[0]!;
    first.close();
    first.triggerError();
    assert.equal(doc.getElementById("tool")?.textContent ?? "", "reconnecting…");

    // The page reopens it on a short backoff, rather than waiting for a retry nobody makes.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(h.sources.length, 2, "a replacement stream, created by the page");

    // And the footer stops claiming to reconnect once a stream actually opens.
    h.sources[1]!.listeners.get("open")?.forEach((fn) => fn({ data: "" }));
    assert.equal(doc.getElementById("tool")?.textContent ?? "", "");
  } finally {
    h?.close();
  }
});

test("the composer takes focus only when the click asked for it", async () => {
  // Focus follows intent. Selecting text in the document no longer opens this bar at all; the button
  // beside the selection sends `intent: "comment"`, and that is the reader saying they want to write
  // — so focusing (and raising the keyboard) is right. A selection message without the intent keeps
  // the old rule, which is that the field must not steal focus mid-read.
  let h: Harness | undefined;
  try {
    h = await loadPage({ pathname: "/7/", conversations: [{ conversationId: 7, chatKey: "k", model: "m" }] });
    const doc = h.dom.window.document;
    const field = doc.getElementById("comment-text") as HTMLTextAreaElement;
    // The bar lives inside the artifacts pane, and jsdom refuses to focus an element it considers
    // unrendered. Opening the pane is what the reader has already done by the time they select text.
    (doc.getElementById("artifacts") as HTMLElement).hidden = false;

    await fromFrame(h, { t: "pi-artifact-select", file: "notes.md", quote: "crumbs" });
    assert.notEqual(doc.activeElement, field, "a bare selection never focuses");

    await fromFrame(h, { t: "pi-artifact-select", file: "notes.md", quote: "crumbs", intent: "comment" });
    assert.equal(doc.activeElement, field, "a deliberate comment does");
  } finally {
    h?.close();
  }
});

/* --- the artifact drawer in the URL ------------------------------------------ */

const drawerFiles = [
  { key: "conversation/7/notes.md", markdown: true, wrote: 1, edited: 0 },
  { key: "conversation/7/run.sh", wrote: 1, edited: 0 },
];

test("a page that loads with a fragment opens that document", async () => {
  // A reload is the ordinary way to arrive here: opening a document writes its key into the fragment,
  // and the browser hands it back. The drawer must come up on the document, not on the list.
  let h: Harness | undefined;
  try {
    h = await loadPage({
      pathname: "/7/",
      hash: "#conversation%2F7%2Fnotes.md",
      artifactsBaseUrl: "http://127.0.0.1:8082",
      artifacts: drawerFiles,
      conversations: [{ conversationId: 7, chatKey: "k", model: "m" }],
    });
    await h.settle();
    const doc = h.dom.window.document;
    assert.deepEqual(h.errors, []);

    assert.equal((doc.getElementById("artifacts") as HTMLElement).hidden, false, "the drawer is open");
    assert.ok(doc.getElementById("artifacts")!.classList.contains("showing-doc"), "on the document, not the list");
    assert.equal(doc.getElementById("artifacts-title")!.textContent, "notes.md");
    // Markdown opens rendered, which is what a reader wants; the source view is for everything else.
    assert.match(doc.getElementById("artifact-frame")!.getAttribute("src") ?? "", /notes\.md\?render$/);
    // The entry's own state, so the browser's back gesture still means "close the document". Compared
    // field by field: the object comes from the jsdom realm, so it is not reference-equal to a literal.
    assert.equal(h.dom.window.history.state.artifact, "conversation/7/notes.md");
  } finally {
    h?.close();
  }
});

test("a fragment naming a file that is gone leaves the list showing, and drops the fragment", async () => {
  // A link to a file that has since been deleted, or one belonging to another conversation. The list
  // is the honest answer, and the address should stop claiming otherwise.
  let h: Harness | undefined;
  try {
    h = await loadPage({
      pathname: "/7/",
      hash: "#conversation%2F7%2Fdeleted.md",
      artifactsBaseUrl: "http://127.0.0.1:8082",
      artifacts: drawerFiles,
      conversations: [{ conversationId: 7, chatKey: "k", model: "m" }],
    });
    await h.settle();
    const doc = h.dom.window.document;
    assert.deepEqual(h.errors, []);

    assert.equal((doc.getElementById("artifacts") as HTMLElement).hidden, false, "the drawer still opens");
    assert.equal(doc.getElementById("artifacts")!.classList.contains("showing-doc"), false, "on the list");
    assert.equal(h.dom.window.location.hash, "", "and the address no longer names it");
  } finally {
    h?.close();
  }
});

test("a refresh a turn triggers keeps the document open", async () => {
  // `loadArtifacts(preserve)` was written for this: a turn ends, the drawer refreshes its list, and the
  // document being read must stay put — including its scroll and its selection. It keyed on the framed
  // document's key, which nothing was setting, so every refresh quietly fell back to the list.
  let h: Harness | undefined;
  try {
    h = await loadPage({
      pathname: "/7/",
      hash: "#conversation%2F7%2Fnotes.md",
      artifactsBaseUrl: "http://127.0.0.1:8082",
      artifacts: drawerFiles,
      conversations: [{ conversationId: 7, chatKey: "k", model: "m" }],
      history: [{ role: "user", text: "hi", html: "<p>hi</p>" }],
    });
    await h.settle();
    const doc = h.dom.window.document;
    const panel = doc.getElementById("artifacts")!;
    assert.ok(panel.classList.contains("showing-doc"), "the fragment opened it");

    // A turn that ran and finished is what makes the pane refetch and refresh the review.
    const source = h.sources[h.sources.length - 1]!;
    source.emit("text", { text: "working", busy: true });
    source.emit("text", { busy: false });
    for (let i = 0; i < 100 && !h.requests.some((r) => r.url.includes("/artifacts")); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await h.settle();

    assert.ok(panel.classList.contains("showing-doc"), "the document is still showing");
    assert.equal(doc.getElementById("artifacts-title")!.textContent, "notes.md");
    assert.match(doc.getElementById("artifact-frame")!.getAttribute("src") ?? "", /notes\.md\?render$/);
  } finally {
    h?.close();
  }
});

test("the fragment follows the drawer: another key opens it, closing clears it", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({
      pathname: "/7/",
      hash: "#conversation%2F7%2Fnotes.md",
      artifactsBaseUrl: "http://127.0.0.1:8082",
      artifacts: drawerFiles,
      conversations: [{ conversationId: 7, chatKey: "k", model: "m" }],
    });
    await h.settle();
    const doc = h.dom.window.document;

    // A hash change is a request to show another file — that is what a link to one now looks like.
    h.dom.window.location.hash = "#conversation%2F7%2Frun.sh";
    for (let i = 0; i < 100 && doc.getElementById("artifacts-title")!.textContent !== "run.sh"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(doc.getElementById("artifacts-title")!.textContent, "run.sh");
    assert.match(doc.getElementById("artifact-frame")!.getAttribute("src") ?? "", /run\.sh\?view=source$/, "a script opens as source");

    // ← after a reload closes the document instead of walking out of the conversation, and the address
    // stops claiming a file is open.
    doc.getElementById("artifacts-back")!.click();
    await h.settle();
    assert.equal(doc.getElementById("artifacts")!.classList.contains("showing-doc"), false);
    assert.equal(h.dom.window.location.hash, "");
  } finally {
    h?.close();
  }
});

/* --- slash commands in the composer ------------------------------------------ */

test("a line beginning with a slash is a command, and its answer is drawn", async () => {
  // The pane implements four renderers — text, list, choice, form — instead of eleven commands, so a
  // command added on the server shows up here without this page changing.
  let h: Harness | undefined;
  try {
    h = await loadPage({
      pathname: "/7/",
      conversations: [{ conversationId: 7, chatKey: "k", model: "m" }],
    });
    await h.settle();
    const doc = h.dom.window.document;
    const box = doc.getElementById("text") as HTMLTextAreaElement;
    box.value = "/status";
    doc.getElementById("send")!.dispatchEvent(new h.dom.window.Event("submit", { cancelable: true }));
    for (let i = 0; i < 100 && !h.requests.some((r) => r.url.includes("/commands")); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await h.settle();

    const sent = h.requests.find((r) => r.url.includes("/commands"));
    assert.ok(sent, "the command went to the command route");
    assert.deepEqual(JSON.parse(sent!.body ?? "{}"), { text: "/status" });
    // It is not a message: nothing was submitted to the conversation.
    assert.equal(h.requests.some((r) => r.url.includes("/message")), false);
    // And the box was cleared, so a command does not sit there waiting to be sent twice.
    assert.equal(box.value, "");

    const panel = doc.getElementById("command-panel") as HTMLElement;
    assert.equal(panel.hidden, false, "the answer is shown");
    assert.equal(doc.getElementById("command-body")!.textContent, "nothing to report");
  } finally {
    h?.close();
  }
});

test("a list of choices is buttons, and pressing one sends its command", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({
      pathname: "/7/",
      conversations: [{ conversationId: 7, chatKey: "k", model: "m" }],
    });
    await h.settle();
    const doc = h.dom.window.document;
    // The fake answers every command with this list, so the rendering path is what is under test.
    h.dom.window.fetch = async (input: unknown) => {
      const url = String(input);
      h!.requests.push({ url, method: "POST", body: "" });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          kind: "list",
          title: "Recent conversations",
          rows: [{ label: "earlier", detail: "2h ago", command: "/resume 9", current: false }],
        }),
      };
    };
    const box = doc.getElementById("text") as HTMLTextAreaElement;
    box.value = "/sessions";
    doc.getElementById("send")!.dispatchEvent(new h.dom.window.Event("submit", { cancelable: true }));
    await h.settle();

    const row = doc.querySelector("#command-body .row.clickable") as HTMLButtonElement;
    assert.ok(row, "the row is a button because it carries a command");
    assert.equal(doc.getElementById("command-title")!.textContent, "Recent conversations");
    row.click();
    await h.settle();
    assert.ok(h.requests.some((request) => request.url.includes("/commands") && request.method === "POST"));
  } finally {
    h?.close();
  }
});

test("a form asks several things at once and sends them together", async () => {
  // The reason the vocabulary has a `form`: model and thinking level are one decision. Two questions in
  // sequence would make every surface carry the state of the first to ask the second.
  let h: Harness | undefined;
  try {
    h = await loadPage({
      pathname: "/7/",
      conversations: [{ conversationId: 7, chatKey: "k", model: "m" }],
      commandResponse: {
        kind: "form",
        prompt: "Model and thinking level",
        command: "/model",
        submit: "Apply",
        fields: [
          {
            id: "model",
            label: "Model",
            kind: "select",
            value: "deepseek/deepseek-chat",
            options: [
              { id: "deepseek/deepseek-chat", label: "deepseek-chat", selected: true },
              { id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4" },
            ],
          },
          {
            id: "thinking",
            label: "Thinking",
            kind: "select",
            value: "medium",
            options: [
              { id: "off", label: "off" },
              { id: "medium", label: "medium", selected: true },
              { id: "high", label: "high" },
            ],
          },
        ],
      },
    });
    await h.settle();
    const doc = h.dom.window.document;
    const box = doc.getElementById("text") as HTMLTextAreaElement;
    box.value = "/model";
    doc.getElementById("send")!.dispatchEvent(new h.dom.window.Event("submit", { cancelable: true }));
    await h.settle();

    const selects = [...doc.querySelectorAll("#command-body select")] as HTMLSelectElement[];
    assert.equal(selects.length, 2, "both fields are on one form");
    assert.equal(selects[0]!.value, "deepseek/deepseek-chat", "the current model is preselected");
    assert.equal(selects[1]!.value, "medium", "and so is the current thinking level");

    // Both answers arrive together, keyed by field id.
    selects[0]!.value = "anthropic/claude-sonnet-4";
    selects[1]!.value = "high";
    doc.querySelector("#command-body form")!.dispatchEvent(new h.dom.window.Event("submit", { cancelable: true }));
    await h.settle();

    const posted = h.requests.filter((request) => request.url.includes("/commands"));
    const last = JSON.parse(posted[posted.length - 1]!.body ?? "{}");
    assert.deepEqual(last, { text: "/model", values: { model: "anthropic/claude-sonnet-4", thinking: "high" } });
  } finally {
    h?.close();
  }
});
