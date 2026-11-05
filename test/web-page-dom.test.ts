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
    /** Whether the fake server claims another page exists after this one. */
    more?: boolean;
    /** Messages the fake host returns for one conversation's history. */
    history?: { role: string; text: string; at?: number; html: string; entryId?: number; images?: { mimeType: string }[] }[];
    /** Page version the fake server reports; a different value asks for a reload. */
    pageVersion?: string;
    /** Draft text to seed into localStorage before the page's script runs. */
    draft?: { conversationId: number; text: string };
    postStatus?: number;
  } = {},
): Promise<Harness> {
  // Conversation mode: the URL carries the conversation id.
  const pathname = options.pathname ?? "/7/";
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
          return { ok: true, status: 200, json: async () => options.history ?? [] };
        }
        if (url.endsWith("api/environment")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ artifactsBaseUrl: "", pageVersion: options.pageVersion ?? "v1" }),
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
