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

import { WEB_PAGE } from "../src/web/sink.js";

/** One recorded EventSource, so a test can emit frames on it. */
interface FakeSource {
  url: string;
  closed: boolean;
  /** `EventSource.readyState`, which the page reads to tell CLOSED from OPEN. */
  readyState: number;
  listeners: Map<string, ((event: { data: string }) => void)[]>;
  emit(event: string, data: unknown): void;
  triggerError(): void;
  /** `EventSource.close()`: the page calls it before replacing a stream. */
  close(): void;
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
  historyRequests: { limit: number; before: number }[];
  /** Every `window.open` the page attempted, as its argument list. */
  opened: unknown[][];
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
    artifacts?: { key: string; markdown?: boolean; image?: boolean; wrote?: number; edited?: number }[];
    /** A URL fragment, as a reload would arrive with one. */
    hash?: string;
    /** What the fake answers `POST api/c/<id>/commands` with. */
    commandResponse?: unknown;
    /** What the fake reports as the live turn, which the state route answers with. */
    live?: { text: string; turn?: string; busy: boolean };
    /** The format the fake reports for the open conversation (model + thinking). */
    format?: { model: string; thinking?: string; levels?: string[] };
    /** The models the fake offers a picker. */
    models?: { provider: string; id: string; label: string; levels?: string[] }[];
    /** The id `POST api/conversations` reports for the conversation it made. */
    createdId?: number;
    /** Anything else that POST answers with, such as a refusal. */
    createdExtra?: Record<string, unknown>;
  } = {},
): Promise<Harness> {
  // Conversation mode: the URL carries the conversation id.
  const pathname = options.pathname ?? "/7/";
  const conversations = options.conversations ?? [];

  const sources: FakeSource[] = [];
  const requests: Harness["requests"] = [];
  const errors: string[] = [];
  /** Every history request, so a test can assert how it paged. */
  const historyRequests: { limit: number; before: number }[] = [];

  // The stubs must exist BEFORE the page's script runs, and jsdom runs an inline
  // <script> during parsing. `beforeParse` is the only hook early enough — putting
  // them on `dom.window` afterwards threw "fetch is not defined" inside load(),
  // because the page calls it at the bottom of its own script.
  const dom = new JSDOM(WEB_PAGE, {
    url: `http://127.0.0.1:8081${pathname}${options.hash ?? ""}`,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(win) {

      // jsdom has no layout, so it has no `scrollIntoView`. The page calls it on the entry a link
      // names; without this the anchor throws where a browser would scroll.
      (win.Element.prototype as unknown as { scrollIntoView(): void }).scrollIntoView = () => {};

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
          // Creating one is the other half of the same URL — the index's ＋, and search.
          if (init?.method === "POST") {
            return {
              ok: true,
              status: 201,
              json: async () => ({
                conversationId: options.createdId ?? 99,
                chatKey: "web:new",
                model: "m",
                ...(options.createdExtra ?? {}),
              }),
            };
          }
          // The paged shape, which is what the index and the sidebar read.
          return { ok: true, status: 200, json: async () => ({ items: conversations, more: options.more ?? false }) };
        }
        const one = /\/api\/c\/(\d+)$/.exec(url);
        if (one) {
          const found = conversations.find((c) => c.conversationId === Number(one[1]));
          // The format rides with the conversation, the way the real route serves it.
          const body = found && options.format ? { ...found, format: options.format } : (found ?? {});
          return { ok: Boolean(found), status: found ? 200 : 404, json: async () => body };
        }
        if (url.includes("api/models")) {
          const models = (options.models ?? []).map((model) => ({
            ...model,
            key: `${model.provider}/${model.id}`,
            levels: model.levels ?? [],
          }));
          return { ok: true, status: 200, json: async () => ({ models }) };
        }
        if (url.includes("/history")) {
          // Paged the way the real route pages **now**: anchored on an entry id, not on an offset.
          // `before=0` is the first paint (the newest page), and each earlier page asks for what
          // precedes the oldest id it holds. Ids are assigned here when a fixture omits them, so the
          // anchor is always something the page can name.
          const all = (options.history ?? []).map((message, index) => ({
            ...message,
            entryId: message.entryId ?? index + 1,
          }));
          const query = new URL(url, "http://127.0.0.1").searchParams;
          const limit = Number(query.get("limit") ?? 50) || 50;
          const before = Math.max(0, Number(query.get("before") ?? 0) || 0);
          historyRequests.push({ limit, before });
          const older = before === 0 ? all : all.filter((message) => message.entryId < before);
          const page = older.slice(Math.max(0, older.length - limit));
          return {
            ok: true,
            status: 200,
            json: async () => ({
              messages: page,
              before: page[0]?.entryId ?? before,
              atStart: older.length <= limit,
            }),
          };
        }
        // The live state, in the shape a `text` frame carries — which is what the page applies on
        // reconnect. `live` is a *reference* to the object the test can mutate, so a test can make
        // the turn progress while the page believes it is up to date.
        if (/\/api\/c\/\d+\/events\/state$/.test(url)) {
          const live = options.live ?? { text: "", busy: false };
          return {
            ok: true,
            status: 200,
            json: async () => ({
              text: live.text,
              ...(live.turn ? { turn: live.turn, turnHtml: `<p>${live.turn}</p>` } : {}),
              html: `<p>${live.text}</p>`,
              busy: live.busy,
            }),
          };
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

  // `window.open` is a no-op in jsdom (it reports "not implemented"), so the drawer's
  // ↗ button could not be checked at all without a stand-in. Recording the calls lets
  // a test assert *which* URL a tab would have opened, which is the part that decides
  // whether an image opens as a picture or as a source page.
  const opened: unknown[][] = [];
  dom.window.open = ((...args: unknown[]) => {
    opened.push(args);
    return null;
  }) as unknown as typeof dom.window.open;

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
    /** Every `window.open` the page attempted, as its argument list. */
    opened,
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

/**
 * The window title, which is what an installed app has instead of a tab strip.
 *
 * A browser's tab says the site; a standalone window says nothing else, so the
 * conversation has to name itself — and has to stop naming itself on the way back
 * to the index, or a task switcher shows two windows both called after whichever
 * conversation was read last.
 */
test("a conversation names the window, and the index names the app", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({
      conversations: [
        { conversationId: 7, chatKey: "spaces/A/threads/T1", model: "deepseek/deepseek-flash", name: "deploy notes" },
      ],
    });
    await h.settle();
    assert.deepEqual(h.errors, []);
    // The name comes from the same response as the header, so the two cannot drift.
    assert.equal(h.dom.window.document.title, "deploy notes — pi bridge");
  } finally {
    h?.close();
  }

  let index: Harness | undefined;
  try {
    index = await loadPage({ pathname: "/", conversations: [] });
    assert.deepEqual(index.errors, []);
    assert.equal(index.dom.window.document.title, "pi bridge");
  } finally {
    index?.close();
  }
});

test("a conversation with no name falls back to its id, in the title too", async () => {
  let h: Harness | undefined;
  try {
    // The conversation is not in the list the fake returns, so the header keeps
    // "#7" — and the title has to say the same thing rather than staying generic.
    h = await loadPage({ conversations: [] });
    await h.settle();
    assert.deepEqual(h.errors, []);
    assert.equal(h.dom.window.document.getElementById("conv-title")!.textContent, "#7");
    assert.equal(h.dom.window.document.title, "#7 — pi bridge");
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

test("a stale tool frame cannot revive a status line after the turn ends", async () => {
  // Frames are two separate events and either can arrive last. A `tool` frame that
  // names a call *after* the turn has settled must not be painted as though the call
  // were still running — that is the "Running: …" that outlived its command.
  let h: Harness | undefined;
  try {
    h = await loadPage({
      conversations: [{ conversationId: 7, chatKey: "k", model: "m" }],
      history: [{ role: "user", text: "go", at: 1, html: "<p>go</p>" }],
    });
    const log = h.dom.window.document.getElementById("log")!;
    const source = h.sources[0]!;

    source.emit("text", { text: "done", busy: true });
    source.emit("text", { text: "done", busy: false });
    source.emit("tool", { name: "bash", status: "running", line: "Running: jj split" });
    await h.settle();

    assert.equal(log.querySelector(".msg.live .status"), null, "an idle turn shows no running command");
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

// --- Search -------------------------------------------------------------------

test("the magnifier beside the title opens a box, and only takes the space when it is open", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({ conversations: [{ conversationId: 7, chatKey: "k", model: "m" }] });
    const doc = h.dom.window.document;
    const bar = doc.getElementById("search-bar") as HTMLElement;
    const toggle = doc.getElementById("search-toggle") as HTMLButtonElement;
    assert.equal(bar.hidden, true, "closed until asked for");
    assert.equal(toggle.getAttribute("aria-expanded"), "false");

    toggle.click();
    assert.equal(bar.hidden, false);
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    // Focused, so the keyboard is up on a phone and typing needs no second tap.
    assert.equal(doc.activeElement, doc.getElementById("search-text"));

    // Escape closes it, and puts focus back where it came from.
    doc.getElementById("search-text")!.dispatchEvent(
      new h.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    assert.equal(bar.hidden, true);
    assert.equal(doc.activeElement, toggle);
  } finally {
    h?.close();
  }
});

test("submitting a search starts a conversation and goes to it", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({
      conversations: [{ conversationId: 7, chatKey: "k", model: "m" }],
      createdId: 99,
    });
    const doc = h.dom.window.document;
    // jsdom does not navigate, so the request is what this test can check; the browser
    // test follows the navigation itself.
    (doc.getElementById("search-text") as HTMLInputElement).value = "  quantiz gpu  ";
    doc.getElementById("search-bar")!.dispatchEvent(new h.dom.window.Event("submit", { cancelable: true }));
    await h.settle();

    const post = h.requests.find((r) => r.method === "POST");
    assert.ok(post, "expected a POST");
    assert.match(post.url, /api\/conversations$/);
    // The query travels alone. The prompt that tells the agent to use the skill is
    // composed on the server, so there is only one copy of it to keep in step.
    assert.deepEqual(JSON.parse(post.body!), { query: "quantiz gpu" });
  } finally {
    h?.close();
  }
});

test("a search that could not start says so, and leaves the box usable", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({
      conversations: [{ conversationId: 7, chatKey: "k", model: "m" }],
      // A refusal with no conversation id, which is what the route answers when the
      // host will not make one.
      createdId: undefined,
      createdExtra: { conversationId: undefined },
    });
    const doc = h.dom.window.document;
    doc.getElementById("search-toggle")!.click();
    (doc.getElementById("search-text") as HTMLInputElement).value = "nothing";
    doc.getElementById("search-bar")!.dispatchEvent(new h.dom.window.Event("submit", { cancelable: true }));
    await h.settle();

    const notice = doc.getElementById("attach-notice") as HTMLElement;
    assert.equal(notice.hidden, false, "the reader is told the search did not start");
    // And the button comes back: one failure must not leave it looking busy forever.
    assert.equal((doc.getElementById("search-go") as HTMLButtonElement).disabled, false);
  } finally {
    h?.close();
  }
});

test("the index can search too, through a conversation page's own box", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({ pathname: "/", conversations: [] });
    const doc = h.dom.window.document;
    (doc.getElementById("index-search") as HTMLButtonElement).click();
    await h.settle();

    const post = h.requests.find((r) => r.method === "POST");
    assert.ok(post, "the index made a conversation to search in");
    assert.match(post.url, /api\/conversations$/);
    // No query: the box is opened on the new page (`?search=1`), which is the only
    // place the form exists.
    assert.equal(post.body, undefined);
  } finally {
    h?.close();
  }
});

test("arriving with ?search=1 opens the box, and does not keep it in the address", async () => {
  let h: Harness | undefined;
  try {
    // The index's magnifier lands here: it made the conversation, and this is the page
    // whose form does the searching.
    h = await loadPage({
      pathname: "/7/?search=1",
      conversations: [{ conversationId: 7, chatKey: "k", model: "m" }],
    });
    const doc = h.dom.window.document;
    assert.equal((doc.getElementById("search-bar") as HTMLElement).hidden, false);
    assert.equal(doc.getElementById("search-toggle")!.getAttribute("aria-expanded"), "true");
    // The flag is transient: a reload should not reopen a box nobody asked for.
    assert.equal(h.dom.window.location.search, "");

    // And a conversation opened the ordinary way has no box.
    h.close();
    h = await loadPage({ pathname: "/7/", conversations: [{ conversationId: 7, chatKey: "k", model: "m" }] });
    assert.equal((h.dom.window.document.getElementById("search-bar") as HTMLElement).hidden, true);
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
    assert.equal(h.historyRequests[0]!.before, 0, "the first paint has no anchor");
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

    // The second page is anchored on the oldest id held — not on a count, so a turn appending while
    // somebody scrolls cannot shift it.
    assert.equal(h.historyRequests.length, 2);
    assert.equal(h.historyRequests[1]!.before, 71, "anchored on the oldest message already shown");
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

test("paging state is per conversation, so a reload does not resume someone else's anchor", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({
      conversations: [{ conversationId: 7, chatKey: "k", model: "m" }],
      history: transcriptOf(120),
    });
    const win = h.dom.window;
    const log = win.document.getElementById("log")!;

    // Page 7 back once, so its anchor has moved.
    log.scrollTop = 0;
    log.dispatchEvent(new win.Event("scroll"));
    await h.settle();
    assert.equal(h.historyRequests.at(-1)!.before, 71);

    // Switching conversations is a full navigation in this page (the index links
    // to `/<id>/`), so the equivalent of "opening another one" is a fresh load.
    // What matters is that every load starts with no anchor: one carried over would name an entry id
    // from a different thread.
    const second = await loadPage({
      conversations: [{ conversationId: 9, chatKey: "k2", model: "m" }],
      pathname: "/9/",
      history: transcriptOf(120),
    });
    try {
      assert.equal(second.historyRequests[0]!.before, 0, "a new conversation starts at its newest page");
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
/**
 * The frame the drawer is *showing*.
 *
 * There is no single `#artifact-frame` any more: each document gets its own frame and
 * the drawer changes which one is in the middle rather than reloading one. A hidden
 * frame is one the pool is keeping warm, so the visible one is the current document.
 */
function artifactFrame(dom: JSDOM): HTMLIFrameElement {
  // The current document is the one in the middle slot, which is the frame carrying no
  // `order`. A neighbour is parked to one side with `order: -1` or `1`, and mid-step
  // both are visible — so "the visible one" is not enough to identify it.
  const frames = [...dom.window.document.querySelectorAll("#artifact-track .artifact-frame")] as HTMLIFrameElement[];
  const middle = frames.filter((frame) => !(frame as HTMLElement).hidden && frame.style.order === "");
  assert.equal(middle.length, 1, "exactly one document is in the middle");
  return middle[0]!;
}

/**
 * Post a message as the artifact document would, and let the handlers run.
 *
 * These messages are about the *channel* — a selection, a swipe — not about which
 * document is open, so the test needs a frame the page will accept as the sender.
 * With a document open that is the visible one; without one (the composer tests never
 * open a file) any frame in the strip will do, which is how the page behaves too: it
 * trusts `event.source`, and with nothing open there is no frame to trust.
 */
async function fromFrame(h: Harness, data: unknown): Promise<void> {
  const frame = artifactFrame(h.dom);
  h.dom.window.dispatchEvent(
    new h.dom.window.MessageEvent("message", { data, source: frame.contentWindow as Window }),
  );
  await h.settle();
}

/**
 * Open the first artifact, so a frame exists for the message channel to come from.
 *
 * The composer tests are about what the page does with a *selection*, not about which
 * document made it — but the page only accepts a message from the frame it knows
 * about, and there is no such frame until something is open.
 */
async function openFirstArtifact(h: Harness): Promise<void> {
  const doc = h.dom.window.document;
  (doc.getElementById("artifacts-toggle") as HTMLButtonElement).click();
  await h.settle();
  const row = doc.querySelector("#artifact-list li") as HTMLElement | null;
  assert.ok(row, "the drawer has a file to open");
  row.click();
  await h.settle();
}


test("a selection opens the composer without taking focus", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({
      pathname: "/7/",
      artifactsBaseUrl: "http://127.0.0.1:8082",
      artifacts: drawerFiles,
      conversations: [{ conversationId: 7, chatKey: "k", model: "m" }],
    });
    await openFirstArtifact(h);
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
    h = await loadPage({
      pathname: "/7/",
      artifactsBaseUrl: "http://127.0.0.1:8082",
      artifacts: drawerFiles,
      conversations: [{ conversationId: 7, chatKey: "k", model: "m" }],
    });
    await openFirstArtifact(h);
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
    h = await loadPage({
      pathname: "/7/",
      artifactsBaseUrl: "http://127.0.0.1:8082",
      artifacts: drawerFiles,
      conversations: [{ conversationId: 7, chatKey: "k", model: "m" }],
    });
    await openFirstArtifact(h);
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
    h = await loadPage({
      pathname: "/7/",
      artifactsBaseUrl: "http://127.0.0.1:8082",
      artifacts: drawerFiles,
      conversations: [{ conversationId: 7, chatKey: "k", model: "m" }],
    });
    await openFirstArtifact(h);
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
    assert.match(artifactFrame(h.dom).getAttribute("src") ?? "", /notes\.md\?render$/);
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

test("an image opens as itself, not as the source view", async () => {
  // The drawer framed every artifact the same way: `?view=source`, which builds a
  // numbered-lines page around the file's text. For a picture that is a page of
  // mojibake — the file *is* the document, so it is framed without a view at all.
  let h: Harness | undefined;
  try {
    h = await loadPage({
      pathname: "/7/",
      artifactsBaseUrl: "http://127.0.0.1:8082",
      artifacts: [
        { key: "conversation/7/shot.png", image: true, wrote: 1, edited: 0 },
        ...drawerFiles,
      ],
      conversations: [{ conversationId: 7, chatKey: "k", model: "m" }],
    });
    await h.settle();
    const doc = h.dom.window.document;
    assert.deepEqual(h.errors, []);

    // Open the drawer, then the picture.
    (doc.getElementById("artifacts-toggle") as HTMLButtonElement).click();
    await h.settle();
    const rows = [...doc.querySelectorAll("#artifact-list li")] as HTMLElement[];
    const picture = rows.find((row) => row.dataset.key === "conversation/7/shot.png");
    assert.ok(picture, "the image is listed");
    // And it says what it is, so a name does not have to be decoded.
    assert.match(picture!.querySelector(".counts")!.textContent!, /image/);
    assert.equal(picture!.dataset.image, "1");

    picture!.click();
    await h.settle();

    const src = artifactFrame(h.dom).getAttribute("src") ?? "";
    assert.equal(src, "http://127.0.0.1:8082/c/7/conversation/7/shot.png");
    assert.doesNotMatch(src, /view=source/, "no source view around a picture");
    // Marked on the frame so the drawer can draw a backdrop rather than a white slab.
    assert.ok(artifactFrame(h.dom).classList.contains("image"));

    // The header's ↗ opens the picture itself, not the document that wraps it: a
    // new tab is where you want the image, with the browser's own viewer, its
    // zoom, and "Save image as".
    (doc.getElementById("artifacts-newtab") as HTMLButtonElement).click();
    await h.settle();
    const call = h.opened.at(-1);
    assert.ok(call, "a tab was opened");
    assert.equal(call![0], "http://127.0.0.1:8082/c/7/conversation/7/shot.png?raw");
  } finally {
    h?.close();
  }
});

test("a text file still opens the source view, and markdown still renders", async () => {
  // The image branch must not have swallowed the other two kinds.
  let h: Harness | undefined;
  try {
    h = await loadPage({
      pathname: "/7/",
      hash: "#conversation%2F7%2Frun.sh",
      artifactsBaseUrl: "http://127.0.0.1:8082",
      artifacts: drawerFiles,
      conversations: [{ conversationId: 7, chatKey: "k", model: "m" }],
    });
    await h.settle();
    const doc = h.dom.window.document;
    assert.match(artifactFrame(h.dom).getAttribute("src") ?? "", /run\.sh\?view=source$/);
    assert.equal(artifactFrame(h.dom).classList.contains("image"), false);
  } finally {
    h?.close();
  }
});

test("arrow keys walk the artifacts, and stop at the ends", async () => {
  // The keyboard's version of the swipe: with a document open, left and right move
  // through the list in the order it is displayed.
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
    const title = () => doc.getElementById("artifacts-title")!.textContent;

    assert.equal(title(), "notes.md");
    // Forward: notes.md is the first row, so right moves to run.sh.
    doc.dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await h.settle();
    assert.equal(title(), "run.sh");
    assert.match(artifactFrame(h.dom).getAttribute("src") ?? "", /run\.sh\?view=source/);

    // Back: run.sh is the last row, so left returns to notes.md.
    doc.dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    await h.settle();
    assert.equal(title(), "notes.md");

    // Past the first row there is nowhere to go, and nothing changes.
    const before = artifactFrame(h.dom).getAttribute("src");
    doc.dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    await h.settle();
    assert.equal(title(), "notes.md");
    assert.equal(artifactFrame(h.dom).getAttribute("src"), before);
  } finally {
    h?.close();
  }
});

test("arrow keys do not page the drawer while typing", async () => {
  // The composer is on the same page, and an arrow key in a text box belongs to the
  // text — moving the cursor, not turning a page.
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
    const box = doc.getElementById("text") as HTMLTextAreaElement;
    box.dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await h.settle();
    assert.equal(doc.getElementById("artifacts-title")!.textContent, "notes.md", "the document did not change");
  } finally {
    h?.close();
  }
});

test("a swipe in the document moves to the next or previous artifact", async () => {
  // The framed document is cross-origin, so the page never sees the finger: the
  // script inside reports which way it went, exactly as it reports a selection.
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
    const title = () => doc.getElementById("artifacts-title")!.textContent;

    // A finger moving left asks for the next artifact. The drag comes first, because
    // that is what loads the neighbour to be carried in; a release alone has nothing
    // to move to.
    await fromFrame(h, { t: "pi-artifact-drag", dx: -140 });
    await fromFrame(h, { t: "pi-artifact-swipe", direction: "left", commit: true });
    assert.equal(title(), "run.sh", "swipe left goes forward");
    // And moving right asks for the previous one.
    await fromFrame(h, { t: "pi-artifact-drag", dx: 140 });
    await fromFrame(h, { t: "pi-artifact-swipe", direction: "right", commit: true });
    assert.equal(title(), "notes.md", "swipe right goes back");

    // An unknown direction is ignored rather than guessed at.
    const src = artifactFrame(h.dom).getAttribute("src");
    await fromFrame(h, { t: "pi-artifact-drag", dx: -140 });
    await fromFrame(h, { t: "pi-artifact-swipe", direction: "sideways", commit: true });
    assert.equal(artifactFrame(h.dom).getAttribute("src"), src);
  } finally {
    h?.close();
  }
});

test("a drag moves the pane while the finger is still down", async () => {
  // The request: the pane used to do nothing until release. Following the finger is
  // what makes the gesture feel connected to the content.
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
    const pane = doc.getElementById("artifact-track") as HTMLElement;

    await fromFrame(h, { t: "pi-artifact-drag", dx: -120 });
    // Moved, and with no transition: it is under the finger, not easing after it.
    assert.match(pane.style.transform, /translateX\(-120px\)/);
    assert.equal(pane.classList.contains("no-animate"), true);

    // Releasing back where it started returns it.
    await fromFrame(h, { t: "pi-artifact-drag-end", commit: false });
    assert.equal(pane.style.transform, "");
    assert.equal(pane.classList.contains("no-animate"), false);
    assert.equal(doc.getElementById("artifacts-title")!.textContent, "notes.md", "nothing was paged");
  } finally {
    h?.close();
  }
});

test("a drag past the end of the list is damped rather than following freely", async () => {
  // A pane that slides as far as the finger when there is no next document promises
  // something that is not there.
  let h: Harness | undefined;
  try {
    h = await loadPage({
      pathname: "/7/",
      hash: "#conversation%2F7%2Frun.sh",
      artifactsBaseUrl: "http://127.0.0.1:8082",
      artifacts: drawerFiles,
      conversations: [{ conversationId: 7, chatKey: "k", model: "m" }],
    });
    await h.settle();
    const doc = h.dom.window.document;
    const pane = doc.getElementById("artifact-track") as HTMLElement;

    // run.sh is the *last* row, so dragging forward has nowhere to go.
    await fromFrame(h, { t: "pi-artifact-drag", dx: -200 });
    const damped = /translateX\((-?[\d.]+)px\)/.exec(pane.style.transform);
    assert.ok(damped, pane.style.transform);
    assert.ok(Math.abs(Number(damped![1])) < 200, `expected damping, got ${damped![1]}px`);
    assert.ok(Math.abs(Number(damped![1])) > 0, "but it still moves a little, which is the feedback");
  } finally {
    h?.close();
  }
});

test("a release that commits pages, and one that cancels does not", async () => {
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
    const title = () => doc.getElementById("artifacts-title")!.textContent;

    // Dragged, then released short: no page turn.
    await fromFrame(h, { t: "pi-artifact-drag", dx: -40 });
    await fromFrame(h, { t: "pi-artifact-swipe", direction: "left", commit: false });
    assert.equal(title(), "notes.md");

    // Dragged the same way, released as a commit: pages.
    await fromFrame(h, { t: "pi-artifact-drag", dx: -140 });
    await fromFrame(h, { t: "pi-artifact-swipe", direction: "left", commit: true });
    assert.equal(title(), "run.sh");
  } finally {
    h?.close();
  }
});

test("a swipe does not touch the address, so Back still closes the document", async () => {
  // Stepping is not travelling: pushing a history entry per swipe would make Back
  // undo one swipe at a time instead of closing the drawer, which is not what the
  // gesture looks like it means.
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
    assert.equal(h.dom.window.location.hash, "#conversation%2F7%2Fnotes.md");

    await fromFrame(h, { t: "pi-artifact-drag", dx: -140 });
    await fromFrame(h, { t: "pi-artifact-swipe", direction: "left", commit: true });
    assert.equal(doc.getElementById("artifacts-title")!.textContent, "run.sh");
    // The fragment still names what was opened.
    assert.equal(h.dom.window.location.hash, "#conversation%2F7%2Fnotes.md");
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
    assert.match(artifactFrame(h.dom).getAttribute("src") ?? "", /notes\.md\?render$/);
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
    assert.match(artifactFrame(h.dom).getAttribute("src") ?? "", /run\.sh\?view=source$/, "a script opens as source");

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
      // Only `ok`, `status` and `json` are read by the page; the cast says so rather
      // than pretending this is a whole `Response`.
      return {
        ok: true,
        status: 200,
        json: async () => ({
          kind: "list",
          title: "Recent conversations",
          rows: [{ label: "earlier", detail: "2h ago", command: "/resume 9", current: false }],
        }),
      } as unknown as Response;
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

test("changing the model asks again, so the levels are that model's", async () => {
  // The web form and the Chat card should behave the same way here: pick a model, and the thinking
  // select lists only what that model has. The page re-asks with `preview` rather than knowing the
  // dependency itself.
  let h: Harness | undefined;
  try {
    h = await loadPage({
      pathname: "/7/",
      conversations: [{ conversationId: 7, chatKey: "k", model: "m" }],
      commandResponse: {
        kind: "form",
        prompt: "Model and thinking level",
        command: "/model",
        fields: [
          {
            id: "model",
            label: "Model",
            kind: "select",
            value: "deepseek/deepseek-chat",
            requery: true,
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
            options: [{ id: "off", label: "off" }, { id: "medium", label: "medium", selected: true }],
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

    const model = doc.querySelector("#command-body select") as HTMLSelectElement;
    model.value = "anthropic/claude-sonnet-4";
    model.dispatchEvent(new h.dom.window.Event("change", { bubbles: true }));
    await h.settle();

    const posted = h.requests.filter((request) => request.url.includes("/commands"));
    const last = JSON.parse(posted[posted.length - 1]!.body ?? "{}");
    assert.deepEqual(last, {
      text: "/model",
      values: { model: "anthropic/claude-sonnet-4", thinking: "medium" },
      preview: true,
    });
  } finally {
    h?.close();
  }
});

test("a row about a conversation is a link here, because this page can open one", async () => {
  // The same `/sessions` row means "navigate" on this surface and "/resume" on Chat. The row carries
  // the conversation id; the surface chooses the verb.
  let h: Harness | undefined;
  try {
    h = await loadPage({
      pathname: "/7/",
      conversations: [{ conversationId: 7, chatKey: "k", model: "m" }],
      commandResponse: {
        kind: "list",
        title: "Recent conversations",
        rows: [
          { label: "this one", detail: "now", conversationId: 7, current: true },
          { label: "earlier", detail: "2h ago", conversationId: 9 },
        ],
      },
    });
    await h.settle();
    const doc = h.dom.window.document;
    const box = doc.getElementById("text") as HTMLTextAreaElement;
    box.value = "/sessions";
    doc.getElementById("send")!.dispatchEvent(new h.dom.window.Event("submit", { cancelable: true }));
    await h.settle();

    const rows = [...doc.querySelectorAll("#command-body .row")] as HTMLElement[];
    assert.equal(rows.length, 2);
    assert.ok(rows[1]!.classList.contains("clickable"), "a conversation row is pressable");
    assert.ok(rows[0]!.classList.contains("current"), "and the one being read is marked");
    // Pressing it navigates; it does not send a command. (jsdom refuses the navigation itself, so
    // what is asserted is that nothing was posted.)
    const before = h.requests.length;
    rows[1]!.click();
    await h.settle();
    assert.equal(h.requests.filter((request) => request.url.includes("/commands")).length, 1);
    assert.equal(h.requests.length >= before, true);
  } finally {
    h?.close();
  }
});

// --- The format picker -------------------------------------------------------
//
// The model was unreachable from this pane: the only way to change it was to type
// `/model` into the box, which needs both the command and the model's key. When the
// provider ran out of credit there was no visible way off that model at all. These
// pin the two buttons that replaced that, and the two rules that make a picker
// trustworthy: it shows what is actually in use, and it never offers a setting the
// server would refuse.

/** The picker's rows, as a test can read them. */
function pickerRows(doc: Document): HTMLButtonElement[] {
  return [...doc.querySelectorAll("#picker-list .item")] as HTMLButtonElement[];
}

const TWO_MODELS = [
  { provider: "deepseek", id: "deepseek-flash", label: "DeepSeek V4.1 Flash", levels: ["low", "high"] },
  { provider: "llama-local", id: "lfm3", label: "LFM3 (local)", levels: [] },
];

test("a conversation shows the format behind the send caret, without opening it", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({
      conversations: [{ conversationId: 7, chatKey: "k", model: "deepseek/deepseek-flash" }],
      format: { model: "deepseek/deepseek-flash", thinking: "high", levels: ["low", "high"] },
      models: TWO_MODELS,
    });
    await h.settle();
    const doc = h.dom.window.document;

    // The caret is the way in, and it is part of the send button rather than a
    // second control beside it.
    const menu = doc.getElementById("send-menu")!;
    assert.equal(menu.hidden, false, "the menu is reachable without typing a command");
    assert.equal(doc.getElementById("send-primary")!.textContent, "Send");

    // What is in use, in words, once the menu is open.
    (menu as HTMLButtonElement).click();
    await h.settle();
    // What is in use, while nothing is staged. (A staged choice takes the header
    // over — see the staging tests — because "what have I got selected?" is the
    // question an open popup raises.)
    const now = doc.getElementById("picker-now")!.textContent!;
    assert.match(now, /Next message: DeepSeek V4\.1 Flash/);
    assert.match(now, /thinking high/);
    assert.equal(doc.getElementById("picker-apply")!.hasAttribute("disabled"), true);
  } finally {
    h?.close();
  }
});

test("pressing the model button lists every model, marking the current one", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({
      conversations: [{ conversationId: 7, chatKey: "k", model: "deepseek/deepseek-flash" }],
      format: { model: "deepseek/deepseek-flash", thinking: "high", levels: ["low", "high"] },
      models: TWO_MODELS,
    });
    await h.settle();
    const doc = h.dom.window.document;
    (doc.getElementById("send-menu") as HTMLButtonElement).click();
    await h.settle();

    assert.equal(doc.getElementById("picker")!.hidden, false);
    const rows = pickerRows(doc);
    assert.equal(rows.length, 2, "every configured model, not just the current one");
    assert.equal(rows[0]!.classList.contains("current"), true);
    assert.equal(rows[1]!.classList.contains("current"), false);
  } finally {
    h?.close();
  }
});

test("a model row shows the name only, not its provider/key", async () => {
  // The key is the wire format, not something a person reads: "DeepSeek V4.1 Flash"
  // is the model, and `deepseek/deepseek-flash` under it is noise that made every
  // row twice as tall to say the same thing.
  let h: Harness | undefined;
  try {
    h = await loadPage({
      conversations: [{ conversationId: 7, chatKey: "k", model: "deepseek/deepseek-flash" }],
      format: { model: "deepseek/deepseek-flash", thinking: "high", levels: ["low", "high"] },
      models: TWO_MODELS,
    });
    await h.settle();
    const doc = h.dom.window.document;
    (doc.getElementById("send-menu") as HTMLButtonElement).click();
    await h.settle();

    const rows = pickerRows(doc);
    assert.equal(rows[0]!.querySelector(".detail"), null, "no key line under the name");
    assert.equal(rows[0]!.querySelector(".name span")!.textContent, "DeepSeek V4.1 Flash");
    assert.doesNotMatch(rows[0]!.textContent!, /deepseek\/deepseek-flash/);
    // The choice is still applied by key, whatever is shown. Row 1, because row 0
    // is the model already in use and staging it would leave Apply with nothing to do.
    pickerRows(doc)[1]!.click();
    await h.settle();
    applyButton(doc).click();
    await h.settle();
    assert.equal(modelPost(h)!.values.model, "llama-local/lfm3");
  } finally {
    h?.close();
  }
});

/** The Apply button, which is the only thing in the popup that sends anything. */
function applyButton(doc: Document): HTMLButtonElement {
  return doc.getElementById("picker-apply") as HTMLButtonElement;
}

/** A POST of `/model`, once one has happened. */
function modelPost(h: Harness): { text: string; values: Record<string, string | undefined> } | undefined {
  const post = h.requests.find((r) => r.method === "POST" && /commands$/.test(r.url));
  return post && post.body ? JSON.parse(post.body) : undefined;
}

test("choosing a model stages it and Apply sends /model with that model", async () => {
  // The reported bug: tapping a model applied it *and* closed the popup, so the
  // thinking level — the other half of the same answer — was gone before it could
  // be picked. A tap now stages, and Apply is the one thing that commits.
  let h: Harness | undefined;
  try {
    h = await loadPage({
      conversations: [{ conversationId: 7, chatKey: "k", model: "deepseek/deepseek-flash" }],
      format: { model: "deepseek/deepseek-flash", thinking: "high", levels: ["low", "high"] },
      models: TWO_MODELS,
      commandResponse: { kind: "form", prompt: "Model and thinking level", command: "/model", fields: [] },
    });
    await h.settle();
    const doc = h.dom.window.document;
    (doc.getElementById("send-menu") as HTMLButtonElement).click();
    await h.settle();

    // Nothing is staged yet, so Apply has nothing to do and says so.
    assert.equal(applyButton(doc).disabled, true, "Apply is disabled with nothing chosen");

    pickerRows(doc)[1]!.click();
    await h.settle();

    // Staged, not applied: the popup is still open, with the choice marked.
    assert.equal(doc.getElementById("picker")!.hidden, false, "the popup survives the tap");
    assert.equal(pickerRows(doc)[1]!.classList.contains("staged"), true);
    assert.equal(modelPost(h), undefined, "a tap alone changes nothing");
    assert.equal(applyButton(doc).disabled, false, "Apply has a choice to send");
    assert.match(doc.getElementById("picker-staged")!.textContent!, /LFM3/);

    applyButton(doc).click();
    await h.settle();

    const body = modelPost(h);
    assert.ok(body, "the change goes through the command, not a bespoke endpoint");
    assert.equal(body!.text, "/model");
    assert.equal(body!.values.model, "llama-local/lfm3");
    // A level the new model does not have is replaced, not sent to be refused:
    // switching to a local model should not mean switching twice.
    assert.equal(body!.values.thinking, undefined);

    // And the popup shuts once it has been committed.
    assert.equal(doc.getElementById("picker")!.hidden, true);
  } finally {
    h?.close();
  }
});

test("a model and a thinking level are chosen in one visit to the popup", async () => {
  // The whole reason the popup no longer closes on a model: the new model's levels
  // have to be reachable, and both halves sent together.
  let h: Harness | undefined;
  try {
    h = await loadPage({
      conversations: [{ conversationId: 7, chatKey: "k", model: "llama-local/lfm3" }],
      format: { model: "llama-local/lfm3", levels: [] },
      models: TWO_MODELS,
      commandResponse: { kind: "form", prompt: "Model and thinking level", command: "/model", fields: [] },
    });
    await h.settle();
    const doc = h.dom.window.document;
    (doc.getElementById("send-menu") as HTMLButtonElement).click();
    await h.settle();

    // The model in use has no levels, so there is no thinking section at all.
    assert.equal(doc.getElementById("picker-levels")!.hidden, true);

    // Pick a model that does think: its levels appear without a round trip, because
    // the list already carries them.
    pickerRows(doc)[0]!.click();
    await h.settle();
    assert.equal(doc.getElementById("picker")!.hidden, false);
    const levels = [...doc.querySelectorAll("#picker-levels .item")] as HTMLButtonElement[];
    assert.deepEqual(levels.map((row) => row.querySelector(".name span")!.textContent), ["low", "high"]);

    // Then the level, still in the same popup.
    levels[1]!.click();
    await h.settle();
    assert.equal(doc.getElementById("picker")!.hidden, false, "a level tap does not apply either");
    assert.equal(modelPost(h), undefined);

    applyButton(doc).click();
    await h.settle();

    const body = modelPost(h);
    assert.ok(body);
    assert.deepEqual(body!.values, { model: "deepseek/deepseek-flash", thinking: "high" });
  } finally {
    h?.close();
  }
});

test("Apply does nothing, and is disabled, when the choice is what is already in use", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({
      conversations: [{ conversationId: 7, chatKey: "k", model: "deepseek/deepseek-flash" }],
      format: { model: "deepseek/deepseek-flash", thinking: "high", levels: ["low", "high"] },
      models: TWO_MODELS,
      commandResponse: { kind: "form", prompt: "Model and thinking level", command: "/model", fields: [] },
    });
    await h.settle();
    const doc = h.dom.window.document;
    (doc.getElementById("send-menu") as HTMLButtonElement).click();
    await h.settle();

    // The current model, at the current level: staging "more" would send a no-op.
    pickerRows(doc)[0]!.click();
    await h.settle();
    assert.equal(applyButton(doc).disabled, true);
    assert.match(doc.getElementById("picker-staged")!.textContent!, /already in use/);

    // The current model at a *different* level is a real change, so Apply awakes.
    const levels = [...doc.querySelectorAll("#picker-levels .item")] as HTMLButtonElement[];
    levels[0]!.click();
    await h.settle();
    assert.equal(applyButton(doc).disabled, false);
    assert.equal(modelPost(h), undefined);
  } finally {
    h?.close();
  }
});

test("closing the popup drops a staged choice rather than applying it later", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({
      conversations: [{ conversationId: 7, chatKey: "k", model: "deepseek/deepseek-flash" }],
      format: { model: "deepseek/deepseek-flash", thinking: "high", levels: ["low", "high"] },
      models: TWO_MODELS,
      commandResponse: { kind: "form", prompt: "Model and thinking level", command: "/model", fields: [] },
    });
    await h.settle();
    const doc = h.dom.window.document;
    const caret = doc.getElementById("send-menu") as HTMLButtonElement;
    caret.click();
    await h.settle();
    pickerRows(doc)[1]!.click();
    await h.settle();

    // Escape is "never mind".
    doc.dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await h.settle();
    assert.equal(doc.getElementById("picker")!.hidden, true);
    assert.equal(modelPost(h), undefined);

    // Reopening starts from what is in use, not from the abandoned pick.
    caret.click();
    await h.settle();
    assert.equal(pickerRows(doc)[0]!.classList.contains("staged"), false, "no leftover stage");
    assert.equal(applyButton(doc).disabled, true);
    assert.match(doc.getElementById("picker-now")!.textContent!, /Next message:/);
  } finally {
    h?.close();
  }
});

test("the menu lists only the current model's thinking levels", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({
      conversations: [{ conversationId: 7, chatKey: "k", model: "deepseek/deepseek-flash" }],
      format: { model: "deepseek/deepseek-flash", thinking: "high", levels: ["low", "high"] },
      models: TWO_MODELS,
    });
    await h.settle();
    const doc = h.dom.window.document;
    (doc.getElementById("send-menu") as HTMLButtonElement).click();
    await h.settle();

    const levels = [...doc.querySelectorAll("#picker-levels .item")];
    assert.deepEqual(levels.map((row) => row.querySelector(".name span")!.textContent), ["low", "high"]);
    // Never a search box here: a handful of levels is a glance.
    assert.equal(doc.getElementById("picker-search")!.parentElement!.hidden, true);
  } finally {
    h?.close();
  }
});

test("a model with no thinking levels has no thinking section", async () => {
  // A dead button that opens an empty list is worse than no button: it reads as
  // broken rather than as "this model does not think".
  let h: Harness | undefined;
  try {
    h = await loadPage({
      conversations: [{ conversationId: 7, chatKey: "k", model: "llama-local/lfm3" }],
      format: { model: "llama-local/lfm3", levels: [] },
      models: TWO_MODELS,
    });
    await h.settle();
    const doc = h.dom.window.document;
    (doc.getElementById("send-menu") as HTMLButtonElement).click();
    await h.settle();
    // The model list is still there; only the thinking section is gone.
    assert.ok(pickerRows(doc).length > 0, "the model list is still offered");
    assert.equal(doc.getElementById("picker-levels")!.hidden, true, "no levels, no section");
  } finally {
    h?.close();
  }
});

test("a refinement narrower than the list filters it", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({
      conversations: [{ conversationId: 7, chatKey: "k", model: "deepseek/deepseek-flash" }],
      format: { model: "deepseek/deepseek-flash", thinking: "high", levels: ["low", "high"] },
      models: TWO_MODELS,
    });
    await h.settle();
    const doc = h.dom.window.document;
    (doc.getElementById("send-menu") as HTMLButtonElement).click();
    await h.settle();
    assert.equal(pickerRows(doc).length, 2);

    const search = doc.getElementById("picker-search") as HTMLInputElement;
    search.value = "local";
    search.dispatchEvent(new h.dom.window.Event("input", { bubbles: true }));
    await h.settle();

    const rows = pickerRows(doc);
    assert.equal(rows.length, 1, "only the matching model");
    assert.match(rows[0]!.textContent!, /LFM3/);
  } finally {
    h?.close();
  }
});

test("escape closes the picker and nothing else", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({
      conversations: [{ conversationId: 7, chatKey: "k", model: "deepseek/deepseek-flash" }],
      format: { model: "deepseek/deepseek-flash", thinking: "high", levels: ["low", "high"] },
      models: TWO_MODELS,
    });
    await h.settle();
    const doc = h.dom.window.document;
    (doc.getElementById("send-menu") as HTMLButtonElement).click();
    await h.settle();
    assert.equal(doc.getElementById("picker")!.hidden, false);

    doc.dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await h.settle();
    assert.equal(doc.getElementById("picker")!.hidden, true);
    // The scrim goes with it, or the page stays covered by an invisible sheet.
    assert.equal(doc.getElementById("picker-scrim")!.hidden, true);
    assert.equal(doc.getElementById("picker-search")!.parentElement!.hidden, true);
  } finally {
    h?.close();
  }
});

test("a conversation with no format does not claim to know the model", async () => {
  // An older host, or one that could not answer. The caret still works — a model can
  // still be chosen — but the header does not assert one it was never told.
  let h: Harness | undefined;
  try {
    h = await loadPage({ conversations: [{ conversationId: 7, chatKey: "k", model: "deepseek/deepseek-flash" }] });
    await h.settle();
    const doc = h.dom.window.document;
    (doc.getElementById("send-menu") as HTMLButtonElement).click();
    await h.settle();
    assert.doesNotMatch(doc.getElementById("picker-now")!.textContent!, /Next message:/);
  } finally {
    h?.close();
  }
});

test("a repeated failure backs off instead of hammering every second", async () => {
  // A fixed one-second retry is right for a bridge that is restarting and wrong for
  // one that is down for an hour: 3,600 requests, and no room for the restarter to
  // breathe. The delay doubles.
  let h: Harness | undefined;
  try {
    h = await loadPage({ pathname: "/7/", conversations: [{ conversationId: 7, chatKey: "k", model: "m" }] });
    const doc = h.dom.window.document;

    // Fail three times in a row, waiting out each (short) backoff.
    for (const wait of [1100, 2100]) {
      const last = h.sources.at(-1)!;
      last.close();
      last.triggerError();
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    const last = h.sources.at(-1)!;
    last.close();
    last.triggerError();

    // From the third attempt on, the footer says how long it is waiting — otherwise
    // "reconnecting…" that never resolves is indistinguishable from a dead page.
    assert.match(doc.getElementById("tool")?.textContent ?? "", /reconnecting… \(\d+s\)/);
    // And the attempt count is bounded by the waits, not by the elapsed time: a
    // fixed 1s retry would have produced one attempt per second.
    assert.ok(h.sources.length <= 4, `expected backoff, got ${h.sources.length} attempts`);
  } finally {
    h?.close();
  }
});

test("a backed-off footer still clears when a stream finally opens", async () => {
  // The bug this pins: the open handler compared the footer to the literal
  // "reconnecting…", so once the backoff started printing "reconnecting… (4s)" the
  // comparison never matched and the footer kept claiming to reconnect on a
  // perfectly healthy stream.
  let h: Harness | undefined;
  try {
    h = await loadPage({ pathname: "/7/", conversations: [{ conversationId: 7, chatKey: "k", model: "m" }] });
    const doc = h.dom.window.document;

    // Get into the state where the footer carries a delay.
    for (const wait of [1100, 2100, 4100]) {
      const current = h.sources.at(-1)!;
      current.close();
      current.triggerError();
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    assert.match(doc.getElementById("tool")?.textContent ?? "", /\(\d+s\)/);

    // Now the stream opens.
    h.sources.at(-1)!.listeners.get("open")?.forEach((fn) => fn({ data: "" }));
    assert.equal(doc.getElementById("tool")?.textContent ?? "", "");
  } finally {
    h?.close();
  }
});

test("coming back to the tab after a long silence reconnects even if the stream looks open", async () => {
  // A slept laptop or a dead NAT entry leaves a stream that never errored and still
  // reports OPEN, so the old visibility check — "reconnect only if readyState !== 1" —
  // did nothing and the pane silently stopped updating.
  let h: Harness | undefined;
  try {
    h = await loadPage({ pathname: "/7/", conversations: [{ conversationId: 7, chatKey: "k", model: "m" }] });
    const doc = h.dom.window.document;
    assert.equal(h.sources.length, 1);

    // Open, never delivered anything, and time has passed.
    const realNow = Date.now;
    h.dom.window.Date.now = () => realNow() + 120_000;
    try {
      Object.defineProperty(doc, "visibilityState", { value: "visible", configurable: true });
      doc.dispatchEvent(new h.dom.window.Event("visibilitychange"));
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      h.dom.window.Date.now = realNow;
    }

    assert.equal(h.sources.length, 2, "the stale stream was replaced");
  } finally {
    h?.close();
  }
});

// --- Catching up ------------------------------------------------------------
//
// The reported bug: come back to a conversation after the phone was off, and the pane is a page
// behind until you reload. Replacing the stream was never enough on its own — a stream's frames are
// deltas about the *live* turn, and the answer that arrived while nobody was watching is in the
// transcript, which no frame mentions. Worse, when the stream was replaced the first frame was
// already consumed by the stream the page had thrown away, so even a running turn drew nothing.

test("a reconnected stream re-reads the transcript, so an answer that arrived while away appears", async () => {
  let h: Harness | undefined;
  try {
    const arrival = { role: "assistant", text: "the backup finished", html: "<p>the backup finished</p>" };
    const fixture = [
      { role: "user", text: "did the backup run", html: "<p>did the backup run</p>" },
    ];
    h = await loadPage({
      pathname: "/7/",
      conversations: [{ conversationId: 7, chatKey: "k", model: "m" }],
      history: fixture,
    });
    const log = h.dom.window.document.getElementById("log")!;
    assert.ok(!(log.textContent ?? "").includes("the backup finished"));

    // The phone was off; the answer landed. The stream the browser dropped is replaced.
    fixture.push(arrival);
    const first = h.sources[0]!;
    first.close();
    first.triggerError();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(h.sources.length, 2, "the page reopened the stream");

    // What a reconnect does the server-side: `open`, then the frames.
    h.sources[1]!.listeners.get("open")?.forEach((fn) => fn({ data: "" }));
    await h.settle();

    assert.match(log.textContent ?? "", /the backup finished/, "the answer is on screen without a reload");
    // And the catch-up asked for the newest page, not for a page anchored somewhere in the past.
    assert.equal(h.historyRequests.length, 2, "history was read once on open and once on reconnect");
    assert.equal(h.historyRequests.at(-1)!.before, 0);
  } finally {
    h?.close();
  }
});

test("coming back to a live stream still catches up on the transcript", async () => {
  // The other half. A stream can be perfectly open and still know nothing about a finished turn: the
  // turn's frames went to a tab that was hidden, and an idle conversation then sends nothing at all.
  // So the visibility handler must re-read history even when it leaves the stream alone.
  let h: Harness | undefined;
  try {
    const fixture = [{ role: "user", text: "kick off the rebuild", html: "<p>kick off the rebuild</p>" }];
    h = await loadPage({
      pathname: "/7/",
      conversations: [{ conversationId: 7, chatKey: "k", model: "m" }],
      history: fixture,
    });
    const doc = h.dom.window.document;
    const log = doc.getElementById("log")!;
    await h.settle();
    assert.equal(h.sources.length, 1);

    fixture.push({ role: "assistant", text: "rebuild done", html: "<p>rebuild done</p>" });
    const realNow = Date.now;
    h.dom.window.Date.now = () => realNow() + 1_000; // a stream that just proved it is alive
    try {
      Object.defineProperty(doc, "visibilityState", { value: "visible", configurable: true });
      doc.dispatchEvent(new h.dom.window.Event("visibilitychange"));
      await h.settle();
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      h.dom.window.Date.now = realNow;
    }

    assert.equal(h.sources.length, 1, "a healthy stream is left alone");
    assert.match(log.textContent ?? "", /rebuild done/, "and the pane caught up anyway");
  } finally {
    h?.close();
  }
});

test("a reconnect mid-turn shows the turn, even though no frame carries it", async () => {
  // Frames are deltas: they are only sent when the live text changes. A stream opened while the model
  // is silent sends its first frame to the stream the page has already replaced, so the pane draws a
  // turn that is running as though nothing were happening at all.
  let h: Harness | undefined;
  let liveness: unknown;
  try {
    liveness = { text: "", turn: "", busy: true };
    h = await loadPage({
      pathname: "/7/",
      conversations: [{ conversationId: 7, chatKey: "k", model: "m" }],
      live: liveness as { text: string; turn?: string; busy: boolean },
    });
    const log = h.dom.window.document.getElementById("log")!;

    // The turn starts while the phone is locked: the server is busy, saying nothing yet.
    const first = h.sources[0]!;
    first.close();
    first.triggerError();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    h.sources[1]!.listeners.get("open")?.forEach((fn) => fn({ data: "" }));
    await h.settle();
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.match(log.textContent ?? "", /thinking…/, "the running turn is visible after the reconnect");
  } finally {
    h?.close();
  }
});

test("a failed catch-up leaves the conversation on screen", async () => {
  // The catch-up runs on every return to the tab, so it is the request most likely to meet a flaky
  // connection. Emptying the transcript on failure would turn a readable conversation into a blank
  // pane — and the repaint would take the live block with it.
  let h: Harness | undefined;
  try {
    h = await loadPage({
      pathname: "/7/",
      conversations: [{ conversationId: 7, chatKey: "k", model: "m" }],
      history: [{ role: "assistant", text: "worth keeping", html: "<p>worth keeping</p>" }],
    });
    const doc = h.dom.window.document;
    const log = doc.getElementById("log")!;
    await h.settle();
    assert.match(log.textContent ?? "", /worth keeping/);

    // Every later request fails the way an offline phone's do.
    (h.dom.window as unknown as Record<string, unknown>).fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    Object.defineProperty(doc, "visibilityState", { value: "visible", configurable: true });
    doc.dispatchEvent(new h.dom.window.Event("visibilitychange"));
    await h.settle();
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.match(log.textContent ?? "", /worth keeping/, "a dropped catch-up does not wipe the pane");
  } finally {
    h?.close();
  }
});

test("a turn keeps what it already said while it goes on to the next step", async () => {
  // The report: a message appears, then is immediately replaced by "thinking…". A
  // turn is several messages — say something, call a tool, say something else — and
  // rendering only the one in flight meant the paragraph being read vanished the
  // instant the model moved on.
  let h: Harness | undefined;
  try {
    h = await loadPage({ conversations: [{ conversationId: 7, chatKey: "k", model: "m" }] });
    const log = h.dom.window.document.getElementById("log")!;
    const source = h.sources[0]!;

    // The first message of the turn, then the frame where it has moved on and the
    // live message is briefly empty.
    source.emit("text", { text: "Looking at that: the radii differ.", busy: true });
    source.emit("text", { text: "", turn: "Looking at that: the radii differ.", busy: true });

    const bubble = log.querySelector(".msg.live .bubble")!;
    // The earlier words are still on screen...
    assert.match(bubble.textContent ?? "", /the radii differ/);
    // ...and the status sits under them rather than in their place.
    assert.match(bubble.textContent ?? "", /thinking…/);
    const said = bubble.querySelector(".said")!;
    const status = bubble.querySelector(".status")!;
    assert.ok(said && status, "both blocks present");
    // Reading order: what was said, then what is happening now.
    assert.ok(said.compareDocumentPosition(status) & 4, "the status follows the text");
  } finally {
    h?.close();
  }
});

test("the live message is appended under the text already said, not over it", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({ conversations: [{ conversationId: 7, chatKey: "k", model: "m" }] });
    const log = h.dom.window.document.getElementById("log")!;
    const source = h.sources[0]!;

    source.emit("text", { text: "The fix is", turn: "Looking at that.", busy: true });
    const bubble = log.querySelector(".msg.live .bubble")!;
    assert.equal(bubble.querySelector(".said")!.textContent, "Looking at that.");
    assert.equal(bubble.querySelector(".current")!.textContent, "The fix is");
    // No status line while text is arriving: a growing message is its own evidence.
    assert.equal(bubble.querySelector(".status"), null);
  } finally {
    h?.close();
  }
});

test("a tool run shows alongside the words that announced it", async () => {
  // Same report, the other half: a tool run should not replace the message.
  let h: Harness | undefined;
  try {
    h = await loadPage({ conversations: [{ conversationId: 7, chatKey: "k", model: "m" }] });
    const log = h.dom.window.document.getElementById("log")!;
    const source = h.sources[0]!;

    source.emit("text", { text: "", turn: "Now let me check the values.", busy: true });
    source.emit("tool", { name: "bash", status: "running", line: "bash: rg radii" });

    const bubble = log.querySelector(".msg.live .bubble")!;
    assert.match(bubble.textContent ?? "", /Now let me check the values\./);
    assert.match(bubble.textContent ?? "", /bash: rg radii/);
  } finally {
    h?.close();
  }
});

// --- The touch affordance ----------------------------------------------------
//
// On a phone the document draws nothing: the platform's own selection menu sits above
// the page in a layer no page can draw over, so the action moves here and *waits* for
// that menu to go. These pin the waiting, because "appears immediately" is the bug the
// delay exists to avoid, and "appears eventually" is the whole point.

test("the touch bar appears only after the selection has settled", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({
      pathname: "/7/",
      artifactsBaseUrl: "http://127.0.0.1:8082",
      artifacts: drawerFiles,
      conversations: [{ conversationId: 7, chatKey: "k", model: "m" }],
    });
    await openFirstArtifact(h);
    const bar = h.dom.window.document.getElementById("selection-bar")!;
    assert.equal(bar.hidden, true, "nothing before a selection");

    await fromFrame(h, {
      t: "pi-artifact-select-touch",
      message: { file: "notes.md", line: 3, quote: "scattered values", intent: "comment" },
    });

    // Still hidden right away: this is the window in which the platform menu is up, and
    // a bar underneath it is the reported bug.
    assert.equal(bar.hidden, true, "not immediately — the system menu is still showing");

    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal(bar.hidden, false, "and then it appears");
    assert.match(bar.textContent ?? "", /scattered values/);
  } finally {
    h?.close();
  }
});

test("a selection dismissed during the wait never shows the bar", async () => {
  // The bar is on a timer, so the timer has to be cancellable — otherwise a bar arrives
  // for a selection that no longer exists, offering to comment on nothing.
  let h: Harness | undefined;
  try {
    h = await loadPage({
      pathname: "/7/",
      artifactsBaseUrl: "http://127.0.0.1:8082",
      artifacts: drawerFiles,
      conversations: [{ conversationId: 7, chatKey: "k", model: "m" }],
    });
    await openFirstArtifact(h);
    const bar = h.dom.window.document.getElementById("selection-bar")!;

    await fromFrame(h, {
      t: "pi-artifact-select-touch",
      message: { file: "notes.md", line: 3, quote: "gone in a moment", intent: "comment" },
    });
    await fromFrame(h, { t: "pi-artifact-clear", file: "notes.md" });

    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal(bar.hidden, true, "the pending appearance was cancelled");
  } finally {
    h?.close();
  }
});

test("re-selecting restarts the wait, and shows the latest text", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({
      pathname: "/7/",
      artifactsBaseUrl: "http://127.0.0.1:8082",
      artifacts: drawerFiles,
      conversations: [{ conversationId: 7, chatKey: "k", model: "m" }],
    });
    await openFirstArtifact(h);
    const bar = h.dom.window.document.getElementById("selection-bar")!;

    await fromFrame(h, {
      t: "pi-artifact-select-touch",
      message: { file: "notes.md", line: 3, quote: "first attempt", intent: "comment" },
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    await fromFrame(h, {
      t: "pi-artifact-select-touch",
      message: { file: "notes.md", line: 3, quote: "the wider selection", intent: "comment" },
    });

    // The second selection restarted the clock, so it is still waiting.
    assert.equal(bar.hidden, true);
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal(bar.hidden, false);
    assert.match(bar.textContent ?? "", /the wider selection/);
    assert.doesNotMatch(bar.textContent ?? "", /first attempt/, "the quote follows the latest selection");
  } finally {
    h?.close();
  }
});

test("a selection being adjusted keeps the bar up rather than re-waiting", async () => {
  // Dragging a selection handle sends a fresh selection every few dozen milliseconds. If
  // each one restarted the wait, the bar would blink out from under the finger and come
  // back after it stopped — and a drag that outlasts the timer would never offer it at
  // all. The delay is for the platform's menu on the *first* selection, not for every
  // movement of one that is already being commented on.
  let h: Harness | undefined;
  try {
    h = await loadPage({
      pathname: "/7/",
      artifactsBaseUrl: "http://127.0.0.1:8082",
      artifacts: drawerFiles,
      conversations: [{ conversationId: 7, chatKey: "k", model: "m" }],
    });
    await openFirstArtifact(h);
    const bar = h.dom.window.document.getElementById("selection-bar")!;

    await fromFrame(h, {
      t: "pi-artifact-select-touch",
      message: { file: "notes.md", line: 3, quote: "first", intent: "comment" },
    });
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal(bar.hidden, false);

    // The handle moves: still the same gesture, so still offered.
    await fromFrame(h, {
      t: "pi-artifact-select-touch",
      message: { file: "notes.md", line: 3, quote: "first and more", intent: "comment" },
    });
    assert.equal(bar.hidden, false, "no second wait over a selection already offered");
    assert.match(bar.textContent ?? "", /first and more/, "but it follows the text");
  } finally {
    h?.close();
  }
});

test("opening the composer puts the touch bar away", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({
      pathname: "/7/",
      artifactsBaseUrl: "http://127.0.0.1:8082",
      artifacts: drawerFiles,
      conversations: [{ conversationId: 7, chatKey: "k", model: "m" }],
    });
    await openFirstArtifact(h);
    const doc = h.dom.window.document;
    await fromFrame(h, {
      t: "pi-artifact-select-touch",
      message: { file: "notes.md", line: 3, quote: "something", intent: "comment" },
    });
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal(doc.getElementById("selection-bar")!.hidden, false);

    (doc.getElementById("selection-comment") as HTMLButtonElement).click();
    // Two boxes competing for the same strip is worse than either alone.
    assert.equal(doc.getElementById("selection-bar")!.hidden, true);
    assert.equal(doc.getElementById("comment-bar")!.hidden, false, "the composer opened instead");
  } finally {
    h?.close();
  }
});

/* --- Signed out: a redirect the page can see ---------------------------------- */

test("a redirected request shows the sign-in banner, and keeps the draft", async () => {
  // Behind Cloudflare Access an expired session answers with a 302 to the login page. With the
  // default redirect mode that is a CORS failure indistinguishable from the network being down;
  // `redirect: "manual"` is what makes it visible, and this is the page noticing it.
  let h: Harness | undefined;
  try {
    h = await loadPage({ pathname: "/7/", conversations: [{ conversationId: 7, chatKey: "k", model: "m" }] });
    await h.settle();
    const doc = h.dom.window.document;
    const box = doc.getElementById("text") as HTMLTextAreaElement;

    // From here on, every request is answered the way Cloudflare answers an expired session.
    // The shape Cloudflare's redirect leaves behind: opaque, status 0, and `type` saying why.
    h.dom.window.fetch = (async () => ({
      ok: false,
      status: 0,
      type: "opaqueredirect",
      json: async () => ({}),
    })) as unknown as typeof fetch;

    box.value = "please remember me";
    doc.getElementById("send")!.dispatchEvent(new h.dom.window.Event("submit", { cancelable: true }));
    await h.settle();

    assert.equal((doc.getElementById("sign-in") as HTMLElement).hidden, false, "the banner is up");
    assert.match(doc.getElementById("sign-in")!.textContent ?? "", /session has expired/i);
    // The draft is the thing that must survive: clearing the box before the POST is how a message
    // typed into an expired session used to vanish without a trace.
    assert.equal(box.value, "please remember me", "and the message is still in the box");
    // Back to this page, not to the index: Cloudflare's redirect carries a `redirect_url`.
    assert.match((doc.getElementById("sign-in-link") as HTMLAnchorElement).href, /\/7\/$/);
  } finally {
    h?.close();
  }
});

test("a failed request that is not a redirect does not claim the session expired", async () => {
  let h: Harness | undefined;
  try {
    h = await loadPage({ pathname: "/7/", conversations: [{ conversationId: 7, chatKey: "k", model: "m" }] });
    await h.settle();
    const doc = h.dom.window.document;
    // A network failure: the fetch rejects. That is a different sentence, or no sentence at all.
    h.dom.window.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const box = doc.getElementById("text") as HTMLTextAreaElement;
    box.value = "still here";
    doc.getElementById("send")!.dispatchEvent(new h.dom.window.Event("submit", { cancelable: true }));
    await h.settle();
    assert.equal((doc.getElementById("sign-in") as HTMLElement).hidden, true, "no banner for a dropped connection");
    assert.equal(box.value, "still here");
  } finally {
    h?.close();
  }
});

// --- Step 1–2: entry ids in the DOM, and the #e<id> anchor ------------------------------------

test("every transcript row names the entry it came from", async () => {
  const h = await loadPage({
    history: [
      { role: "user", text: "first", html: "<p>first</p>", entryId: 41 },
      { role: "assistant", text: "second", html: "<p>second</p>", entryId: 42 },
    ],
  });
  // The anchor works by finding this attribute, so it is the whole basis of the feature.
  const marked = [...h.dom.window.document.querySelectorAll("[data-entry]")].map((row) => row.getAttribute("data-entry"));
  assert.deepEqual(marked, ["41", "42"]);
});

test("#e<id> scrolls the named message into view and marks it", async () => {
  const h = await loadPage({
    hash: "#e42",
    history: [
      { role: "user", text: "first", html: "<p>first</p>", entryId: 41 },
      { role: "assistant", text: "second", html: "<p>second</p>", entryId: 42 },
    ],
  });
  const row = h.dom.window.document.querySelector('[data-entry="42"]');
  assert.ok(row, "the row exists");
  assert.ok(row!.classList.contains("at-entry"), "the named row is marked");
  assert.ok(
    !h.dom.window.document.querySelector('[data-entry="41"]')!.classList.contains("at-entry"),
    "and only that row",
  );
});

test("a fragment naming a message that is not here says so", async () => {
  const h = await loadPage({
    hash: "#e999",
    history: [{ role: "user", text: "only message", html: "<p>only</p>", entryId: 41 }],
  });
  // Silently landing at the bottom of the thread is the failure this is here to prevent.
  assert.match(h.dom.window.document.body.textContent ?? "", /not in this conversation/);
});

test("an entry anchor is not mistaken for an artifact", async () => {
  const h = await loadPage({
    hash: "#e41",
    artifactsBaseUrl: "http://127.0.0.1:8082",
    artifacts: [{ key: "conversation/7/notes.md", markdown: true }],
    history: [{ role: "user", text: "first", html: "<p>first</p>", entryId: 41 }],
  });
  // Both live in one fragment. Reading `#e41` as a key would find nothing, drop it, and lose the
  // position — which is silent, so it needs a test.
  // The document list is still the list, not a document: the fragment was read as an entry.
  assert.equal(h.dom.window.document.querySelectorAll("#artifacts-list .doc").length, 0);
  assert.ok(h.dom.window.document.querySelector('[data-entry="41"]')?.classList.contains("at-entry"));
});

test("an artifact fragment still opens the document", async () => {
  const h = await loadPage({
    hash: "#conversation%2F7%2Fnotes.md",
    artifactsBaseUrl: "http://127.0.0.1:8082",
    artifacts: [{ key: "conversation/7/notes.md", markdown: true }],
    history: [{ role: "user", text: "first", html: "<p>first</p>", entryId: 41 }],
  });
  // The guard against `#e<id>` must not break the case it sits next to: an artifact key still
  // opens its document, and nothing is treated as an entry anchor.
  assert.ok(h.dom.window.document.querySelector('[data-entry="41"]'));
  assert.ok(!h.dom.window.document.querySelector('[data-entry="41"]')!.classList.contains("at-entry"));
});

test("a repaint keeps the anchor mark and the miss note", async () => {
  // `paint()` rebuilds the log from `transcript` on every stream frame, so a class added to a row
  // or a note prepended to the log lasts only until the next frame. That is invisible in a DOM
  // test with no frames and obvious in a browser — the browser test is where this was found.
  const h = await loadPage({
    hash: "#e42",
    history: [
      { role: "user", text: "first", html: "<p>first</p>", entryId: 41 },
      { role: "assistant", text: "second", html: "<p>second</p>", entryId: 42 },
    ],
  });
  // A frame arrives after the anchor was applied — the same repaint a live turn causes.
  h.sources[0]!.emit("text", { text: "streaming", busy: true });
  await Promise.resolve();
  assert.ok(
    h.dom.window.document.querySelector('[data-entry="42"]')?.classList.contains("at-entry"),
    "the mark survives a repaint",
  );
});
