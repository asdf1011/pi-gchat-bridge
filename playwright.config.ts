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
    // The built entrypoint, not tsx: what ships is what is tested.
    command: "node dist/durable/main.js",
    url: "http://127.0.0.1:8099/healthz",
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      // A throwaway store so the real bridge.sqlite is never touched, and a
      // distinct port so a running bridge does not collide.
      BRIDGE_DB: "/tmp/pi-e2e-bridge.sqlite",
      PORT: "8099",
      BRIDGE_BIND: "127.0.0.1",
      // No Pub/Sub: the receiver requires a subscription and would exit.
      RECEIVER: "none",
      PUBSUB_SUBSCRIPTION: "",
      PI_CWD: "/tmp",
      LOG_LEVEL: "error",
      // The artifact listener is off by default in the page tests: a live bridge
      // already owns 8082 on this machine, and these tests never touch artifacts.
      BRIDGE_ARTIFACTS_PORT: "0",
    },
  },
});
