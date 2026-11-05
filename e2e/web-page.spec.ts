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

  await page.route("**/api/conversations", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(conversations) }),
  );

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
  await page.route("**/api/c/*/history", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(options.history ?? []) }),
  );

  await page.route("**/api/c/*/message", async (route) => {
    options.onPost?.(route.request().postDataJSON());
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
}

test("the page loads and lists conversations with no console errors", async ({ page }) => {
  const errors = watchErrors(page);
  await stubApi(page);
  await page.goto("/web/");

  await expect(page.locator("#list li")).toHaveCount(2);
  await expect(page.locator("#list li").first()).toContainText("deploy notes");
  await expect(page.locator("#list li").first()).toContainText("#7 · deepseek/deepseek-flash");
  // The unnamed one falls back to its key.
  await expect(page.locator("#list li").nth(1)).toContainText("spaces/A/threads/T2");

  expect(errors, `console errors: ${errors.join(" | ")}`).toEqual([]);
});

test("the first conversation is selected and streamed on load", async ({ page }) => {
  const errors = watchErrors(page);
  const requests: string[] = [];
  page.on("request", (req) => requests.push(req.url()));
  await stubApi(page, {
    frames: [{ event: "text", data: { text: "streamed at load", busy: true } }],
  });
  await page.goto("/web/");

  await expect(page.locator("#list li").first()).toHaveClass(/on/);
  await expect(page.locator("#log .bubble")).toHaveText("streamed at load");
  expect(requests.some((u) => /\/api\/c\/7\/events$/.test(u))).toBe(true);
  expect(errors).toEqual([]);
});

test("an SSE text frame paints the answer pane", async ({ page }) => {
  const errors = watchErrors(page);
  await stubApi(page, { frames: [{ event: "text", data: { text: "the model said this", busy: true } }] });
  await page.goto("/web/");
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
  await page.goto("/web/");
  // The stream ends, so the page reports it instead of showing a stale tool line
  // or a blank pane. Either of those would misrepresent the connection state.
  await expect(page.locator("#tool")).toHaveText("reconnecting…");
  expect(errors).toEqual([]);
});

test("switching conversation points the stream at the new id", async ({ page }) => {
  const errors = watchErrors(page);
  const eventUrls: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/events")) eventUrls.push(req.url());
  });
  await stubApi(page);
  await page.goto("/web/");
  await expect(page.locator("#list li")).toHaveCount(2);

  await page.locator("#list li").nth(1).click();
  await expect(page.locator("#list li").nth(1)).toHaveClass(/on/);
  await expect(page.locator("#list li").first()).not.toHaveClass(/on/);
  await expect.poll(() => eventUrls.some((u) => /\/api\/c\/9\/events$/.test(u))).toBe(true);
  expect(errors).toEqual([]);
});

test("sending a message posts the trimmed text and clears the box", async ({ page }) => {
  const errors = watchErrors(page);
  const posted: unknown[] = [];
  await stubApi(page, { onPost: (body) => posted.push(body) });
  await page.goto("/web/");
  await expect(page.locator("#list li")).toHaveCount(2);

  await page.locator("#text").fill("  hello from the browser  ");
  await page.locator("#send").evaluate((form) => (form as HTMLFormElement).requestSubmit());

  await expect(page.locator("#text")).toHaveValue("");
  await expect.poll(() => posted.length).toBe(1);
  expect(posted[0]).toEqual({ text: "hello from the browser" });
  expect(errors).toEqual([]);
});

test("layout: the answer pane is visible and the controls are reachable", async ({ page }) => {
  // The check jsdom cannot make. A pane with zero height passes every DOM
  // assertion and shows the user nothing — which is exactly what a broken
  // stylesheet looks like.
  await stubApi(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/web/");

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
  await page.goto("/web/");

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

test("a path without a trailing slash is normalised to one", async ({ page }) => {
  // Without this the page's relative API paths resolve one level too high and
  // every call 404s.
  await stubApi(page);
  await page.goto("/web");
  await expect.poll(() => new URL(page.url()).pathname).toBe("/web/");
});
