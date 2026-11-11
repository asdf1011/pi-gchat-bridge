/**
 * The page as an installable app.
 *
 * Two things are worth pinning, and they are the two ways this can be wrong
 * without anybody noticing:
 *
 *   1. **The manifest's roots match the mount.** The page works at `/web/`, at
 *      `/pi/web/` behind a prefix-keeping proxy, and at `/` when the proxy strips
 *      the prefix. A manifest with the wrong `start_url` installs an icon that opens
 *      the wrong place, and nothing in a browser test would fail — the page itself
 *      is fine.
 *   2. **The scopes are narrow.** `scope: "/"` on a deployment mounted at
 *      `/pi/web/` would claim the whole origin for the installed app, which is a
 *      security-shaped mistake (it captures navigation the app has no business
 *      capturing) and an ordinary one (it breaks every other thing on the host).
 *
 * The shape checks are deliberately about the *promise* the file makes — icons that
 * exist, colours that match the page — rather than about its bytes, so restyling the
 * app does not fail a test that was never about styling.
 */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { handleWebRequest } from "../src/adapter/web-routes.js";
import { WEB_ICON, WEB_PAGE } from "../src/adapter/web.js";
import { mountRootOf } from "../src/adapter/web/manifest.js";
import type { SessionHost } from "../src/session-host/api.js";

/** No conversation is needed: the manifest is answered before anything asks the seam. */
const seam = {} as SessionHost;

interface Served {
  base: string;
  close(): Promise<void>;
}

/** A real socket, so the path is what a browser would send. */
async function serve(): Promise<Served> {
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const handled = await handleWebRequest(req, res, url, {
        seam,
        model: { provider: "p", modelId: "m" },
        who: {},
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

interface Manifest {
  id: string;
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  theme_color: string;
  icons: { src: string; sizes: string; type: string; purpose?: string }[];
}

async function manifestAt(base: string, path: string): Promise<Manifest> {
  const response = await fetch(`${base}${path}`);
  assert.equal(response.status, 200, path);
  return (await response.json()) as Manifest;
}

test("the manifest is served wherever the page is mounted, with that mount's roots", async () => {
  const served = await serve();
  try {
    // One case per deployment shape: the mount itself, behind a prefix that is
    // kept, and a bare root. Each must scope the app to where it actually lives.
    const cases: [string, string][] = [
      ["/web/manifest.webmanifest", "/web/"],
      ["/pi/web/manifest.webmanifest", "/pi/web/"],
      ["/manifest.webmanifest", "/"],
    ];
    for (const [path, root] of cases) {
      const manifest = await manifestAt(served.base, path);
      assert.equal(manifest.start_url, root, path);
      assert.equal(manifest.scope, root, path);
      // Same root as the id, so a later change to start_url is not a second app.
      assert.equal(manifest.id, root, path);
      // The icon is on the same mount, which is why it is built from the root
      // rather than written down.
      assert.deepEqual(
        manifest.icons.map((icon) => icon.src),
        [`${root}favicon.svg`],
        path,
      );
    }
  } finally {
    await served.close();
  }
});

test("a scope wider than the mount is never claimed", async () => {
  const served = await serve();
  try {
    const manifest = await manifestAt(served.base, "/pi/web/manifest.webmanifest");
    // The narrow claim is the whole point: "standalone" for the app, and the rest
    // of the origin left alone.
    assert.notEqual(manifest.scope, "/");
    assert.ok(manifest.scope.startsWith("/pi/web"), manifest.scope);
  } finally {
    await served.close();
  }
});

test("the manifest is a complete install, not a hint", async () => {
  const served = await serve();
  try {
    const response = await fetch(`${served.base}/web/manifest.webmanifest`);
    // The type a manifest must be served with; browsers refuse `application/json`.
    assert.match(response.headers.get("content-type") ?? "", /application\/manifest\+json/);
    // Revalidated rather than reused: the bytes differ per mount, so a shared
    // cache keyed on path alone would hand one deployment's roots to another.
    assert.match(response.headers.get("cache-control") ?? "", /no-cache/);
    assert.match(response.headers.get("etag") ?? "", /^"[0-9a-f]{12}"$/);

    const manifest = (await response.json()) as Manifest;
    // What browsers require before offering to install: a name, a display mode
    // other than the default, a start URL in scope, and an icon that will parse.
    assert.ok(manifest.name.length > 0);
    assert.ok(manifest.short_name.length > 0);
    assert.equal(manifest.display, "standalone");
    assert.equal(manifest.icons.length, 1);
    assert.equal(manifest.icons[0]!.type, "image/svg+xml");
    assert.doesNotMatch(manifest.icons[0]!.src, /^https?:|^\/\//);

    // The icon it names is the one this server actually serves, byte for byte, so
    // the app cannot point at a picture that 404s or has drifted.
    const icon = await fetch(`${served.base}${manifest.icons[0]!.src.replace(/^\/$/, "/")}`);
    assert.equal(icon.status, 200, manifest.icons[0]!.src);
    assert.equal(await icon.text(), WEB_ICON);
  } finally {
    await served.close();
  }
});

test("the manifest's colours are the page's colours", async () => {
  const served = await serve();
  try {
    const manifest = await manifestAt(served.base, "/web/manifest.webmanifest");
    // Three places draw this colour — the manifest's theme, the page's theme-color
    // meta, and the icon's crust — and a mismatch shows as a splashed, framed app
    // that does not look like the icon that was tapped.
    assert.match(WEB_PAGE, new RegExp(`<meta name="theme-color" content="${manifest.theme_color}">`));
    assert.match(WEB_ICON.toLowerCase(), new RegExp(manifest.theme_color.toLowerCase()));
  } finally {
    await served.close();
  }
});

test("the page names the manifest relatively, after the base", async () => {
  const served = await serve();
  try {
    const page = await (await fetch(`${served.base}/web/`)).text();
    // Relative for the same reason the icon is: a leading slash would point at the
    // proxy's root and install an app for a document that is not this one.
    assert.match(page, /<link rel="manifest" href="manifest\.webmanifest">/);
    assert.doesNotMatch(page, /rel="manifest" href="\//);
    // After <base>, because a base href only rebinds the links that follow it.
    assert.ok(page.indexOf('<base href="">') < page.indexOf('rel="manifest"'));
  } finally {
    await served.close();
  }
});

test("the page carries what iOS needs, because the manifest is not enough there", async () => {
  const served = await serve();
  try {
    const page = await (await fetch(`${served.base}/web/`)).text();
    // Safari installs from the share sheet and ignores the manifest for display
    // mode, so a home-screen icon is a bookmark unless these say otherwise.
    assert.match(page, /<meta name="apple-mobile-web-app-capable" content="yes">/);
    assert.match(page, /<meta name="apple-mobile-web-app-title" content="pi">/);
    // The icon iOS rasterises. It is the same SVG as the tab icon, which iOS does
    // accept for apple-touch-icon; declaring nothing would get a screenshot of the
    // page instead.
    assert.match(page, /<link rel="apple-touch-icon" href="favicon\.svg">/);
  } finally {
    await served.close();
  }
});

test("an installed app still gets the page's CSP and its no-store", async () => {
  const served = await serve();
  try {
    // The landing document of a standalone window is the same document, so the
    // barriers around it must not have been traded away for installability.
    for (const path of ["/web/", "/7/"]) {
      const response = await fetch(`${served.base}${path}`);
      assert.match(response.headers.get("cache-control") ?? "", /no-store/, path);
      assert.match(response.headers.get("content-security-policy") ?? "", /img-src 'self' data:/, path);
    }
  } finally {
    await served.close();
  }
});

test("there is no service worker to go stale", async () => {
  // Stated as a test because the opposite is the obvious next feature, and it is
  // the wrong one: an installed pane has no offline story worth caching (no
  // history, no submit, no model), and a worker would add an update protocol on
  // top of the `pageVersion` reload the page already does.
  const served = await serve();
  try {
    for (const path of ["/sw.js", "/web/sw.js", "/service-worker.js"]) {
      const response = await fetch(`${served.base}${path}`);
      assert.equal(response.status, 404, path);
    }
    assert.doesNotMatch(WEB_PAGE, /serviceWorker\s*\.\s*register/);
  } finally {
    await served.close();
  }
});

test("the mount root agrees with the page's own idea of it", () => {
  // The server and the page must resolve the same deployment to the same root, or
  // the manifest would scope the app somewhere the page never resolves URLs to.
  assert.equal(mountRootOf("/web/"), "/web/");
  assert.equal(mountRootOf("/web"), "/web/");
  assert.equal(mountRootOf("/pi/web/"), "/pi/web/");
  assert.equal(mountRootOf("/7/"), "/");
  assert.equal(mountRootOf("/pi/web/7/"), "/pi/web/");
  assert.equal(mountRootOf("/manifest.webmanifest"), "/");
  assert.equal(mountRootOf("/pi/web/manifest.webmanifest"), "/pi/web/");  // A path that is not a page is not a mount either: nothing serves the app there,
  // so there is no root to install it at.
  assert.equal(mountRootOf("/nonsense"), undefined);
});
