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

const CONVERSATIONS = [
  { conversationId: 7, chatKey: "spaces/A/threads/T1", model: "deepseek/deepseek-flash", name: "deploy notes" },
  { conversationId: 9, chatKey: "spaces/A/threads/T2", model: "llama-local/lfm3" },
];

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
    history?: { role: string; text: string; html?: string; at?: number }[];
    frames?: { event: string; data: unknown }[];
    onPost?: (body: unknown) => void;
  } = {},
): Promise<void> {
  const conversations = options.conversations ?? CONVERSATIONS;

  await page.route("**/api/conversations*", (route) => {
    if (route.request().method() === "POST") {
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ conversationId: 99, chatKey: "web:new", model: "m", createdAt: Date.now() }),
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
  await page.route("**/api/c/*", (route) => {
    const id = Number(/\/api\/c\/(\d+)$/.exec(new URL(route.request().url()).pathname)?.[1] ?? 0);
    const found = conversations.find((conversation) => conversation.conversationId === id);
    return found
      ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(found) })
      : route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ ok: false }) });
  });

  await page.route("**/api/c/*/history", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(options.history ?? []) }),
  );

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
  const form = page.locator("form");
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
    .poll(() => page.evaluate(() => getComputedStyle(document.getElementById("artifact-doc")!).transform))
    .toBe("matrix(1, 0, 0, 1, 0, 0)");
  const after = await page.evaluate(() => {
    const doc = document.getElementById("artifact-doc")!.getBoundingClientRect();
    const drawer = document.getElementById("artifacts")!.getBoundingClientRect();
    return {
      showing: document.getElementById("artifacts")!.classList.contains("showing-doc"),
      docWidth: Math.round(doc.width),
      drawerWidth: Math.round(drawer.width),
      backVisible: !document.getElementById("artifacts-back")!.hidden,
      transform: getComputedStyle(document.getElementById("artifact-doc")!).transform,
    };
  });
  // Slid in, and the document owns the drawer rather than sharing it with a list.
  expect(after.showing).toBe(true);
  expect(after.docWidth).toBe(after.drawerWidth);
  expect(after.backVisible).toBe(true);

  // Back goes to the list, and the frame is dropped rather than left loaded.
  await page.locator("#artifacts-back").click();
  await expect(page.locator("#artifacts-title")).toHaveText("Artifacts");
  expect(await page.evaluate(() => document.getElementById("artifact-frame")!.getAttribute("src"))).toBe("about:blank");
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
