/**
 * The web page in a real browser.
 *
 * The layer jsdom cannot reach: real `EventSource`, real layout, real CSS. The
 * stubbed version (`test/web-page-dom.test.ts`) is the fast loop; this is the
 * one that would have caught "the pane has zero height" or "the browser's SSE
 * reconnect behaves differently from my fake".
 *
 * No bridge is involved. The page talks to three endpoints, and `page.route()`
 * answers all of them — so this needs no database, no Pub/Sub and no live
 * conversation. The only server-side thing under test is that `dist` serves the
 * page at `/web`.
 *
 * Every test asserts **zero console errors**, because that is the check that
 * would have caught the real bug: an undeclared variable threw
 * `ReferenceError: source is not defined` on the first click, the pane stayed
 * blank, and nothing failed.
 */
import { expect, test, type Page } from "@playwright/test";

import { SWIPE_SCRIPT } from "../src/web/artifacts-server.js";
import { imageDocumentFor, pdfPageDocumentFor } from "./image-document.js";

const CONVERSATIONS = [
  { conversationId: 7, chatKey: "spaces/A/threads/T1", model: "deepseek/deepseek-flash", name: "deploy notes" },
  { conversationId: 9, chatKey: "spaces/A/threads/T2", model: "llama-local/lfm3" },
];

/**
 * The document currently in the middle slot.
 *
 * There is no single `#artifact-frame`: each artifact gets its own frame and the
 * drawer changes which one is centred rather than reloading one. A neighbour is
 * parked to one side with a CSS `order`, so the current document is the frame that
 * carries none.
 */
const currentFrame = (page: Page) => page.locator('#artifact-track .artifact-frame:not([hidden]):not([style*="order"])');

/** Console errors and page errors, collected for the zero-errors assertion. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

/**
 * Serve the three endpoints the page uses.
 *
 * `frames` are written to the SSE stream once it opens, so a test can assert
 * painting without a model or a conversation.
 */
async function stubApi(
  page: Page,
  options: {
    conversations?: typeof CONVERSATIONS;
    history?: { role: string; text: string; html?: string; at?: number; entryId?: number }[];
    frames?: { event: string; data: unknown }[];
    onPost?: (body: unknown) => void;
    /** The format the conversation reports: what the two pills show. */
    format?: { model: string; thinking?: string; levels?: string[] };
    /** The models the picker lists. */
    models?: { provider: string; id: string; label: string; levels?: string[] }[];
    /** What `POST /commands` answers, so a change can be seen to go through. */
    commandResponse?: unknown;
    /** Told about every command post, so a test can read what was applied. */
    onCommand?: (body: { text?: string; values?: Record<string, string> }) => void;
    /** Told about every conversation created, so a test can read the query that started it. */
    onNewConversation?: (body: unknown) => void;
  } = {},
): Promise<void> {
  const conversations = options.conversations ?? CONVERSATIONS;

  await page.route("**/api/conversations*", (route) => {
    if (route.request().method() === "POST") {
      options.onNewConversation?.(route.request().postDataJSON());
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ conversationId: 99, chatKey: "web:new", model: "m", createdAt: Date.now(), submitted: true }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: conversations, more: false, offset: 0, limit: 30 }),
    });
  });

  await page.route("**/api/c/*/events", async (route) => {
    // A real event stream, held open. `route.fulfill` with a body ends the
    // response immediately, which makes the browser's EventSource fire `error`
    // and paint "reconnecting…" before any assertion can read the frames — that
    // behaviour has its own test. Here the stream must stay open after the
    // frames, so the last frame's paint is what the page shows.
    const frames = (options.frames ?? [])
      .map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`)
      .join("");
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      // A comment line keeps the body syntactically open; the browser holds the
      // connection, so no `error` fires.
      body: `${frames}\n`,
    });
  });

  // History is a real endpoint the page calls on every open, and the fixture
  // conversations are not in the database, so an unstubbed call 404s. That
  // 404 was the console error failing the "no console errors" assertions.
  // The page asks for this once at load: the artifact drawer's base URL and the
  // page version it compares on reconnect. Unstubbed, it 404s and every
  // zero-console-errors assertion fails on a request nobody was testing.
  await page.route("**/api/environment", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ artifactsBaseUrl: "", pageVersion: "test" }),
    }),
  );

  // The page's own heading: one conversation's name.
  // The models a picker offers. Registered before the general conversation route
  // so it is not swallowed by it (both start `/api/`).
  await page.route("**/api/models", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        models: (options.models ?? []).map((model) => ({
          ...model,
          key: `${model.provider}/${model.id}`,
          levels: model.levels ?? [],
        })),
      }),
    }),
  );

  // The catch-up snapshot, asked for once after the stream's history load.
  //
  // It must agree with the frames above, because that is what a real snapshot does:
  // the server answers with the live turn, and a spec that says "nothing is running"
  // while the stream has just painted a turn makes the page correctly erase it. The
  // last `text` frame is the live state; no frames means idle, which is the case the
  // page is built to handle (the empty view clears a stale live block).
  const lastTextFrame = [...(options.frames ?? [])].reverse().find((f) => f.event === "text");
  // The drawer loads the conversation's review comments when it opens. Nothing here
  // tests comments, so an empty list is the honest answer — and it keeps the "no
  // console errors" assertion about the thing under test rather than about a 503.
  await page.route("**/api/c/*/comments", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) }),
  );

  await page.route("**/api/c/*/events/state", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        lastTextFrame ? lastTextFrame.data : { text: "", live: false, entries: [] },
      ),
    }),
  );

  await page.route("**/api/c/*/commands", async (route) => {
    options.onCommand?.(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(options.commandResponse ?? { kind: "text", text: "ok" }),
    });
  });

  await page.route("**/api/c/*", (route) => {
    const id = Number(/\/api\/c\/(\d+)$/.exec(new URL(route.request().url()).pathname)?.[1] ?? 0);
    const found = conversations.find((conversation) => conversation.conversationId === id);
    // The format rides with the conversation, the way the real route serves it.
    const body = found && options.format ? { ...found, format: options.format } : found;
    return found
      ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) })
      : route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ ok: false }) });
  });

  await page.route("**/api/c/*/history*", (route) => {
    // Paged the way the real route pages, so a browser test exercises the same
    // contract a real conversation would.
    const all = options.history ?? [];
    const query = new URL(route.request().url()).searchParams;
    const limit = Number(query.get("limit") ?? 50) || 50;
    const offset = Math.max(0, Number(query.get("offset") ?? 0) || 0);
    const end = Math.max(0, all.length - offset);
    const start = Math.max(0, end - limit);
    const slice = all.slice(start, end);
    // Anchored paging, the way the real route does it: `before` is an entry id, not
    // an offset, so the page walks backwards through a log that may be appending.
    // The fixture supplies the ids the real host does; without them the page cannot
    // know where it is, and the paging tests were asking the route to invent an
    // anchor — which is exactly what the real route refuses to do.
    const before = Math.max(0, Number(query.get("before") ?? 0) || 0);
    const held = before === 0 ? slice : all.filter((entry) => (entry.entryId ?? 0) < before).slice(-limit);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        messages: held,
        before: held[0]?.entryId ?? before,
        // A short page means there is nothing older — on the first page as well as later ones.
        // The `before !== 0` this used to carry made the first page never report the beginning,
        // so anything walking backwards (the entry anchor) had no way to stop.
        atStart: held.length < limit,
      }),
    });
  });

  await page.route("**/api/c/*/message", async (route) => {
    options.onPost?.(route.request().postDataJSON());
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
}

test("a conversation page shows that conversation, with no list beside it", async ({ page }) => {
  const errors = watchErrors(page);
  await stubApi(page);
  await page.goto("/7/");

  // One page per conversation: the header names it and offers the way back.
  await expect(page.locator("#conv-title")).toHaveText("deploy notes");
  await expect(page.locator("#back")).toHaveAttribute("href", "/");
  await expect(page.locator("#list")).toHaveCount(0);

  expect(errors, `console errors: ${errors.join(" | ")}`).toEqual([]);
});

test("the conversation in the URL is opened and streamed", async ({ page }) => {
  const errors = watchErrors(page);
  const requests: string[] = [];
  page.on("request", (req) => requests.push(req.url()));
  await stubApi(page, {
    frames: [{ event: "text", data: { text: "streamed at load", busy: true } }],
  });
  // /9/ is the *second* conversation in the fixture: the URL decides, not order.
  await page.goto("/9/");

  await expect(page.locator("#conv-title")).toHaveText("spaces/A/threads/T2");
  await expect(page.locator("#log .bubble")).toHaveText("streamed at load");
  expect(requests.some((u) => /\/api\/c\/9\/events$/.test(u))).toBe(true);
  expect(errors).toEqual([]);
});

test("an SSE text frame paints the answer pane", async ({ page }) => {
  const errors = watchErrors(page);
  await stubApi(page, { frames: [{ event: "text", data: { text: "the model said this", busy: true } }] });
  await page.goto("/7/");
  await expect(page.locator("#log .bubble")).toHaveText("the model said this");
  expect(errors).toEqual([]);
});

/**
 * Tool frames, and what happens when the stream ends.
 *
 * `route.fulfill` sends a complete response, so the fixture's stream always
 * closes immediately after its frames. A real EventSource then fires `error` and
 * retries — which is both what a bridge restart looks like from the browser, and
 * the reason these two facts belong in one test rather than two that fight over
 * the same instant.
 *
 * A tool frame that stays painted therefore needs a server that holds the
 * connection open. That is the one thing this layer still cannot do with routes
 * alone, and it is noted rather than faked: the jsdom test covers the frame
 * painting, this covers the real browser's response to a closed stream.
 */
test("tool frames arrive, and a closed stream reads as reconnecting", async ({ page }) => {
  const errors = watchErrors(page);
  await stubApi(page, { frames: [{ event: "tool", data: { name: "bash", status: "running" } }] });
  await page.goto("/7/");
  // The stream ends, so the page reports it instead of showing a stale tool line
  // or a blank pane. Either of those would misrepresent the connection state.
  await expect(page.locator("#tool")).toHaveText("reconnecting…");
  expect(errors).toEqual([]);
});

test("sending a message posts the trimmed text and clears the box", async ({ page }) => {
  const errors = watchErrors(page);
  const posted: unknown[] = [];
  await stubApi(page, { onPost: (body) => posted.push(body) });
  await page.goto("/7/");
  await expect(page.locator("#conv-title")).toHaveText("deploy notes");

  await page.locator("#text").fill("  hello from the browser  ");
  await page.locator("#send").evaluate((form) => (form as HTMLFormElement).requestSubmit());

  await expect(page.locator("#text")).toHaveValue("");
  await expect.poll(() => posted.length).toBe(1);
  // `images` is always sent — empty when nothing was pasted — because the route
  // validates the list when it is present.
  expect(posted[0]).toEqual({ text: "hello from the browser", images: [] });
  expect(errors).toEqual([]);
});

test("layout: the answer pane is visible and the controls are reachable", async ({ page }) => {
  // The check jsdom cannot make. A pane with zero height passes every DOM
  // assertion and shows the user nothing — which is exactly what a broken
  // stylesheet looks like.
  await stubApi(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/7/");

  const log = page.locator("#log");
  await expect(log).toBeVisible();
  const box = await log.boundingBox();
  expect(box, "the answer pane must occupy space").not.toBeNull();
  expect(box!.height).toBeGreaterThan(80);

  await expect(page.locator("#text")).toBeVisible();
  await expect(page.locator("#send")).toBeVisible();
  // And nothing overflows horizontally at this width.
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(1281);
});

test("layout: the text box grows with the message instead of scrolling its own text", async ({ page }) => {
  // The bug this covers: a fixed-height box keeps its size, so a long message
  // scrolls *inside* a 3.5rem window and the first lines — the ones you were
  // writing a minute ago — are invisible while you type.
  await stubApi(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/7/");

  const box = page.locator("#text");
  const shortBox = (await box.boundingBox())!;

  await box.fill(Array.from({ length: 8 }, (_, i) => `line ${i + 1} of a longer message`).join("\n"));
  const tallBox = (await box.boundingBox())!;
  expect(tallBox.height, "the box must grow with its content").toBeGreaterThan(shortBox.height + 40);

  // Grown, not scrolled: the first line is still on screen, and it stays put.
  const scrolled = await box.evaluate((el) => {
    const area = el as HTMLTextAreaElement;
    return { scrollTop: area.scrollTop, overflows: area.scrollHeight > area.clientHeight + 1 };
  });
  expect(scrolled.scrollTop).toBe(0);
  expect(scrolled.overflows, "content fits, so nothing is hidden").toBe(false);

  // And it gives the space back: clearing the box returns it to one line, so a
  // long message does not permanently eat the conversation.
  await box.fill("");
  const resetBox = (await box.boundingBox())!;
  expect(resetBox.height).toBeLessThan(tallBox.height - 40);

  // A paste far past the cap stops growing at 40vh and scrolls from there,
  // rather than pushing the whole conversation off the screen.
  await box.fill(Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n"));
  const capped = (await box.boundingBox())!;
  expect(capped.height).toBeLessThanOrEqual(800 * 0.4 + 1);
});

test("layout: a grown composer pushes the conversation up instead of overflowing it", async ({ page }) => {
  // The bug: the composer grows but the pane does not give up the space, so the
  // box runs past the bottom of the window and the last message is cut off
  // mid-sentence behind it.
  await stubApi(page, {
    history: Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      text: `message ${i + 1} of a conversation long enough to overflow`,
      html: `<p>message ${i + 1} of a conversation long enough to overflow</p>`,
      at: Date.now() - i * 60_000,
    })),
  });
  // Deliberately short: this is the shape that broke — a laptop window with a
  // system bar, where 40vh of composer is most of the pane.
  const viewportHeight = 480;
  await page.setViewportSize({ width: 1280, height: viewportHeight });
  await page.goto("/7/");

  const log = page.locator("#log");
  // By id, because the search box is a `<form>` too (and is hidden, so a bare
  // `form` selector now matches two elements). The composer is the one meant here.
  const form = page.locator("#send");
  const logBefore = (await log.boundingBox())!;

  await page.locator("#text").fill(Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join("\n"));

  const logAfter = (await log.boundingBox())!;
  const formAfter = (await form.boundingBox())!;

  // The conversation ends where the composer begins: no overlap.
  expect(logAfter.y + logAfter.height).toBeLessThanOrEqual(formAfter.y + 1);
  // The composer is entirely on screen.
  expect(formAfter.y + formAfter.height).toBeLessThanOrEqual(viewportHeight + 1);
  // The pane gave up the space rather than growing past the window.
  expect(logAfter.height).toBeLessThan(logBefore.height - 40);
  // …and is still usable.
  expect(logAfter.height).toBeGreaterThan(80);
});

test("layout: a long unbreakable line scrolls inside its bubble instead of widening it", async ({ page }) => {
  // The bug: the bubble and the rendered body were blocks inside a flex column, whose
  // `min-width` is `auto` — so a fenced block with a long line made them size to content
  // rather than to the column. A 337px message got a 779px bubble that overhung the pane
  // to the *left*, which on a phone read as a message wider than the screen.
  await stubApi(page, {
    history: [
      {
        role: "user",
        text: "a long command",
        html:
          "<pre><code>cd /workspace/pi-chat-bridge && npm run transcript -- search Ledger --conversation 37134 --limit 40 --by-conv</code></pre>" +
          "<p>and a normal paragraph after it, which must still be readable</p>",
        at: Date.now(),
      },
    ],
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/7/");

  const m = await page.evaluate(() => {
    const log = document.getElementById("log") as HTMLElement;
    const bubble = document.querySelector("#log .bubble") as HTMLElement;
    const pre = document.querySelector("#log .body pre") as HTMLElement;
    const viewport = window.innerWidth;
    return {
      viewport,
      docScroll: document.documentElement.scrollWidth,
      bubbleLeft: bubble.getBoundingClientRect().left,
      bubbleRight: bubble.getBoundingClientRect().right,
      bubbleWidth: bubble.getBoundingClientRect().width,
      preWidth: pre.getBoundingClientRect().width,
      preScrolls: pre.scrollWidth > pre.clientWidth,
      logClient: log.clientWidth,
    };
  });

  // Nothing sticks out of the window …
  expect(m.docScroll).toBeLessThanOrEqual(m.viewport);
  // … the bubble stays inside the pane on both sides …
  expect(m.bubbleLeft).toBeGreaterThanOrEqual(0);
  expect(m.bubbleRight).toBeLessThanOrEqual(m.viewport);
  expect(m.bubbleWidth).toBeLessThanOrEqual(m.logClient);
  // … and the long line is what scrolls, not the page.
  expect(m.preScrolls).toBe(true);
});

test("layout: growing the composer keeps the newest message whole", async ({ page }) => {
  // The subtler half of the same bug: the log shrinks correctly, but the browser
  // keeps its scroll offset, so the last message ends up cut in half at the
  // composer's edge. A chat should slide up to stay anchored to its end.
  await stubApi(page, {
    history: Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      text: `message ${i + 1}`,
      html: `<p>message ${i + 1} of a conversation long enough to overflow the pane</p>`,
      at: Date.now() - i * 60_000,
    })),
  });
  await page.setViewportSize({ width: 1280, height: 700 });
  await page.goto("/7/");
  await expect(page.locator("#log .bubble").last()).toBeVisible();

  await page.locator("#text").fill(Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n"));
  await page.waitForTimeout(150); // let the ResizeObserver run

  const geometry = await page.evaluate(() => {
    const log = document.getElementById("log")!;
    const bubbles = log.querySelectorAll(".bubble");
    const last = bubbles[bubbles.length - 1]!.getBoundingClientRect();
    const box = log.getBoundingClientRect();
    return {
      lastBottom: last.bottom,
      logBottom: box.bottom,
      gap: log.scrollHeight - log.scrollTop - log.clientHeight,
    };
  });

  // Pinched to the end, and the final message sits inside the visible area
  // rather than straddling the boundary.
  expect(geometry.gap).toBeLessThanOrEqual(1);
  expect(geometry.lastBottom).toBeLessThanOrEqual(geometry.logBottom + 1);
});

test("the running tool's line is inside the reply bubble, not floating under it", async ({ page }) => {
  // "Put the bash details inside the response box" is a layout claim, so it is
  // checked as one: the status element's box must be inside the bubble's.
  await stubApi(page, {
    frames: [{ event: "tool", data: { name: "bash", status: "running", line: "Running: npm run build" } }],
  });
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto("/7/");

  const geometry = await page.evaluate(() => {
    const live = document.querySelector("#log .msg.live");
    const bubble = live?.querySelector(".bubble");
    const status = live?.querySelector(".status");
    if (!bubble || !status) return null;
    const b = bubble.getBoundingClientRect();
    const s = status.getBoundingClientRect();
    return {
      text: status.textContent,
      inside:
        s.top >= b.top - 1 && s.bottom <= b.bottom + 1 && s.left >= b.left - 1 && s.right <= b.right + 1,
      // The reply box exists before there is any text, so a tool that runs first
      // still has a message to live in.
      hasBubble: true,
    };
  });

  expect(geometry, "the live turn must render a bubble containing its status").not.toBeNull();
  expect(geometry!.text).toBe("Running: npm run build");
  expect(geometry!.inside, "the status must be inside the bubble").toBe(true);
});

test("the send button keeps its label when the box is wide", async ({ page }) => {
  await stubApi(page);
  await page.setViewportSize({ width: 1600, height: 700 });
  await page.goto("/7/");

  const fits = await page.evaluate(() => {
    const button = document.querySelector("#send button")!;
    const box = button.getBoundingClientRect();
    return { width: box.width, scrollWidth: button.scrollWidth };
  });
  // A squeezed flex item overflows its own pill; the label must fit.
  expect(fits.scrollWidth).toBeLessThanOrEqual(fits.width + 1);
});

test("the attach button uploads a file, and it goes with the message", async ({ page }) => {
  const errors = watchErrors(page);
  const posted: unknown[] = [];
  await stubApi(page, { onPost: (body) => posted.push(body) });
  await page.goto("/7/");

  // A real PNG, so the browser's own File/FileReader path is what runs. A
  // one-pixel image: the content does not matter, only that bytes survive the
  // round trip from the picker to the request body.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
    "base64",
  );
  // `setInputFiles` is the only way to drive a real file input: it fires the
  // same `change` event a picker does, without a picker.
  await page.locator("#attach-input").setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: png });

  // A thumbnail before sending, so the choice is visible.
  await expect(page.locator("#attachments img")).toHaveCount(1);
  await expect(page.locator("#attachments img")).toHaveAttribute("src", /^data:image\/png;base64,/);

  await page.locator("#text").fill("what is this");
  await page.locator("#send").evaluate((form) => (form as HTMLFormElement).requestSubmit());

  await expect.poll(() => posted.length).toBe(1);
  const body = posted[0] as { text: string; images: { data: string; mimeType: string }[] };
  expect(body.text).toBe("what is this");
  expect(body.images).toHaveLength(1);
  expect(body.images[0]!.mimeType).toBe("image/png");
  expect(body.images[0]!.data.length).toBeGreaterThan(0);

  // And the strip is empty again, so the next message does not repeat it.
  await expect(page.locator("#attachments img")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("dropping a file on the pane attaches it and does not navigate away", async ({ page }) => {
  const errors = watchErrors(page);
  await stubApi(page);
  await page.goto("/7/");

  // A `DataTransfer` built in the page carries the file to a real drop event.
  // Dispatching it from `evaluate` is what makes this a genuine drag: the same
  // handler the browser calls, and the navigation that must not happen.
  await page.evaluate(async () => {
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([png], "dropped.png", { type: "image/png" }));
    const pane = document.getElementById("pane")!;
    for (const type of ["dragenter", "dragover", "drop"]) {
      pane.dispatchEvent(new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true }));
    }
  });

  await expect(page.locator("#attachments img")).toHaveCount(1);
  // Still on the conversation: an unhandled drop would have navigated to the file.
  await expect(page).toHaveURL(/\/7\/$/);
  await expect(page.locator("#pane")).not.toHaveClass(/dropping/);
  expect(errors).toEqual([]);
});

test("a refused attachment says why, and the message can still be sent", async ({ page }) => {
  const errors = watchErrors(page);
  const posted: unknown[] = [];
  await stubApi(page, { onPost: (body) => posted.push(body) });
  await page.goto("/7/");

  await page.locator("#attach-input").setInputFiles({
    name: "invoice.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4"),
  });

  // Named, so you know which file was refused — silence here reads as a bug.
  await expect(page.locator("#attach-notice")).toBeVisible();
  await expect(page.locator("#attach-notice")).toContainText("invoice.pdf");
  await expect(page.locator("#attachments img")).toHaveCount(0);

  // And it does not block the text: refusing a file must not refuse the message.
  await page.locator("#text").fill("ignore the pdf");
  await page.locator("#send").evaluate((form) => (form as HTMLFormElement).requestSubmit());
  await expect.poll(() => posted.length).toBe(1);
  expect((posted[0] as { images: unknown[] }).images).toEqual([]);
  expect(errors).toEqual([]);
});

test("scrolling up loads earlier messages, and the view does not jump", async ({ page }) => {
  const errors = watchErrors(page);
  // Enough to be several pages. Each message is distinct so the assertions can
  // tell which slice is on screen.
  const history = Array.from({ length: 160 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    text: `message ${i}`,
    html: `<p>message ${i}</p>`,
    at: Date.now() - (160 - i) * 60_000,
    entryId: i + 1,
  }));
  await stubApi(page, { history });
  await page.setViewportSize({ width: 900, height: 400 });
  await page.goto("/7/");

  const log = page.locator("#log");

  // It opens at the bottom, showing the newest message rather than the oldest:
  // this is the bug that made the pane look like the conversation started in the
  // middle.
  await expect(log).toContainText("message 159");
  await expect(log).not.toContainText("message 0");

  // Scroll to the top, which is what pulling up on a phone does. The page should
  // arrive by itself, without pressing anything.
  await log.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(log).toContainText("message 109");

  // The critical part: the reader must not be thrown. After the older page lands,
  // the pixel under the top of the viewport should still be the message that was
  // there before — the prepend is compensated, not just appended.
  const anchored = await log.evaluate((el) => {
    // Find the message nearest the top of the visible area, and remember it.
    const rows = [...el.querySelectorAll(".msg")];
    const box = el.getBoundingClientRect();
    const atTop = rows.find((row) => row.getBoundingClientRect().bottom > box.top);
    return { text: atTop?.textContent?.trim(), scrollTop: el.scrollTop, scrolled: el.scrollTop > 0 };
  });
  // A jump would show scrollTop back near 0 with the *new* first message pinned
  // under the viewport edge.
  expect(anchored.scrolled, "the view stays where it was, not at the new top").toBe(true);

  expect(errors).toEqual([]);
});

test("paging reaches the very beginning and then stops", async ({ page }) => {
  const errors = watchErrors(page);
  const history = Array.from({ length: 60 }, (_, i) => ({
    role: "user",
    text: `message ${i}`,
    html: `<p>message ${i}</p>`,
    at: Date.now() - (60 - i) * 60_000,
    entryId: i + 1,
  }));
  await stubApi(page, { history });
  await page.setViewportSize({ width: 900, height: 400 });
  await page.goto("/7/");

  const log = page.locator("#log");
  await expect(log).toContainText("message 59");

  // 60 messages in pages of 50: one scroll reaches the start.
  await log.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(log).toContainText("message 0");
  await expect(page.locator("#earlier")).toHaveText("Start of conversation");

  // And scrolling again does not ask for more, so an idle wheel cannot spin.
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/history")) requests.push(request.url());
  });
  await log.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
  });
  await page.waitForTimeout(300);
  expect(requests).toEqual([]);

  expect(errors).toEqual([]);
});

test("Enter sends, Shift-Enter and Ctrl-Enter add a line instead", async ({ page }) => {
  const posted: unknown[] = [];
  await stubApi(page, { onPost: (body) => posted.push(body) });
  await page.goto("/7/");

  const box = page.locator("#text");

  // Shift-Enter: a newline, no send.
  await box.fill("first line");
  await box.press("Shift+Enter");
  await box.type("second line");
  expect(posted).toHaveLength(0);
  expect(await box.inputValue()).toContain("\n");

  // Ctrl-Enter: same.
  await box.press("Control+Enter");
  expect(posted).toHaveLength(0);

  // Plain Enter: sends what is there, and clears the box.
  await box.press("Enter");
  await expect.poll(() => posted.length).toBe(1);
  expect((posted[0] as { text: string }).text).toContain("first line");
  expect(await box.inputValue()).toBe("");
});

test("the index lists recent conversations, pages, and starts a new chat", async ({ page }) => {
  const errors = watchErrors(page);
  await stubApi(page, {
    conversations: [
      // `lastActivityAt` is what the index sorts and labels by; without it the
      // rows are undated, which is a fixture bug and not a page one.
      { conversationId: 7, chatKey: "spaces/A/threads/T1", model: "deepseek/deepseek-flash", name: "deploy notes", createdAt: Date.now() - 7200e3, lastActivityAt: Date.now() - 60e3 },
      { conversationId: 9, chatKey: "spaces/A/threads/T2", model: "llama-local/lfm3", createdAt: Date.now() - 86400e3, lastActivityAt: Date.now() - 86400e3 },
    ] as never,
  });
  await page.goto("/");

  const items = page.locator("#index-list li");
  await expect(items).toHaveCount(2);
  await expect(items.first()).toContainText("deploy notes");
  // The newest-used conversation is first, and the row shows when.
  await expect(items.first().locator(".when")).not.toBeEmpty();

  // No stream on the index: nothing is open until you pick something.
  expect(await page.evaluate(() => performance.getEntriesByType("resource").filter((e) => e.name.includes("/events")).length)).toBe(0);

  // Clicking a row navigates to that conversation's own URL.
  await items.nth(1).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe("/9/");
  await expect(page.locator("#log")).toBeVisible();

  expect(errors).toEqual([]);
});

test("the index pages: Older asks for the next slice, and shows the range", async ({ page }) => {
  const errors = watchErrors(page);
  const asked: string[] = [];
  const rows = (offset: number, count: number) =>
    Array.from({ length: count }, (_, index) => ({
      conversationId: offset + index + 1,
      chatKey: `web:${offset + index + 1}`,
      model: "m",
      name: `conversation ${offset + index + 1}`,
      createdAt: Date.now() - (offset + index) * 60e3,
      lastActivityAt: Date.now() - (offset + index) * 60e3,
    }));

  // Thirty-one conversations: a full first page and one more, which is the shape
  // that made "the list stops at N" look like a truncation rather than a page.
  await page.route("**/api/conversations*", (route) => {
    const url = new URL(route.request().url());
    asked.push(url.search);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 30);
    const total = 31;
    const items = rows(offset, Math.max(0, Math.min(limit, total - offset)));
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items, more: offset + items.length < total, offset, limit }),
    });
  });
  await page.goto("/");

  const items = page.locator("#index-list li");
  await expect(items).toHaveCount(30);
  // The pager is visible on the first page, because there is more to see.
  const pager = page.locator("#index-pager");
  await expect(pager).toBeVisible();
  await expect(page.locator("#index-range")).toHaveText("1–30");
  await expect(page.locator("#index-newer")).toBeDisabled();

  await page.locator("#index-older").click();
  await expect(items).toHaveCount(1);
  await expect(page.locator("#index-range")).toHaveText("31–31");
  await expect(page.locator("#index-older")).toBeDisabled();
  expect(asked.some((search) => search.includes("offset=30"))).toBe(true);

  await page.locator("#index-newer").click();
  await expect(items).toHaveCount(30);
  expect(errors).toEqual([]);
});

test("the magnifier on a conversation starts a search in a conversation of its own", async ({ page }) => {
  const created: unknown[] = [];
  await stubApi(page, { onNewConversation: (body) => created.push(body) });
  await page.goto("/7/");

  // Beside the conversation's own name, and closed until asked for.
  await expect(page.locator("#search-toggle")).toBeVisible();
  const bar = page.locator("#search-bar");
  await expect(bar).toBeHidden();

  await page.locator("#search-toggle").click();
  await expect(bar).toBeVisible();
  await expect(page.locator("#search-text")).toBeFocused();

  await page.locator("#search-text").fill("quantiz gpu");
  await page.locator("#search-go").click();

  // A brand-new conversation, with the query as the message that opened it.
  await expect.poll(() => new URL(page.url()).pathname).toBe("/99/");
  expect(created).toEqual([{ query: "quantiz gpu" }]);

  // And it lands on an ordinary conversation page: the header, the way back and the
  // composer, with no sign that this one was started by a search. (`#log` is asserted
  // to exist rather than to be visible: a conversation with no entries has no height,
  // which is the empty conversation's own case and not this test's.)
  await expect(page.locator("#conv-title")).not.toBeEmpty();
  await expect(page.locator("#back")).toBeVisible();
  await expect(page.locator("#send")).toBeVisible();
  // No zero-console-errors assertion here: the page navigates to a conversation the
  // fixture index does not contain, and this suite's catch-all route answers that 404.
  // What the *page* did is asserted above; the console is the fixture's noise.
});

test("the index's magnifier opens a conversation with its search box already showing", async ({ page }) => {
  const created: unknown[] = [];
  await stubApi(page, { onNewConversation: (body) => created.push(body) });
  await page.goto("/");

  await page.locator("#index-search").click();

  // The box lives on the conversation page, so the index opens one and asks it to show
  // the form — and the flag does not stay in the address bar.
  await expect.poll(() => new URL(page.url()).pathname).toBe("/99/");
  await expect(page.locator("#search-bar")).toBeVisible();
  await expect(page.locator("#search-text")).toBeFocused();
  expect(new URL(page.url()).search).toBe("");
  // Created with no body at all: the query is typed on the page it opens, not on the
  // index, so there is only one search form to keep right.
  expect(created).toEqual([null]);
  // No zero-console-errors assertion here: the page navigates to a conversation the
  // fixture index does not contain, and this suite's catch-all route answers that 404.
  // What the *page* did is asserted above; the console is the fixture's noise.
});

test("the new chat button creates a conversation and opens it", async ({ page }) => {
  await stubApi(page);
  await page.goto("/");
  await page.locator("#new-chat").click();
  await expect.poll(() => new URL(page.url()).pathname).toBe("/99/");
});

// --- Mobile ------------------------------------------------------------------
//
// A phone is where a chat UI is most likely to be read, and the layout failures
// there are the ones nobody sees on a laptop: a scrollbar because something is
// wider than the screen, a floating button over the Send button, a placeholder
// that wraps and eats the composer.

test("mobile: the index fits the screen, and its rows are tappable", async ({ page }) => {
  await stubApi(page, {
    conversations: [
      { conversationId: 7, chatKey: "spaces/A/threads/T1", model: "m", name: "A title long enough to need truncating on a phone" },
      { conversationId: 9, chatKey: "spaces/A/threads/T2", model: "m" },
    ] as never,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const layout = await page.evaluate(() => {
    const row = document.querySelector("#index-list li")!.getBoundingClientRect();
    return {
      scrollWidth: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
      rowHeight: row.height,
      fabVisible: !document.getElementById("new-chat")!.hidden,
    };
  });

  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.viewport);
  expect(layout.rowHeight).toBeGreaterThanOrEqual(40); // the usual minimum tap target
  expect(layout.fabVisible).toBe(true);
});

test("mobile: the index is the page, so everything past the fold is reachable", async ({ page }) => {
  // The regression this guards: the index was a 100dvh box with its own
  // `overflow: auto`. Phones hide that scrollbar until you are already moving, so
  // a 30-row list looked like it ended at the fold and the pager below it was
  // never seen. The window scrolls the index instead of a box inside it.
  const rows = Array.from({ length: 30 }, (_, index) => ({
    conversationId: index + 1,
    chatKey: `web:${index + 1}`,
    model: "m",
    name: `conversation ${index + 1}`,
    createdAt: Date.now() - index * 60e3,
    lastActivityAt: Date.now() - index * 60e3,
  }));
  await page.route("**/api/conversations*", (route) => {
    const url = new URL(route.request().url());
    const offset = Number(url.searchParams.get("offset") ?? 0);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: offset === 0 ? rows : [], more: offset === 0, offset, limit: 30 }),
    });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const layout = await page.evaluate(() => {
    const doc = document.documentElement;
    const index = document.getElementById("index")!;
    return {
      documentScrolls: doc.scrollHeight > doc.clientHeight,
      // Nothing inside the index scrolls on its own: one scroller, the document.
      innerScroller: index.scrollHeight > index.clientHeight + 1,
      indexOverflow: getComputedStyle(index).overflowY,
    };
  });
  expect(layout.documentScrolls, "the index must overflow the window, not a box").toBe(true);
  expect(layout.innerScroller, "the index must not scroll inside itself").toBe(false);
  expect(layout.indexOverflow).not.toBe("auto");

  // Scrolling the window to the bottom really does reach the pager.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const pager = page.locator("#index-pager");
  await expect(pager).toBeInViewport();
  await expect(page.locator("#index-list li")).toHaveCount(30);
});

test("mobile: the composer is on screen and nothing floats over Send", async ({ page }) => {
  await stubApi(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/7/");

  const state = await page.evaluate(() => {
    const button = document.querySelector("#send button")!;
    const box = button.getBoundingClientRect();
    const centre = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return {
      scrollWidth: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
      onScreen: box.bottom <= window.innerHeight + 1 && box.right <= window.innerWidth + 1,
      // Whatever is at the button's centre must be the button: the ＋ used to sit
      // exactly there, so a thumb aimed at Send opened a drawer.
      topElement: centre === button || button.contains(centre) ? "send" : (centre?.id || centre?.tagName || "none"),
      newChatHidden: document.getElementById("new-chat")!.hidden,
      placeholder: (document.getElementById("text") as HTMLTextAreaElement).placeholder,
    };
  });

  expect(state.scrollWidth).toBeLessThanOrEqual(state.viewport);
  expect(state.onScreen).toBe(true);
  expect(state.topElement).toBe("send");
  expect(state.newChatHidden).toBe(true);
  expect(state.placeholder).toBe("Message…"); // one line at any width
});

test("mobile: the artifact drawer takes the screen", async ({ page }) => {
  await stubApi(page);
  // The drawer's button is hidden unless the deployment says where artifacts live,
  // so this test has to claim one.
  await page.route("**/api/environment", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ artifactsBaseUrl: "https://artifacts.example", pageVersion: "test" }),
    }),
  );
  await page.route("**/api/c/*/artifacts", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ key: "docs/a.md", wrote: 1, edited: 0, markdown: true }]),
    }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/7/");
  await page.locator("#artifacts-toggle").click();

  const box = await page.locator("#artifacts").boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(389);
});

test("artifacts: the list shows names, and a file slides over it full width", async ({ page }) => {
  await stubApi(page);
  await page.route("**/api/environment", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ artifactsBaseUrl: "https://artifacts.example", pageVersion: "t" }),
    }),
  );
  await page.route("**/api/c/*/artifacts", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        { key: "pi-gchat-bridge/docs/session-host-api.md", wrote: 1, edited: 4, markdown: true },
        { key: "pi-gchat-bridge/src/adapter/web/page.html", wrote: 3, edited: 2, markdown: false },
      ]),
    }),
  );
  await page.route("https://artifacts.example/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<p>rendered</p>" }),
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/7/");
  await page.locator("#artifacts-toggle").click();

  // The name is what you pick by; the directory is a second line, not the label.
  const first = page.locator("#artifact-list li").first();
  await expect(first.locator(".name")).toHaveText("session-host-api.md");
  await expect(first.locator(".dir")).toHaveText("pi-gchat-bridge/docs");

  // Nothing is open until you pick something.
  const before = await page.evaluate(() => ({
    showing: document.getElementById("artifacts")!.classList.contains("showing-doc"),
    title: document.getElementById("artifacts-title")!.textContent,
  }));
  expect(before.showing).toBe(false);
  expect(before.title).toBe("Artifacts");

  await first.click();
  await expect(page.locator("#artifacts-title")).toHaveText("session-host-api.md");
  // The slide is a transition, so wait for it to land rather than sampling it
  // mid-flight — 33px short of the edge was the first reading.
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.getElementById("artifact-track")!).transform))
    .toBe("matrix(1, 0, 0, 1, 0, 0)");
  const after = await page.evaluate(() => {
    const doc = document.getElementById("artifact-doc")!.getBoundingClientRect();
    const drawer = document.getElementById("artifacts")!.getBoundingClientRect();
    return {
      showing: document.getElementById("artifacts")!.classList.contains("showing-doc"),
      docWidth: Math.round(doc.width),
      drawerWidth: Math.round(drawer.width),
      backVisible: !document.getElementById("artifacts-back")!.hidden,
      transform: getComputedStyle(document.getElementById("artifact-track")!).transform,
    };
  });
  // Slid in, and the document owns the drawer rather than sharing it with a list.
  expect(after.showing).toBe(true);
  expect(after.docWidth).toBe(after.drawerWidth);
  expect(after.backVisible).toBe(true);

  // Back goes to the list, and the frame is dropped rather than left loaded.
  await page.locator("#artifacts-back").click();
  await expect(page.locator("#artifacts-title")).toHaveText("Artifacts");
  // The frames stay loaded — that is the point of the pool — so "nothing is open" means
  // the drawer is back on the list, not that no document exists. The whole strip is
  // hidden by CSS at that point.
  await expect(page.locator("#artifacts")).not.toHaveClass(/showing-doc/);
  await expect(page.locator("#artifact-doc")).toBeHidden();
});

test("artifacts: an image is framed as a fitted picture, and the browser paints it", async ({ page }) => {
  // Only a real browser can say whether this works. The artifact origin answers an
  // image URL with a *document* that centres the picture (a bare image document is
  // painted on a white backdrop whatever the theme), and that document embeds the
  // bytes from `?raw`. So this asserts the two responses and, crucially, that the
  // browser actually decoded the picture rather than showing a broken image.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJUlEQVR42u3NMQEAAAgDoC251a3gLwSgcyfTVFVVVVVVVVVVVVX1tQFrwAPhpO4WAAAAAElFTkSuQmCC",
    "base64",
  );

  await stubApi(page);
  await page.route("**/api/environment", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ artifactsBaseUrl: "https://artifacts.example", pageVersion: "t" }),
    }),
  );
  await page.route("**/api/c/*/artifacts", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        { key: "pi/out/screenshot.png", wrote: 1, edited: 0, markdown: false, image: true },
        { key: "pi/out/notes.md", wrote: 1, edited: 0, markdown: true, image: false },
      ]),
    }),
  );

  const requests: string[] = [];
  await page.route("https://artifacts.example/**", (route) => {
    const url = route.request().url();
    requests.push(url);
    if (url.includes("?raw")) {
      return route.fulfill({ status: 200, contentType: "image/png", body: png });
    }
    if (url.endsWith(".png")) {
      // The wrapper the artifact origin really serves: a document around the bytes.
      return route.fulfill({
        status: 200,
        contentType: "text/html",
        // Mirrors the real wrapper in `artifacts-server.ts`, including the
        // `html, body { height: 100% }` the flex centring needs to have any height.
        body: `<!doctype html><html><head><style>:root{color-scheme:light dark}
          html,body{height:100%;box-sizing:border-box}
          body{margin:0;display:flex;align-items:center;justify-content:center;padding:1rem;background:Canvas}
          img{max-width:100%;max-height:100%;object-fit:contain}</style></head>
          <body><img src="screenshot.png?raw" alt="screenshot.png"></body></html>`,
      });
    }
    return route.fulfill({ status: 200, contentType: "text/html", body: "<p>rendered</p>" });
  });

  await page.goto("/7/");
  await page.locator("#artifacts-toggle").click();

  // The list says what each row is, so a picture is recognisable before opening it.
  const image = page.locator("#artifact-list li", { hasText: "screenshot.png" });
  await expect(image.locator(".counts")).toContainText("image");
  await expect(page.locator("#artifact-list li", { hasText: "notes.md" }).locator(".counts"))
    .toContainText("markdown");

  await image.click();
  await expect(page.locator("#artifacts-title")).toHaveText("screenshot.png");
  // The document slides in, and the frame is laid out *during* that transition: a
  // measurement taken mid-slide is of a narrower drawer than the final one, which is
  // how the centring check ended up 32px out. Wait for it to land.
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.getElementById("artifact-track")!).transform))
    .toBe("matrix(1, 0, 0, 1, 0, 0)");

  // The frame holds the wrapper document, not the bytes and not a source view.
  const url = await currentFrame(page).getAttribute("src");
  expect(url).toBe("https://artifacts.example/c/7/pi/out/screenshot.png");

  // The picture itself was fetched, and the browser decoded it. Reaching into the
  // frame is allowed here for the same reason the drawer may: this stub is same-origin
  // in effect, and the assertion is about `naturalWidth`, which only a real decode sets.
  // The frame holding the image is not necessarily the first one whose URL matches
  // (the picture's own `?raw` response is a frame URL too, in some Chromium builds),
  // so the one that has an `<img>` in it is the one to measure.
  const frameOf = async (): Promise<import("@playwright/test").Frame> => {
    for (const candidate of page.frames()) {
      if (candidate === page.mainFrame() || !candidate.url().includes("screenshot.png")) continue;
      try {
        if (await candidate.evaluate(() => document.images.length > 0)) return candidate;
      } catch {
        // A frame mid-navigation cannot be evaluated; try the next poll.
      }
    }
    throw new Error("no frame with the image yet");
  };
  await expect.poll(async () => {
    try {
      await frameOf();
      return true;
    } catch {
      return false;
    }
  }).toBe(true);
  const frame = await frameOf();
  const size = await frame.evaluate(() => {
    const img = document.querySelector("img");
    return { w: img?.naturalWidth ?? 0, h: img?.naturalHeight ?? 0, src: img?.getAttribute("src") ?? "" };
  });
  expect(size.src).toBe("screenshot.png?raw");
  expect(size.w).toBe(16);
  expect(size.h).toBe(16);
  // And the bytes were actually requested over the wire, not skipped.
  expect(requests.some((u) => u.endsWith("screenshot.png?raw"))).toBe(true);

  // And it is laid out, not jammed in a corner: the wrapper's flex centring has
  // actually applied. Absolute centring is asserted in the artifact server's own
  // tests, where the document is served for real and there is no frame sizing to
  // reason about; what matters here is that the drawer shows the picture laid out.
  const gaps = await frame.evaluate(() => {
    const img = document.querySelector("img")!;
    const r = img.getBoundingClientRect();
    return {
      left: r.left,
      top: r.top,
      right: innerWidth - r.right,
      bottom: innerHeight - r.bottom,
      display: getComputedStyle(document.body).display,
    };
  });
  // Centred by equal slack on each axis (the drawing is small, so both slacks are
  // large and equal; a top-left pinning gives 0 on the left and everything on the
  // right).
  expect(gaps.display).toBe("flex");
  expect(Math.abs(gaps.left - gaps.right)).toBeLessThan(2);
  expect(Math.abs(gaps.top - gaps.bottom)).toBeLessThan(2);
});

test("artifacts: a text file still opens the source view", async ({ page }) => {
  // The image branch is a new first answer; it must not have swallowed the old ones.
  await stubApi(page);
  await page.route("**/api/environment", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ artifactsBaseUrl: "https://artifacts.example", pageVersion: "t" }),
    }),
  );
  await page.route("**/api/c/*/artifacts", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ key: "pi/out/run.sh", wrote: 1, edited: 0, markdown: false, image: false }]),
    }),
  );
  await page.route("https://artifacts.example/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<p>source</p>" }),
  );

  await page.goto("/7/");
  await page.locator("#artifacts-toggle").click();
  await page.locator("#artifact-list li").first().click();

  const url = await currentFrame(page).getAttribute("src");
  expect(url).toBe("https://artifacts.example/c/7/pi/out/run.sh?view=source");
  expect(await currentFrame(page).evaluate((el) => el.classList.contains("image"))).toBe(false);
});

test("artifacts: arrow keys move through the files with a slide", async ({ page }) => {
  // Only a real browser can say the pane actually moves. jsdom asserts which file is
  // showing, which is a string; the *slide* is the part that makes it feel like a
  // page turn rather than a reload.
  await stubApi(page);
  await page.route("**/api/environment", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ artifactsBaseUrl: "https://artifacts.example", pageVersion: "t" }),
    }),
  );
  await page.route("**/api/c/*/artifacts", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        { key: "pi/one.md", wrote: 1, edited: 0, markdown: true, image: false },
        { key: "pi/two.md", wrote: 1, edited: 0, markdown: true, image: false },
        { key: "pi/three.md", wrote: 1, edited: 0, markdown: true, image: false },
      ]),
    }),
  );
  const asked: string[] = [];
  await page.route("https://artifacts.example/**", (route) => {
    asked.push(route.request().url());
    return route.fulfill({ status: 200, contentType: "text/html", body: "<p>doc</p>" });
  });

  await page.goto("/7/");
  await page.locator("#artifacts-toggle").click();
  await page.locator("#artifact-list li").first().click();
  await expect(page.locator("#artifacts-title")).toHaveText("one.md");

  // Right goes forward, left goes back, and the frame follows.
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#artifacts-title")).toHaveText("two.md");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#artifacts-title")).toHaveText("three.md");
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator("#artifacts-title")).toHaveText("two.md");

  // Each step really fetched the next document.
  expect(asked.some((u) => u.includes("two.md"))).toBe(true);
  expect(asked.some((u) => u.includes("three.md"))).toBe(true);

  // The slide really travels: sampled on animation frames while the step runs, not at a
  // fixed moment after the key — the first frame is legitimately still at rest, which
  // is what made an earlier version of this assertion flaky rather than wrong.
  await page.evaluate(() => {
    const track = document.getElementById("artifact-track")!;
    (window as unknown as { __offsets: number[] }).__offsets = [];
    const tick = () => {
      const offsets = (window as unknown as { __offsets: number[] }).__offsets;
      if (offsets.length < 30) requestAnimationFrame(tick);
      offsets.push(new DOMMatrix(getComputedStyle(track).transform).m41);
    };
    requestAnimationFrame(tick);
  });
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.getElementById("artifact-track")!).transform))
    .toBe("matrix(1, 0, 0, 1, 0, 0)");
  // Some frame was part-way along: neither at rest (0) nor clipped by the drawer edge.
  // Polled because the sampler starts on an animation frame and a machine under load
  // can miss the first few — asserting a single reading made this fail in a full run
  // while passing alone, which is a test that reports the weather rather than the code.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const offsets = (window as unknown as { __offsets: number[] }).__offsets;
        return offsets.some((x) => Math.abs(x) > 4 && Math.abs(x) < 300);
      }),
    )
    .toBe(true);
});

test("artifacts: a swipe reported by the document pages the drawer", async ({ page }) => {
  // The frame is cross-origin and sandboxed, so the page never sees the finger. This
  // drives the message the frame's own script sends, which is the real contract
  // between them — and checks the pane slides rather than jumping.
  await stubApi(page);
  await page.route("**/api/environment", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ artifactsBaseUrl: "https://artifacts.example", pageVersion: "t" }),
    }),
  );
  await page.route("**/api/c/*/artifacts", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        { key: "pi/one.md", wrote: 1, edited: 0, markdown: true, image: false },
        { key: "pi/two.md", wrote: 1, edited: 0, markdown: true, image: false },
      ]),
    }),
  );
  await page.route("https://artifacts.example/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<p>doc</p>" }),
  );

  await page.goto("/7/");
  await page.locator("#artifacts-toggle").click();
  await page.locator("#artifact-list li").first().click();
  await expect(page.locator("#artifacts-title")).toHaveText("one.md");

  // The messages the document posts during a gesture: a drag, which is what loads the
  // neighbour and moves the strip, then the release that commits it. A release on its
  // own carries nothing — there is no neighbour to carry in — which is why both are
  // sent here.
  const swipe = (direction: string, dx: number) =>
    page.evaluate(
      ({ dir, offset }) => {
        const frame = document.querySelector("#artifact-track .artifact-frame:not([hidden]):not([style*=\"order\"])") as HTMLIFrameElement;
        const post = (data: unknown) =>
          window.dispatchEvent(new MessageEvent("message", { data, source: frame.contentWindow }));
        post({ t: "pi-artifact-drag", dx: offset });
        post({ t: "pi-artifact-swipe", direction: dir, commit: true });
      },
      { dir: direction, offset: dx },
    );

  await swipe("left", -140);
  await expect(page.locator("#artifacts-title")).toHaveText("two.md");
  await swipe("right", 140);
  await expect(page.locator("#artifacts-title")).toHaveText("one.md");
});

test.describe("on a touch device", () => {
  // A constructed `TouchEvent` is only meaningful where the browser has touch: the
  // desktop project has `hasTouch: false`, and Chrome refuses to build one there.
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

test("artifacts: a real touch swipe in the document pages, and a scroll does not", async ({ page, context }) => {
  // The gesture the reader actually makes, driven through the browser's own input
  // pipeline (`Input.dispatchTouchEvent`) rather than by dispatching `TouchEvent`s
  // from inside the page. That distinction is the bug this test exists for: a
  // synthetic event skips the browser's gesture arbitration, so it passed while a
  // real finger did nothing on a phone.
  await stubApi(page);
  await page.route("**/api/environment", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ artifactsBaseUrl: "https://artifacts.example", pageVersion: "t" }),
    }),
  );
  await page.route("**/api/c/*/artifacts", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        { key: "pi/first.md", wrote: 1, edited: 0, markdown: false, image: false },
        { key: "pi/second.md", wrote: 1, edited: 0, markdown: false, image: false },
        { key: "pi/third.md", wrote: 1, edited: 0, markdown: false, image: false },
      ]),
    }),
  );
  await page.route("**/api/c/*/comments", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  // A document tall enough to scroll, carrying the real swipe script.
  await page.route("https://artifacts.example/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><html><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>html{touch-action:pan-y pinch-zoom}body{margin:0;padding:2rem}</style></head>
        <body><h1>a document</h1><p style="height:2000px">tall</p>
        <script>${SWIPE_SCRIPT}</script></body></html>`,
    }),
  );

  await page.goto("/7/");
  await page.locator("#artifacts-toggle").click();
  await page.locator("#artifact-list li").first().click();
  await expect(page.locator("#artifacts-title")).toHaveText("first.md");
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.getElementById("artifact-track")!).transform))
    .toBe("matrix(1, 0, 0, 1, 0, 0)");

  const cdp = await context.newCDPSession(page);
  const frameBox = async () => (await currentFrame(page).boundingBox())!;

  /** A finger dragged from one point to another, through the browser's input stack. */
  const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
    for (let i = 1; i <= 10; i += 1) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: from.x + ((to.x - from.x) * i) / 10, y: from.y + ((to.y - from.y) * i) / 10 }],
      });
      await page.waitForTimeout(12);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(400);
  };

  // A vertical drag is a scroll, not a page turn.
  const box = await frameBox();
  await drag(
    { x: box.x + box.width / 2, y: box.y + box.height * 0.75 },
    { x: box.x + box.width / 2, y: box.y + box.height * 0.2 },
  );
  await expect(page.locator("#artifacts-title")).toHaveText("first.md");

  // A horizontal swipe pages forward.
  await drag(
    { x: box.x + box.width * 0.85, y: box.y + box.height / 2 },
    { x: box.x + box.width * 0.15, y: box.y + box.height / 2 },
  );
  await expect(page.locator("#artifacts-title")).toHaveText("second.md");

  // And backwards.
  await drag(
    { x: box.x + box.width * 0.15, y: box.y + box.height / 2 },
    { x: box.x + box.width * 0.85, y: box.y + box.height / 2 },
  );
  await expect(page.locator("#artifacts-title")).toHaveText("first.md");
});

test("artifacts: swiping across an image pages too", async ({ page, context }) => {
  // The bug the reader actually hit: the image document was the only kind without
  // the swipe script, so swiping a picture did nothing while swiping Markdown
  // worked. Every test used Markdown, so nothing caught it.
  await stubApi(page);
  await page.route("**/api/environment", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ artifactsBaseUrl: "https://artifacts.example", pageVersion: "t" }),
    }),
  );
  await page.route("**/api/c/*/artifacts", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        { key: "pi/one.png", wrote: 1, edited: 0, markdown: false, image: true },
        { key: "pi/two.png", wrote: 1, edited: 0, markdown: false, image: true },
      ]),
    }),
  );
  await page.route("**/api/c/*/comments", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  // The image wrapper, with the script the artifact origin really serves in it.
  await page.route("https://artifacts.example/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><html><head><meta charset="utf-8">
        <style>html{touch-action:pan-y pinch-zoom}</style></head>
        <body><img src="x.png?raw" alt="a picture" style="max-width:100%">
        <script>${SWIPE_SCRIPT}</script></body></html>`,
    }),
  );

  await page.goto("/7/");
  await page.locator("#artifacts-toggle").click();
  await page.locator("#artifact-list li").first().click();
  await expect(page.locator("#artifacts-title")).toHaveText("one.png");
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.getElementById("artifact-track")!).transform))
    .toBe("matrix(1, 0, 0, 1, 0, 0)");

  const cdp = await context.newCDPSession(page);
  const box = (await currentFrame(page).boundingBox())!;
  const y = box.y + box.height / 2;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.width * 0.85, y }] });
  for (let i = 1; i <= 10; i += 1) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: box.x + box.width * (0.85 - 0.07 * i), y }],
    });
    await page.waitForTimeout(12);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

  await expect(page.locator("#artifacts-title")).toHaveText("two.png");
});

test("artifacts: a step does not reload anything already on screen", async ({ page, context }) => {
  // The architecture the flicker forced: one frame per document, never reloaded, with
  // the visible one changing as a matter of *position*. The old design reloaded the
  // frame on screen, and an iframe whose `src` changes is blank until the new document
  // paints — no ordering of the swap could hide that.
  //
  // So the property to hold is stronger than "loaded before it parks": a document
  // fetched once is never fetched again, and going back costs nothing at all.
  await stubApi(page);
  await page.route("**/api/environment", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ artifactsBaseUrl: "https://artifacts.example", pageVersion: "t" }),
    }),
  );
  await page.route("**/api/c/*/artifacts", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        { key: "pi/one.md", wrote: 1, edited: 0, markdown: false, image: false },
        { key: "pi/two.md", wrote: 1, edited: 0, markdown: false, image: false },
        { key: "pi/three.md", wrote: 1, edited: 0, markdown: false, image: false },
      ]),
    }),
  );
  await page.route("**/api/c/*/comments", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  const fetched: string[] = [];
  await page.route("https://artifacts.example/**", (route) => {
    fetched.push((route.request().url().split("/").pop() ?? "").split("?")[0]!);
    return route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><html><head><meta charset="utf-8">
        <style>html{touch-action:pan-y pinch-zoom}body{margin:0;height:100vh}</style></head>
        <body><script>${SWIPE_SCRIPT}</script></body></html>`,
    });
  });

  await page.goto("/7/");
  await page.locator("#artifacts-toggle").click();
  await page.locator("#artifact-list li").first().click();
  await expect(page.locator("#artifacts-title")).toHaveText("one.md");
  const settle = () =>
    expect
      .poll(() => page.evaluate(() => getComputedStyle(document.getElementById("artifact-track")!).transform))
      .toBe("matrix(1, 0, 0, 1, 0, 0)");
  await settle();
  expect(fetched).toEqual(["one.md"]);

  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#artifacts-title")).toHaveText("two.md");
  await settle();
  expect(fetched).toEqual(["one.md", "two.md"]);

  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#artifacts-title")).toHaveText("three.md");
  await settle();
  expect(fetched).toEqual(["one.md", "two.md", "three.md"]);

  // Back and forth: nothing new is fetched, because every document is still loaded.
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator("#artifacts-title")).toHaveText("two.md");
  await settle();
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator("#artifacts-title")).toHaveText("one.md");
  await settle();
  expect(fetched).toEqual(["one.md", "two.md", "three.md"]);

  // And the documents are all still in the pool, only one of them visible.
  const pool = await page.evaluate(() =>
    [...document.querySelectorAll("#artifact-track .artifact-frame")].map((f) => ({
      key: (f as HTMLElement).dataset.key,
      hidden: (f as HTMLElement).hidden,
    })),
  );
  expect(pool.filter((f) => !f.hidden)).toHaveLength(1);
  expect(pool.map((f) => f.key).sort()).toEqual(["pi/one.md", "pi/three.md", "pi/two.md"]);
});

test("artifacts: the pane follows the finger while dragging, not only on release", async ({ page, context }) => {
  // The request behind this: dragging used to do nothing visible until the finger
  // came up. Only a real browser can show the pane moving *during* the gesture,
  // because that is a computed transform at a moment mid-drag.
  await stubApi(page);
  await page.route("**/api/environment", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ artifactsBaseUrl: "https://artifacts.example", pageVersion: "t" }),
    }),
  );
  await page.route("**/api/c/*/artifacts", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        { key: "pi/first.md", wrote: 1, edited: 0, markdown: false, image: false },
        { key: "pi/second.md", wrote: 1, edited: 0, markdown: false, image: false },
      ]),
    }),
  );
  await page.route("**/api/c/*/comments", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  await page.route("https://artifacts.example/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><html><head><meta charset="utf-8">
        <style>html{touch-action:pan-y pinch-zoom}</style></head>
        <body><h1>a document</h1><script>${SWIPE_SCRIPT}</script></body></html>`,
    }),
  );

  await page.goto("/7/");
  await page.locator("#artifacts-toggle").click();
  await page.locator("#artifact-list li").first().click();
  await expect(page.locator("#artifacts-title")).toHaveText("first.md");
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.getElementById("artifact-track")!).transform))
    .toBe("matrix(1, 0, 0, 1, 0, 0)");

  const cdp = await context.newCDPSession(page);
  const box = (await currentFrame(page).boundingBox())!;
  const y = box.y + box.height / 2;
  const transformNow = () =>
    page.evaluate(() => getComputedStyle(document.getElementById("artifact-track")!).transform);

  // Finger down, dragged most of the way — and still down.
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.width * 0.85, y }] });
  for (let i = 1; i <= 8; i += 1) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: box.x + box.width * (0.85 - 0.08 * i), y }],
    });
    await page.waitForTimeout(16);
  }

  // The pane has moved, while the gesture is still in progress.
  const midDrag = await transformNow();
  expect(midDrag).not.toBe("matrix(1, 0, 0, 1, 0, 0)");
  const offset = Number(/matrix\(1, 0, 0, 1, (-?[\d.]+), 0\)/.exec(midDrag)?.[1] ?? "0");
  expect(offset).toBeLessThan(-40);

  // And releasing does not jump it back to the start before sliding on: the step
  // continues from where the finger left it.
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(page.locator("#artifacts-title")).toHaveText("second.md");
  await expect.poll(transformNow).toBe("matrix(1, 0, 0, 1, 0, 0)");
});
});

test("artifacts: the browser's back gesture returns to the list", async ({ page }) => {
  await stubApi(page);
  await page.route("**/api/environment", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ artifactsBaseUrl: "https://artifacts.example", pageVersion: "t" }),
    }),
  );
  await page.route("**/api/c/*/artifacts", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ key: "pi-gchat-bridge/CLOUDFLARE.md", wrote: 1, edited: 1, markdown: true }]),
    }),
  );
  await page.route("https://artifacts.example/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<p>doc</p>" }),
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/7/");
  await page.locator("#artifacts-toggle").click();
  await page.locator("#artifact-list li").first().click();
  await expect(page.locator("#artifacts-title")).toHaveText("CLOUDFLARE.md");
  // Opening a document is a history entry, so the gesture has something to undo.
  // The key is URL-encoded in the hash: it is a path.
  expect(decodeURIComponent(await page.evaluate(() => window.location.hash.slice(1)))).toBe(
    "pi-gchat-bridge/CLOUDFLARE.md",
  );

  await page.evaluate(() => window.history.back());

  // What the gesture means: back to the list — not a file's name over a blank page.
  await expect(page.locator("#artifacts-title")).toHaveText("Artifacts");
  expect(await page.evaluate(() => document.getElementById("artifacts")!.classList.contains("showing-doc"))).toBe(false);
  await expect(page.locator("#artifact-list li").first()).toBeVisible();
});

test("artifacts: the drawer narrows the conversation instead of covering it", async ({ page }) => {
  await stubApi(page);
  await page.route("**/api/environment", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ artifactsBaseUrl: "https://artifacts.example", pageVersion: "t" }),
    }),
  );
  await page.route("**/api/c/*/artifacts", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );

  // Narrow enough that an overlay would swallow the middle of the conversation —
  // which is what it used to do, while leaving empty space to the left of it.
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto("/7/");
  await page.locator("#artifacts-toggle").click();

  const side = await page.evaluate(() => {
    const box = (id: string) => document.getElementById(id)!.getBoundingClientRect();
    return { log: box("log").toJSON(), drawer: box("artifacts").toJSON() };
  });
  // Side by side, not on top: the log ends where the drawer begins.
  expect(Math.round(side.log.right)).toBeLessThanOrEqual(Math.round(side.drawer.left) + 1);
  expect(side.log.width).toBeGreaterThan(200);
  expect(side.drawer.width).toBeGreaterThan(200);
});

test("artifacts: dragging the left edge resizes the drawer, and it is remembered", async ({ page }) => {
  await stubApi(page);
  await page.route("**/api/environment", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ artifactsBaseUrl: "https://artifacts.example", pageVersion: "t" }),
    }),
  );
  await page.route("**/api/c/*/artifacts", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );

  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/7/");
  await page.locator("#artifacts-toggle").click();
  const before = (await page.locator("#artifacts").boundingBox())!.width;

  const handle = (await page.locator("#artifacts-resize").boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 200);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 - 120, handle.y + 200, { steps: 6 });
  await page.mouse.up();

  const after = (await page.locator("#artifacts").boundingBox())!.width;
  expect(Math.round(after)).toBeGreaterThan(Math.round(before) + 100);
  // The conversation kept room to live in.
  const log = (await page.locator("#log").boundingBox())!;
  expect(log.width).toBeGreaterThan(200);

  await page.reload();
  await page.locator("#artifacts-toggle").click();
  const remembered = (await page.locator("#artifacts").boundingBox())!.width;
  expect(Math.round(remembered)).toBeGreaterThan(Math.round(before) + 100);

  // And the drag stops before the drawer eats the conversation.
  const handle2 = (await page.locator("#artifacts-resize").boundingBox())!;
  await page.mouse.move(handle2.x + handle2.width / 2, handle2.y + 200);
  await page.mouse.down();
  await page.mouse.move(5, handle2.y + 200, { steps: 6 });
  await page.mouse.up();
  const widest = (await page.locator("#log").boundingBox())!;
  expect(widest.width).toBeGreaterThanOrEqual(200);
});

// --- The format picker -------------------------------------------------------
//
// jsdom can assert the clicks; only a real browser can assert that the popup is
// *on screen* and that the phone presentation is a sheet rather than a 16rem box
// floating under a thumb. Both are the kind of thing that looks right in a DOM
// dump and wrong in a hand.

/**
 * Two boxes share an edge, within a pixel.
 *
 * A split button where the halves drift apart is two buttons with a gap, which is
 * the thing this layout exists to avoid — and it is invisible to a DOM assertion.
 */
function assertAdjacent(left: { x: number; y: number; width: number; height: number },
                        right: { x: number; y: number; width: number; height: number }): void {
  expect(Math.abs(left.x + left.width - right.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(left.y - right.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(left.height - right.height)).toBeLessThanOrEqual(1);
}

const MODELS = [
  { provider: "deepseek", id: "deepseek-flash", label: "DeepSeek V4.1 Flash", levels: ["low", "high"] },
  { provider: "llama-local", id: "lfm3", label: "LFM3 (local)", levels: [] },
];

const FORMAT = { model: "deepseek/deepseek-flash", thinking: "high", levels: ["low", "high"] };

test("the send caret opens a popup that is actually on screen", async ({ page }) => {
  const errors = watchErrors(page);
  await stubApi(page, { format: FORMAT, models: MODELS });
  await page.goto("/7/");

  // A split button: Send and the caret are two halves of one control.
  const send = page.locator("#send-primary");
  const caret = page.locator("#send-menu");
  await expect(send).toBeVisible();
  await expect(send).toHaveText("Send");
  await expect(caret).toBeVisible();
  // Side by side and touching, or it is two buttons with a gap.
  const sendBox = (await send.boundingBox())!;
  const caretBox = (await caret.boundingBox())!;
  assertAdjacent(sendBox, caretBox);

  await caret.click();
  const picker = page.locator("#picker");
  await expect(picker).toBeVisible();

  // The popup must be inside the viewport. A list rendered below the composer, or
  // pushed off the left edge by a narrow window, is "visible" to a DOM check and
  // unusable to a person.
  const box = await picker.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);

  // Anchored to its button, not parked in a corner.
  const anchor = (await caret.boundingBox())!;
  expect(box!.y + box!.height).toBeLessThanOrEqual(anchor.y + 1);
  // Right-aligned to the caret: the popup grows leftwards from the button that
  // opened it, so it cannot hang off the right edge of a narrow window.
  expect(Math.abs(box!.x + box!.width - anchor.x - anchor.width)).toBeLessThan(120);

  await expect(page.locator("#picker-list .item")).toHaveCount(2);
  await expect(page.locator("#picker-list .item.current")).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("the composer's controls share one height and one shape", async ({ page }) => {
  // The row looked assembled because it *was*: the attach button had a different
  // height and radius from the send group, and the box a different radius again.
  // Only a real browser can measure this, and the mismatch was invisible to every
  // DOM assertion.
  const errors = watchErrors(page);
  await stubApi(page, { format: FORMAT, models: MODELS });
  await page.goto("/7/");

  const box = (await page.locator("#text").boundingBox())!;
  const attach = (await page.locator("#attach").boundingBox())!;
  const send = (await page.locator("#send-group").boundingBox())!;

  // One height across the row, within a pixel.
  expect(Math.abs(box.height - attach.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(box.height - send.height)).toBeLessThanOrEqual(1);
  // Bottom edges level: the row is baseline-aligned, not ragged.
  expect(Math.abs(box.y + box.height - (attach.y + attach.height))).toBeLessThanOrEqual(1);
  expect(Math.abs(box.y + box.height - (send.y + send.height))).toBeLessThanOrEqual(1);
  // Equal gaps, so the three read as a group rather than three objects.
  const gapOne = attach.x - (box.x + box.width);
  const gapTwo = send.x - (attach.x + attach.width);
  expect(Math.abs(gapOne - gapTwo)).toBeLessThanOrEqual(1);

  // The attach button is a square, not a squashed pill.
  expect(Math.abs(attach.width - attach.height)).toBeLessThanOrEqual(1);

  // And the send half is visibly the action, not another neutral field.
  const sendColour = await page.locator("#send-primary").evaluate(
    (element) => getComputedStyle(element.parentElement!).backgroundColor,
  );
  const boxColour = await page.locator("#text").evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(sendColour).not.toBe(boxColour);

  expect(errors).toEqual([]);
});

test("a model's row is not taller than its name needs", async ({ page }) => {
  // The id line under each name doubled every row for information the label
  // already carried.
  const errors = watchErrors(page);
  await stubApi(page, { format: FORMAT, models: MODELS });
  await page.goto("/7/");
  await page.locator("#send-menu").click();

  // Name only: no second line in the row.
  await expect(page.locator("#picker-list .item").first().locator(".detail")).toHaveCount(0);
  await expect(page.locator("#picker-list .item").first()).toContainText("DeepSeek V4.1 Flash");
  await expect(page.locator("#picker-list .item").first()).not.toContainText("deepseek/");
  expect(errors).toEqual([]);
});

test("on a phone the picker is a full-width sheet with a search box", async ({ page }) => {
  const errors = watchErrors(page);
  await stubApi(page, { format: FORMAT, models: MODELS });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/7/");

  await page.locator("#send-menu").click();
  const picker = page.locator("#picker");
  await expect(picker).toBeVisible();

  // Full width, pinned to the bottom: a sheet, not a popup.
  const box = await picker.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(389);
  expect(box!.y + box!.height).toBeGreaterThanOrEqual(843);

  // And searchable, because finding one model in forty under a thumb is typing.
  await expect(page.locator("#picker-search")).toBeVisible();
  await page.locator("#picker-search").fill("local");
  await expect(page.locator("#picker-list .item")).toHaveCount(1);

  expect(errors).toEqual([]);
});

test("choosing a model stages it, and Apply sends it through the command", async ({ page }) => {
  const errors = watchErrors(page);
  const applied: { text?: string; values?: Record<string, string> }[] = [];
  await stubApi(page, {
    format: FORMAT,
    models: MODELS,
    // The command answers with a form, which is how a successful `/model` replies.
    commandResponse: { kind: "form", prompt: "Model and thinking level", command: "/model", fields: [] },
    onCommand: (body) => applied.push(body),
  });
  await page.goto("/7/");

  await page.locator("#send-menu").click();
  await page.locator("#picker-list .item").nth(1).click();

  // The reported bug: this used to close the popup, so the thinking level under the
  // model was unreachable. A tap stages; the popup stays.
  await expect(page.locator("#picker")).toBeVisible();
  await expect(page.locator("#picker-list .item").nth(1)).toHaveClass(/staged/);
  expect(applied).toHaveLength(0);

  await page.locator("#picker-apply").click();
  await expect(page.locator("#picker")).toBeHidden();

  expect(applied).toHaveLength(1);
  expect(applied[0]!.text).toBe("/model");
  expect(applied[0]!.values?.model).toBe("llama-local/lfm3");
  // A model with no levels is sent with none, rather than with the old model's.
  expect(applied[0]!.values?.thinking).toBeUndefined();
  expect(errors).toEqual([]);
});

test("a model and its thinking level are chosen before anything is applied", async ({ page }) => {
  // The point of the Apply button: the popup answers one question in two parts, and
  // the second part used to be gone before it could be answered.
  const errors = watchErrors(page);
  const applied: { text?: string; values?: Record<string, string> }[] = [];
  await stubApi(page, {
    format: FORMAT,
    models: MODELS,
    commandResponse: { kind: "form", prompt: "Model and thinking level", command: "/model", fields: [] },
    onCommand: (body) => applied.push(body),
  });
  await page.goto("/7/");

  await page.locator("#send-menu").click();
  const rows = page.locator("#picker-levels .item");
  await expect(rows).toHaveCount(2);
  await rows.first().click();

  // Staged, and the popup is still there to commit it.
  await expect(page.locator("#picker")).toBeVisible();
  await expect(rows.first()).toHaveClass(/staged/);
  expect(applied).toHaveLength(0);

  await page.locator("#picker-apply").click();
  await expect(page.locator("#picker")).toBeHidden();
  expect(applied[0]!.values).toEqual({ model: "deepseek/deepseek-flash", thinking: "low" });
  expect(errors).toEqual([]);
});

test("the Apply button sits inside the popup, with the lists scrolling above it", async ({ page }) => {
  // A footer that scrolls away with a forty-model list is a button nobody finds.
  const errors = watchErrors(page);
  const long = Array.from({ length: 40 }, (_, i) => ({
    provider: "p",
    id: `m${i}`,
    label: `Model ${i}`,
    levels: ["low", "high"],
  }));
  await stubApi(page, { format: FORMAT, models: long });
  await page.goto("/7/");

  await page.locator("#send-menu").click();
  const picker = page.locator("#picker");
  const apply = page.locator("#picker-apply");
  await expect(apply).toBeVisible();

  const box = (await picker.boundingBox())!;
  const button = (await apply.boundingBox())!;
  const viewport = page.viewportSize()!;

  // Inside the popup, not floating below it or clipped by it.
  expect(button.y).toBeGreaterThanOrEqual(box.y);
  expect(button.y + button.height).toBeLessThanOrEqual(box.y + box.height + 1);
  // And the popup fits the window even with forty models to scroll.
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);

  // Scrolling the list leaves Apply where it was.
  await page.locator("#picker-list").evaluate((list) => { list.scrollTop = 400; });
  const after = (await apply.boundingBox())!;
  expect(Math.abs(after.y - button.y)).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});

test("every model and every level is fully visible, not scrolled to the fold", async ({ page }) => {
  // The Apply footer and the levels list both cost height, and the popup's cap used
  // to be a guess (34rem) sized before either existed: a five-model list with a
  // four-level model left the last level half under the footer, which reads as a
  // clipped list rather than a scrollable one. Only a real browser can see this.
  const errors = watchErrors(page);
  const five = [
    { provider: "deepseek", id: "deepseek-flash", label: "DeepSeek V4.1 Flash", levels: ["low", "medium", "high"] },
    { provider: "anthropic", id: "claude-sonnet-4", label: "Claude Sonnet 4", levels: ["low", "medium", "high"] },
    { provider: "anthropic", id: "claude-opus-4", label: "Claude Opus 4", levels: ["low", "medium", "high"] },
    { provider: "openai", id: "gpt-5", label: "GPT-5", levels: ["minimal", "low", "medium", "high"] },
    { provider: "llama-local", id: "lfm3", label: "LFM3 (local)", levels: [] },
  ];
  await stubApi(page, { format: FORMAT, models: five });
  await page.goto("/7/");

  await page.locator("#send-menu").click();
  // A model with four levels: the tallest the two lists get together.
  await page.locator("#picker-list .item", { hasText: "GPT-5" }).click();

  // Neither list is scrolled: everything it holds fits.
  const clipped = await page.evaluate(() =>
    ["picker-list", "picker-levels"].map((id) => {
      const element = document.getElementById(id)!;
      return { id, scroll: element.scrollHeight, client: element.clientHeight };
    }),
  );
  for (const list of clipped) {
    expect(list.scroll, `${list.id} holds more than it shows`).toBeLessThanOrEqual(list.client + 1);
  }

  // And the last level is above the footer rather than under it.
  const lastLevel = (await page.locator("#picker-levels .item").last().boundingBox())!;
  const footer = (await page.locator("#picker-actions").boundingBox())!;
  expect(lastLevel.y + lastLevel.height).toBeLessThanOrEqual(footer.y + 1);
  expect(errors).toEqual([]);
});

test("a phone resize while the picker is open does not close it", async ({ page }) => {
  // The reported bug: tapping the caret on a phone made it flicker and do nothing.
  // A tap on a phone is enough to fire `resize` — browser chrome collapsing, the
  // address bar reflowing — and the handler used to treat *any* resize as "the
  // anchor moved, close it". On the sheet there is no anchor to move.
  const errors = watchErrors(page);
  await stubApi(page, { format: FORMAT, models: MODELS });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/7/");

  await page.locator("#send-menu").click();
  await expect(page.locator("#picker")).toBeVisible();

  // What the browser does by itself on the first scroll or tap.
  await page.setViewportSize({ width: 390, height: 780 });
  await page.waitForTimeout(200);

  // Still open, still usable, still full width.
  await expect(page.locator("#picker")).toBeVisible();
  await expect(page.locator("#picker-list .item")).toHaveCount(MODELS.length);
  const box = (await page.locator("#picker").boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(389);
  expect(errors).toEqual([]);
});

test("opening the picker does not focus the search box", async ({ page }) => {
  // Focusing it raised the on-screen keyboard over a list that is usually answered by
  // tapping. Most visits pick a model; a keyboard covering the first rows costs more
  // than typing would save. The box is still there, one tap away, for a long list.
  const errors = watchErrors(page);
  await stubApi(page, { format: FORMAT, models: MODELS });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/7/");

  await page.locator("#send-menu").click();
  await expect(page.locator("#picker")).toBeVisible();

  const focused = await page.evaluate(() => document.activeElement?.id ?? "");
  expect(focused).not.toBe("picker-search");
  // Focus stays on the control that was pressed, so the menu is not detached from it.
  expect(focused).toBe("send-menu");

  // And the search still does its job when it is wanted.
  await page.locator("#picker-search").fill("local");
  await expect(page.locator("#picker-list .item")).toHaveCount(1);
  expect(errors).toEqual([]);
});

/**
 * Installability, in a real browser.
 *
 * The server's own answer is under test here, not a route stub: the stub helper
 * intercepts `api/` calls only, and the manifest and the icon are not under `/api`, so both are served
 * by the running bridge. That is the only way to catch the class of fault that makes
 * an install silently unavailable — a manifest that is not linked, an icon that
 * 404s, a start URL outside the scope — because none of those change how a page
 * *looks*; the browser just never offers the install.
 */
test("the page is installable, and the manifest describes where it is served", async ({ page }) => {
  const errors = watchErrors(page);
  await stubApi(page);
  // The index names the app; a conversation names itself. Both from the same rule,
  // so a standalone window is legible in a task switcher either way.
  await page.goto("/web/");
  await expect(page).toHaveTitle("pi bridge");

  // Linked, and resolved to the mount rather than the origin root.
  const href = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(href).toBe("manifest.webmanifest");
  const manifestUrl = await page.evaluate(() =>
    new URL(document.querySelector('link[rel="manifest"]')!.getAttribute("href")!, document.baseURI).pathname,
  );
  expect(manifestUrl).toBe("/web/manifest.webmanifest");

  // Chrome's own parse of it, not ours: if this fails the install prompt never
  // appears, whatever the file looks like in a text editor.
  const fetched = await page.evaluate(async (url) => {
    const response = await fetch(url);
    return { status: response.status, type: response.headers.get("content-type"), body: await response.text() };
  }, manifestUrl);
  expect(fetched.status).toBe(200);
  expect(fetched.type).toContain("application/manifest+json");
  const manifest = JSON.parse(fetched.body) as { start_url: string; scope: string; display: string; icons: { src: string }[] };
  expect(manifest.start_url).toBe("/web/");
  expect(manifest.scope).toBe("/web/");
  expect(manifest.display).toBe("standalone");

  // The icon the manifest names actually loads as an image — an icon that 404s is
  // the classic "manifest is valid but install is refused".
  const iconOk = await page.evaluate(async (src) => {
    const response = await fetch(new URL(src, document.baseURI).pathname);
    return response.ok && (await response.text()).startsWith("<svg");
  }, manifest.icons[0]!.src);
  expect(iconOk).toBe(true);

  // And the standalone window titles itself after the conversation.
  await page.goto("/7/");
  await expect(page.locator("#conv-title")).toHaveText("deploy notes");
  await expect(page).toHaveTitle("deploy notes — pi bridge");
  expect(errors).toEqual([]);
});

/**
 * The entry anchor, in a real browser.
 *
 * The jsdom tests prove the row is found and marked; only a browser can say whether the scroll
 * actually moved, which is the part a reader notices. This is the "silent failure" the plan
 * called out — a link that lands at the bottom of the thread looks like it worked.
 */
test("a link to a message scrolls that message into view", async ({ page }) => {
  const errors = watchErrors(page);
  await stubApi(page, {
    history: [
      { role: "user", text: "the first message", html: "<p>the first message</p>", entryId: 41 },
      { role: "assistant", text: "an answer", html: "<p>an answer</p>", entryId: 42 },
      { role: "user", text: "the last message", html: "<p>the last message</p>", entryId: 43 },
    ],
  });
  await page.goto("/7/#e41");

  const row = page.locator('[data-entry="41"]');
  await expect(row).toHaveClass(/at-entry/);
  // In view, not merely marked: `scrollIntoView` is the part jsdom cannot check.
  await expect(row).toBeInViewport();
  expect(errors).toEqual([]);
});

test("a link to a message that is not there says so", async ({ page }) => {
  await stubApi(page, {
    history: [{ role: "user", text: "only message", html: "<p>only</p>", entryId: 41 }],
  });
  await page.goto("/7/#e999");
  // The fragment survives a reload, so an old link must read as "gone", not as "here".
  await expect(page.locator("#log .anchor-miss")).toHaveText(/not in this conversation/);
});

test("artifacts: dragging over a picture selects a region and opens the comment box", async ({ page }) => {
  // The gesture this feature exists for. It can only be checked in a real browser: the
  // rectangle is measured against a *laid out* image, so the scale from screen pixels to
  // the picture's own pixels is what is being tested, and a jsdom element has no layout.
  //
  // The wrapper served here is the real `imageDocument` markup (class, `data-file`, both
  // scripts), so the messages the drawer receives are the ones production would send.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAYAAACinX6EAAAAJUlEQVR42u3NMQEAAAgDoC251a3gLwSgcyfTVFVVVVVVVVVVVVX1tQFrwAPhpO4WAAAAAElFTkSuQmCC",
    "base64",
  );

  await stubApi(page);
  await page.route("**/api/environment", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ artifactsBaseUrl: "https://artifacts.example", pageVersion: "t" }),
    }),
  );
  await page.route("**/api/c/*/artifacts", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        { key: "pi/out/screenshot.png", wrote: 1, edited: 0, markdown: false, image: true },
      ]),
    }),
  );
  await page.route("**/api/c/*/comments", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );

  const posted: unknown[] = [];
  await page.route("**/api/c/*/comments", (route) => {
    if (route.request().method() === "POST") {
      posted.push(route.request().postDataJSON());
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, id: "c1", submissionId: 5 }),
      });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });

  await page.route("https://artifacts.example/**", (route) => {
    const url = route.request().url();
    if (url.includes("?raw")) return route.fulfill({ status: 200, contentType: "image/png", body: png });
    if (url.includes("?region=")) {
      return route.fulfill({ status: 200, contentType: "image/png", body: png });
    }
    return route.fulfill({
      status: 200,
      contentType: "text/html",
      body: imageDocumentFor("pi/out/screenshot.png"),
    });
  });

  await page.goto("/7/");
  await page.locator("#artifacts-toggle").click();
  await page.locator("#artifact-list li").first().click();
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.getElementById("artifact-track")!).transform))
    .toBe("matrix(1, 0, 0, 1, 0, 0)");

  const frameOf = async (): Promise<import("@playwright/test").Frame> => {
    for (const candidate of page.frames()) {
      if (candidate === page.mainFrame() || !candidate.url().includes("screenshot.png")) continue;
      try {
        if (await candidate.evaluate(() => document.images.length > 0)) return candidate;
      } catch {
        // Mid-navigation; try the next poll.
      }
    }
    throw new Error("no frame with the picture yet");
  };
  await expect.poll(async () => {
    try {
      await frameOf();
      return true;
    } catch {
      return false;
    }
  }).toBe(true);
  const frame = await frameOf();
  const drawn = await frame.evaluate(() => {
    const image = document.querySelector("img")!;
    const box = image.getBoundingClientRect();
    return { left: box.left, top: box.top, width: box.width, height: box.height };
  });
  // The picture is drawn smaller than its 64x32 self, so the scale from screen to file
  // pixels is real and the assertion below is not trivially true.
  expect(drawn.width).toBeGreaterThan(0);

  // Arm the picture first. A drag over an unarmed picture is the browser's — that is
  // what lets pan and pinch work — so commenting is now: press the button, then drag.
  await page.locator("#comment-fab").click();
  await expect
    .poll(() => frame.evaluate(() => document.querySelector("img")!.classList.contains("armed")))
    .toBe(true);

  // Drag across the left half of the picture. A mouse is used rather than a touch: the
  // region script listens to pointer events, and a mouse drag is the same gesture.
  await frame.evaluate(() => {
    const image = document.querySelector("img")!;
    const box = image.getBoundingClientRect();
    const at = (fx: number, fy: number) => ({ x: box.left + box.width * fx, y: box.top + box.height * fy });
    const from = at(0.1, 0.2);
    const to = at(0.6, 0.7);
    const send = (type: string, point: { x: number; y: number }) =>
      image.dispatchEvent(
        new PointerEvent(type, { clientX: point.x, clientY: point.y, bubbles: true, pointerId: 1, pointerType: "mouse", button: 0 }),
      );
    send("pointerdown", from);
    send("pointermove", to);
    send("pointerup", to);
  });

  // The comment box opens, addressed by the rectangle rather than by a line.
  await expect(page.locator("#comment-bar")).toBeVisible();
  // The comment box opens, addressed by the rectangle rather than by a line.
  await expect(page.locator("#comment-bar")).toBeVisible();
  await expect(page.locator("#comment-addr")).toContainText("screenshot.png x");
  // And the selected part is previewed, from the same URL the comment will carry.
  await expect(page.locator("#comment-preview")).toBeVisible();
  expect(await page.locator("#comment-preview").getAttribute("src")).toMatch(/\?region=x\d+,y\d+,w\d+,h\d+$/);

  await page.locator("#comment-text").fill("this button is in the wrong place");
  await page.locator("#comment-send").click();

  await expect.poll(() => posted.length).toBe(1);
  const body = posted[0] as { file: string; region: { x: number; y: number; width: number; height: number; imageWidth: number; imageHeight: number } };
  expect(body.file).toBe("pi/out/screenshot.png");
  // In the picture's own pixels: the 64x32 file, not the drawn box. A rectangle counted
  // in screen pixels would be a different number here and would point elsewhere in a
  // drawer of another width — which is the bug this conversion exists to prevent.
  expect(body.region.imageWidth).toBe(64);
  expect(body.region.imageHeight).toBe(32);
  expect(body.region.x).toBeGreaterThan(0);
  expect(body.region.y).toBeGreaterThan(0);
  expect(body.region.width).toBeGreaterThan(8);
  expect(body.region.height).toBeGreaterThan(8);
  expect(body.region.x + body.region.width).toBeLessThanOrEqual(64);
  expect(body.region.y + body.region.height).toBeLessThanOrEqual(32);
});

test("artifacts: opening an image comment shows the part of the picture it is about", async ({ page }) => {
  // A region comment has no quote to show, so the thread's only honest answer to "what
  // is this about" is the crop. It also means a picture that has since been replaced is
  // visibly not the one the comment was written against.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAYAAACinX6EAAAAJUlEQVR42u3NMQEAAAgDoC251a3gLwSgcyfTVFVVVVVVVVVVVVX1tQFrwAPhpO4WAAAAAElFTkSuQmCC",
    "base64",
  );
  await stubApi(page);
  await page.route("**/api/environment", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ artifactsBaseUrl: "https://artifacts.example", pageVersion: "t" }),
    }),
  );
  await page.route("**/api/c/*/artifacts", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ key: "pi/out/screenshot.png", wrote: 1, edited: 0, markdown: false, image: true }]),
    }),
  );
  const comment = {
    id: "c1",
    file: "pi/out/screenshot.png",
    anchors: [],
    region: { x: 8, y: 4, width: 16, height: 12, imageWidth: 64, imageHeight: 32 },
    address: "pi/out/screenshot.png#x8,y4,w16,h12",
    text: "this button is in the wrong place",
    at: 1,
    author: "henry",
    state: "visible",
    resolved: false,
    positions: [],
    replies: 0,
  };
  await page.route("**/api/c/*/comments", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([comment]) }),
  );
  await page.route("**/api/c/*/comments/*/thread", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  await page.route("https://artifacts.example/**", (route) => {
    const url = route.request().url();
    if (url.includes("?raw") || url.includes("?region=")) {
      return route.fulfill({ status: 200, contentType: "image/png", body: png });
    }
    return route.fulfill({ status: 200, contentType: "text/html", body: imageDocumentFor("pi/out/screenshot.png") });
  });

  await page.goto("/7/");
  await page.locator("#artifacts-toggle").click();
  await page.locator("#artifact-list li").first().click();
  await expect(page.locator("#artifacts-title")).toHaveText("screenshot.png");

  // Open the thread the way the drawer does — `openThread(id)`, which is what a click on
  // a commented line's mark calls. The mark itself is drawn inside the frame, and a
  // picture has none yet (see `docs/artifacts.md`, "not done yet"), so the entry point is
  // the part under test here.
  await page.evaluate(() => (window as unknown as { openThread?: (id: string) => void }).openThread?.("c1"));
  await expect(page.locator("#comment-sheet")).toBeVisible();
  await expect(page.locator("#comment-sheet-addr")).toHaveText("pi/out/screenshot.png#x8,y4,w16,h12");
  await expect(page.locator("#comment-sheet-preview")).toBeVisible();
  expect(await page.locator("#comment-sheet-preview").getAttribute("src"))
    .toBe("https://artifacts.example/c/7/pi/out/screenshot.png?region=x8,y4,w16,h12");
});

test("artifacts: a PDF opens as a rendered page, and a rectangle on it is a comment", async ({ page }) => {
  // The request this exists for: clicking a PDF in the drawer shows the document rather
  // than "looks binary", and the same drag-to-comment gesture a picture has works on the
  // page. The page arrives as an image from the server, so the drawer's own code needs
  // to know only that a PDF is framed like a picture.
  await stubApi(page);
  await page.route("**/api/environment", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ artifactsBaseUrl: "https://artifacts.example", pageVersion: "t" }),
    }),
  );
  await page.route("**/api/c/*/artifacts", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        { key: "pi/out/resume.pdf", wrote: 1, edited: 0, markdown: false, image: false, pdf: true },
      ]),
    }),
  );
  await page.route("**/api/c/*/comments", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );

  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAYAAACinX6EAAAAJUlEQVR42u3NMQEAAAgDoC251a3gLwSgcyfTVFVVVVVVVVVVVVX1tQFrwAPhpO4WAAAAAElFTkSuQmCC",
    "base64",
  );
  const asked: string[] = [];
  await page.route("https://artifacts.example/**", (route) => {
    const url = route.request().url();
    asked.push(url);
    if (url.includes("&png") || url.includes("?raw")) {
      return route.fulfill({ status: 200, contentType: "image/png", body: png });
    }
    if (url.includes("region=")) {
      return route.fulfill({ status: 200, contentType: "image/png", body: png });
    }
    // The page document the artifact origin really builds: the gesture surface, the
    // paging strip, and both scripts.
    return route.fulfill({
      status: 200,
      contentType: "text/html",
      body: pdfPageDocumentFor("pi/out/resume.pdf", 1, 3),
    });
  });

  await page.goto("/7/");
  await page.locator("#artifacts-toggle").click();

  // The row says what it is, so a reader knows a document opens rather than source.
  const row = page.locator("#artifact-list li", { hasText: "resume.pdf" });
  await expect(row.locator(".counts")).toContainText("pdf");

  await row.click();
  await expect(page.locator("#artifacts-title")).toHaveText("resume.pdf");
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.getElementById("artifact-track")!).transform))
    .toBe("matrix(1, 0, 0, 1, 0, 0)");

  // The frame asks for the *page document*, not for the PDF's bytes and not for a
  // source view: a PDF has no lines to number.
  const src = await currentFrame(page).getAttribute("src");
  expect(src).toBe("https://artifacts.example/c/7/pi/out/resume.pdf");

  // ↗ opens the PDF itself, not the rendered page: a raster is for reviewing, the
  // document is for reading. Asserted on the URL the button builds rather than on a
  // popup, because a popup is a second tab this test has not stubbed.
  const newTabUrl = await page.evaluate(() => {
    const open = window.open;
    let called: string | undefined;
    (window as unknown as { open: unknown }).open = (u: string) => {
      called = u;
      return null;
    };
    try {
      (document.getElementById("artifacts-newtab") as HTMLElement).click();
    } finally {
      (window as unknown as { open: unknown }).open = open;
    }
    return called;
  });
  expect(newTabUrl).toBe("https://artifacts.example/c/7/pi/out/resume.pdf?raw");
});

test("artifacts: the crop of a PDF comment names the page it was drawn on", async ({ page }) => {
  // The bug this guards: the drawer's own state still says page 1 after the reader turns
  // a page, because the paging links navigate the *frame* and a navigation inside a frame
  // never touches the parent's DOM. A comment drawn on page 3 would then crop page 1 —
  // invisible in a one-page document, and wrong in every real one.
  await stubApi(page);
  await page.route("**/api/environment", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ artifactsBaseUrl: "https://artifacts.example", pageVersion: "t" }),
    }),
  );
  await page.route("**/api/c/*/artifacts", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        { key: "pi/out/resume.pdf", wrote: 1, edited: 0, markdown: false, image: false, pdf: true },
      ]),
    }),
  );
  await page.route("**/api/c/*/comments", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );

  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAYAAACinX6EAAAAJUlEQVR42u3NMQEAAAgDoC251a3gLwSgcyfTVFVVVVVVVVVVVVX1tQFrwAPhpO4WAAAAAElFTkSuQmCC",
    "base64",
  );
  const crops: string[] = [];
  await page.route("https://artifacts.example/**", (route) => {
    const url = route.request().url();
    if (url.includes("region=")) crops.push(url);
    if (url.includes("&png") || url.includes("?raw") || url.includes("region=")) {
      return route.fulfill({ status: 200, contentType: "image/png", body: png });
    }
    const page = Number(/[?&]page=(\d+)/.exec(url)?.[1] ?? "1");
    return route.fulfill({
      status: 200,
      contentType: "text/html",
      body: pdfPageDocumentFor("pi/out/resume.pdf", page, 3),
    });
  });

  await page.goto("/7/");
  await page.locator("#artifacts-toggle").click();
  await page.locator("#artifact-list li", { hasText: "resume.pdf" }).click();
  await expect(page.locator("#artifacts-title")).toHaveText("resume.pdf");

  // The reader turns to page 3 — by *clicking the paging link*, which is the gesture the
  // document actually offers. A `location.href` assignment from the test would do the same
  // thing to the frame's history but reads as a test hacking the state rather than using
  // it, and it hides whether the link works at all.
  // Not the main frame: its URL fragment carries the artifact key, so a substring match
  // on `resume.pdf` finds the *page* and not the document inside the drawer.
  const pageDocument = page
    .frames()
    .find((f) => f !== page.mainFrame() && f.url().includes("resume.pdf"));
  expect(pageDocument).toBeTruthy();
  await expect
    .poll(async () => pageDocument!.evaluate(() => Boolean(document.querySelector(".pages a[rel=next]"))).catch(() => false))
    .toBe(true);
  // Two turns, to page 3: a single page turn would pass even if the drawer were stuck
  // reporting "page 2" as a constant, and the point is that the page is read, not guessed.
  for (const target of ["page=2", "page=3"]) {
    const at = page.frames().find((f) => f !== page.mainFrame() && f.url().includes(target.endsWith("2") ? "resume.pdf" : "page=2"));
    await expect
      .poll(async () => at!.evaluate(() => document.readyState === "complete" && Boolean(document.querySelector(".pages a[rel=next]"))).catch(() => false))
      .toBe(true);
    await at!.evaluate(() => {
      (document.querySelector(".pages a[rel=next]") as HTMLElement).click();
    });
    await expect
      .poll(() => page.frames().some((f) => f !== page.mainFrame() && f.url().includes(target)))
      .toBe(true);
  }

  // A frame whose URL already names page 3 can still be mid-navigation, with no document
  // in it; waiting for the picture is waiting for the page the reader actually sees, and
  // a pointer event sent into a loading document is simply dropped.
  const frame = await expect
    .poll(async () => {
      const candidate = page
        .frames()
        .find((f) => f !== page.mainFrame() && (f.url().includes("page=2") || f.url().includes("page=3")));
      if (!candidate) return false;
      return candidate
        .evaluate(() => document.readyState === "complete" && Boolean(document.querySelector("img")))
        .catch(() => false);
    })
    .toBe(true)
    .then(() => page.frames().find((f) => f !== page.mainFrame() && (f.url().includes("page=2") || f.url().includes("page=3")))!);

  // Armed, so the drag after it is a selection rather than the browser's pan. Pressing
  // the button is also what opens the composer, so an *unarmed* frame here would mean
  // the arming message never crossed to the page that had navigated — which is the
  // cross-origin case, and is why the page reports its own page number rather than the
  // parent reading it.
  await page.locator("#comment-fab").click();
  await expect
    .poll(() => frame.evaluate(() => document.querySelector("img")!.classList.contains("armed")))
    .toBe(true);

  await frame.evaluate(() => {
    const image = document.querySelector("img")!;
    const box = image.getBoundingClientRect();
    const at = (fx: number, fy: number) => ({ x: box.left + box.width * fx, y: box.top + box.height * fy });
    const from = at(0.2, 0.2);
    const to = at(0.7, 0.6);
    const send = (type: string, point: { x: number; y: number }) =>
      image.dispatchEvent(
        new PointerEvent(type, { clientX: point.x, clientY: point.y, bubbles: true, pointerId: 1, pointerType: "mouse", button: 0 }),
      );
    send("pointerdown", from);
    send("pointermove", to);
    send("pointerup", to);
  });

  await expect(page.locator("#comment-bar")).toBeVisible();
  // The page is part of the address the reader sees, so the comment says where it is.
  await expect(page.locator("#comment-addr")).toContainText("resume.pdf");
  await expect(page.locator("#comment-addr")).toContainText("p3");

  // And the crop the preview asks for names page 3, not page 1 — the whole point of
  // reading the page from where the frame actually is.
  await expect.poll(() => crops.length).toBeGreaterThan(0);
  expect(crops[0]).toContain("page=3");
  expect(crops[0]).toContain("region=");
  expect(await page.locator("#comment-preview").getAttribute("src")).toContain("page=3");
});

test("artifacts: the comment button arms a picture, and leaves gestures alone until it does", async ({ page }) => {
  // The mobile bug this exists for: `touch-action: none` on the picture made pan and
  // pinch impossible, so a page could not be zoomed enough to read. The fix is a mode —
  // the picture belongs to the browser until the comment button is pressed.
  await stubApi(page);
  await page.route("**/api/environment", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ artifactsBaseUrl: "https://artifacts.example", pageVersion: "t" }),
    }),
  );
  await page.route("**/api/c/*/artifacts", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ key: "pi/out/shot.png", wrote: 1, edited: 0, markdown: false, image: true }]),
    }),
  );
  await page.route("**/api/c/*/comments", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAYAAACinX6EAAAAJUlEQVR42u3NMQEAAAgDoC251a3gLwSgcyfTVFVVVVVVVVVVVVX1tQFrwAPhpO4WAAAAAElFTkSuQmCC",
    "base64",
  );
  await page.route("https://artifacts.example/**", (route) => {
    const url = route.request().url();
    if (url.includes("?raw") || url.includes("region=")) {
      return route.fulfill({ status: 200, contentType: "image/png", body: png });
    }
    return route.fulfill({ status: 200, contentType: "text/html", body: imageDocumentFor("pi/out/shot.png") });
  });

  await page.goto("/7/");
  await page.locator("#artifacts-toggle").click();

  // Nothing open: nothing to comment on.
  await expect(page.locator("#comment-fab")).toBeHidden();

  await page.locator("#artifact-list li").first().click();
  await expect(page.locator("#comment-fab")).toBeVisible();

  // Not the main frame: its fragment carries the artifact key, so a substring match on
  // the key finds the drawer *page* rather than the document inside it.
  const frame = page.frames().find((f) => f !== page.mainFrame() && f.url().includes("shot.png"))!;
  const armed = async (): Promise<boolean> =>
    frame.evaluate(() => document.querySelector("img")!.classList.contains("armed"));

  // Unarmed, the picture hands touches to the browser: pan and pinch-zoom work.
  const gesture = async (): Promise<string> =>
    frame.evaluate(() => getComputedStyle(document.querySelector("img")!).touchAction);
  expect(await gesture()).not.toBe("none");
  expect(await armed()).toBe(false);

  // A drag over an unarmed picture does nothing at all — it must not open a composer,
  // and it must not draw a box.
  await frame.evaluate(() => {
    const image = document.querySelector("img")!;
    const box = image.getBoundingClientRect();
    const send = (type: string, x: number, y: number) =>
      image.dispatchEvent(
        new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, pointerId: 1, pointerType: "mouse", button: 0 }),
      );
    send("pointerdown", box.left + 8, box.top + 8);
    send("pointermove", box.left + 40, box.top + 24);
    send("pointerup", box.left + 40, box.top + 24);
  });
  await expect(page.locator("#comment-bar")).toBeHidden();

  // Pressing the button opens the composer *and* arms the picture.
  await page.locator("#comment-fab").click();
  await expect(page.locator("#comment-bar")).toBeVisible();
  // The button steps aside for the composer: one action in that corner at a time.
  await expect(page.locator("#comment-fab")).toBeHidden();
  await expect.poll(armed).toBe(true);
  expect(await gesture()).toBe("none");

  // Now a drag is a selection, and it reaches the composer.
  await frame.evaluate(() => {
    const image = document.querySelector("img")!;
    const box = image.getBoundingClientRect();
    const send = (type: string, x: number, y: number) =>
      image.dispatchEvent(
        new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, pointerId: 1, pointerType: "mouse", button: 0 }),
      );
    send("pointerdown", box.left + 4, box.top + 4);
    send("pointermove", box.left + 40, box.top + 24);
    send("pointerup", box.left + 40, box.top + 24);
  });
  await expect(page.locator("#comment-preview")).toBeVisible();
  await expect(page.locator("#comment-addr")).toContainText("shot.png");
});

test("artifacts: pressing the comment button with nothing selected comments on the file", async ({ page }) => {
  await stubApi(page);
  await page.route("**/api/environment", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ artifactsBaseUrl: "https://artifacts.example", pageVersion: "t" }),
    }),
  );
  await page.route("**/api/c/*/artifacts", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ key: "pi/notes.md", wrote: 1, edited: 0, markdown: false, image: false }]),
    }),
  );
  const posted: unknown[] = [];
  await page.route("**/api/c/*/comments", (route) => {
    if (route.request().method() === "POST") {
      posted.push(route.request().postDataJSON());
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, id: "c1", submissionId: 5 }),
      });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  await page.route("https://artifacts.example/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><html><body data-file="pi/notes.md"><pre>text</pre>
        <script>${SWIPE_SCRIPT}</script></body></html>`,
    }),
  );

  await page.goto("/7/");
  await page.locator("#artifacts-toggle").click();
  await page.locator("#artifact-list li").first().click();

  await page.locator("#comment-fab").click();
  await expect(page.locator("#comment-addr")).toContainText("the whole file");

  await page.locator("#comment-text").fill("this document is out of date");
  await page.locator("#comment-send").click();

  await expect.poll(() => posted.length).toBe(1);
  const body = posted[0] as { file: string; region?: unknown; line?: unknown; quote?: unknown };
  expect(body.file).toBe("pi/notes.md");
  // No position at all — not a region, not a line, not a quote. That is what makes it a
  // comment on the file rather than on a place in it.
  expect(body.region).toBeUndefined();
  expect(body.line).toBeUndefined();
  expect(body.quote).toBeUndefined();
});

test("artifacts: zooming a picture changes only the picture, not the drawer", async ({ page }) => {
  // The reported bug, and the reason the browser's own pinch-zoom is disabled in the
  // picture document: pinch scales the *visual viewport*, which belongs to the top-level
  // page — so pinching a picture zoomed the header and the comment button too. The zoom is
  // now a transform inside the frame, and this asserts the boundary: the picture grows,
  // the chat page's viewport does not move at all.
  await stubApi(page);
  await page.route("**/api/environment", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ artifactsBaseUrl: "https://artifacts.example", pageVersion: "t" }),
    }),
  );
  await page.route("**/api/c/*/artifacts", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ key: "pi/out/shot.png", wrote: 1, edited: 0, markdown: false, image: true }]),
    }),
  );
  await page.route("**/api/c/*/comments", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAYAAACinX6EAAAAJUlEQVR42u3NMQEAAAgDoC251a3gLwSgcyfTVFVVVVVVVVVVVVX1tQFrwAPhpO4WAAAAAElFTkSuQmCC",
    "base64",
  );
  await page.route("https://artifacts.example/**", (route) => {
    const url = route.request().url();
    if (url.includes("?raw")) return route.fulfill({ status: 200, contentType: "image/png", body: png });
    return route.fulfill({ status: 200, contentType: "text/html", body: imageDocumentFor("pi/out/shot.png") });
  });

  await page.goto("/7/");
  await page.locator("#artifacts-toggle").click();
  await page.locator("#artifact-list li").first().click();
  const frame = page.frames().find((f) => f !== page.mainFrame() && f.url().includes("shot.png"))!;
  await expect
    .poll(() => frame.evaluate(() => document.readyState === "complete" && Boolean(document.querySelector("img"))) .catch(() => false))
    .toBe(true);

  const frameBox = await page.locator("#artifact-track iframe:not([hidden])").boundingBox();
  const headerBox = await page.locator("#artifacts-title").boundingBox();
  const fabBox = await page.locator("#comment-fab").boundingBox();
  const before = await page.evaluate(() => ({
    scale: window.visualViewport ? window.visualViewport.scale : 1,
    width: window.visualViewport ? window.visualViewport.width : window.innerWidth,
  }));

  // Zoom the picture from inside the frame, the way a trackpad pinch arrives.
  await frame.evaluate(() => {
    const image = document.querySelector("img")!;
    const box = image.getBoundingClientRect();
    for (let i = 0; i < 3; i += 1) {
      image.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: -80,
          ctrlKey: true,
          clientX: box.left + box.width / 2,
          clientY: box.top + box.height / 2,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
  });

  // The picture grew...
  const scale = await frame.evaluate(() => {
    const t = getComputedStyle(document.querySelector("img")!).transform;
    return t === "none" ? 1 : Number(/matrix\(([^,]+)/.exec(t)?.[1] ?? "1");
  });
  expect(scale).toBeGreaterThan(1);

  // ...and nothing outside the frame moved.
  //
  // What this can and cannot prove, stated so the test is not read as stronger than it
  // is: a synthesised ctrl+wheel drives the *document's* handler, so this covers the zoom
  // path, the transform and the boundary between them. It cannot prove that a real
  // two-finger pinch leaves the visual viewport alone — a synthetic wheel never reaches the
  // browser's own pinch-zoom, so restoring `pinch-zoom` to the stylesheet still passes
  // here. That half is pinned by `artifacts-server.test.ts` asserting the image document's
  // CSS never cedes zoom to the browser, and confirmed by hand on a phone.
  const after = await page.evaluate(() => ({
    scale: window.visualViewport ? window.visualViewport.scale : 1,
    width: window.visualViewport ? window.visualViewport.width : window.innerWidth,
  }));
  expect(after).toEqual(before);

  // The chrome is in the same place, and still there: the drawer's title and the comment
  // button are the two things a reader taps that the visual-viewport zoom would have moved.
  expect(await page.locator("#artifacts-title").boundingBox()).toEqual(headerBox);
  expect(await page.locator("#comment-fab").boundingBox()).toEqual(fabBox);
  expect(await page.locator("#artifact-track iframe:not([hidden])").boundingBox()).toEqual(frameBox);
});
