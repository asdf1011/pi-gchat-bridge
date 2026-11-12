import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests for the web page — the layer jsdom cannot reach.
 *
 * What this covers that `test/web-page-dom.test.ts` does not:
 *
 *   - the **real** `EventSource`, including its reconnect behaviour, rather than
 *     a stub that models what we assume it does;
 *   - actual layout and CSS: that the pane is visible, scrolls, and is not
 *     collapsed to zero height;
 *   - anything the browser does differently from jsdom, which is a large and
 *     growing set.
 *
 * No bridge is needed. The page talks to exactly three endpoints, and
 * `page.route()` answers them from fixtures in the spec — so this runs without a
 * database, a Pub/Sub subscription, or the single-process store lock.
 *
 * `webServer` serves the page from the built bridge, because the HTML is a
 * template string inside `src/adapter/web.ts` and the point is to test what
 * ships. It runs with no Pub/Sub subscription and an in-memory-looking temp DB;
 * the routes intercept every API call anyway, so the server only has to serve
 * `/web`.
 */
export default defineConfig({
  testDir: "./e2e",
  // The page is a handful of endpoints and one interval; nothing here is slow.
  timeout: 30_000,
  expect: { timeout: 5_000 },
  // Serial: every spec writes to the same temp DB path.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:8099",
    // A failure that only reproduces with a trace is worse than useless.
    trace: "retain-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // The page itself, not the bridge: the spec stubs every `/api` call, and a
    // conversation is not needed to know whether a popup is on screen. See
    // `scripts/e2e-page-server.mjs` for why the durable entrypoint is the wrong
    // process to start for this.
    command: "node scripts/e2e-page-server.mjs",
    url: "http://127.0.0.1:8099/web/",
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      E2E_PAGE_PORT: "8099",
      // A built page, like production. `dist/web/routes.js` serves the captured
      // copy unless BRIDGE_WEB_DEV is set, and the point is to test what ships.
      BRIDGE_WEB_DEV: "0",
      LOG_LEVEL: "error",
    },
  },
});
