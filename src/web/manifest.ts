/**
 * The page as an installable app.
 *
 * There is no service worker here, and that is a decision rather than an omission.
 * An installed pane is the *same conversation* as the Chat thread, so it is worth
 * nothing offline: no history to page, no message to submit, no model to answer.
 * A worker would therefore exist only to serve a shell that cannot do anything,
 * while adding the one part of this front end that can go stale behind a version
 * check the page already has (`api/environment` → `pageVersion`). What makes it an
 * app is the manifest plus the iOS meta tags; a brief offline window is covered by
 * the HTTP cache instead (see `web-host.ts`), which has no update protocol to get
 * wrong.
 *
 * The manifest is generated per request instead of being a file, for the same
 * reason every URL in the page is relative: the page may be mounted at `/web/`,
 * at `/pi/web/` behind a proxy that keeps its prefix, or at `/` when the proxy
 * strips it. A static `manifest.json` can only name one of those roots, so its
 * `start_url` and `scope` would be wrong on the other two deployments — and a
 * wrong `start_url` means the installed icon opens the wrong place.
 */
import { createHash } from "node:crypto";

/** Everything a manifest has to be able to say about this deployment. */
export interface ManifestInput {
  /** The mount root the page was served from: "/", "/pi/", and so on. Ends in "/". */
  root: string;
  /** The icon, same-origin and mount-relative. */
  icon: string;
}

/**
 * The mount root, recovered from the request path.
 *
 * The same three shapes `mountRoot()` in the page accepts, because the server and
 * the client must agree on where the app lives: a conversation page (`/<id>/`), the
 * mount itself (`/web/`, `/pi/web/`), and the bare root a prefix-stripping proxy
 * forwards. Returns "" when the path is not one of them, which the caller treats as
 * "no manifest" rather than guessing a root and installing the app somewhere wrong.
 */
export function mountRootOf(pathname: string): string | undefined {
  if (pathname.endsWith("/manifest.webmanifest")) {
    const root = pathname.slice(0, -"manifest.webmanifest".length);
    return root === "" ? "/" : root;
  }
  const conversation = /^(.*?)\d+\/?$/.exec(pathname);
  if (conversation) return conversation[1];
  if (/\/web\/?$/.test(pathname)) return pathname.replace(/\/?$/, "/");
  if (pathname === "/" || pathname === "") return "/";
  return undefined;
}

/**
 * The manifest for one mount.
 *
 * `display: standalone` rather than `minimal-ui`: this is a pane with its own
 * back button in the header, so browser chrome on top of it is a second set of
 * controls saying less. `start_url` is the mount root — the conversation index —
 * because installing is "put the app on my home screen", and which conversation
 * you were reading when you did so is not the app.
 *
 * `id` is pinned to the root explicitly. Without it the identity is `start_url`,
 * which is what it is anyway, but naming it means a later change to `start_url`
 * cannot silently install a second copy of the same app.
 */
export function webManifest(input: ManifestInput): string {
  const root = input.root.endsWith("/") ? input.root : `${input.root}/`;
  return JSON.stringify(
    {
      id: root,
      name: "pi bridge",
      // Under a home-screen icon this is all that fits; it should be the product,
      // not the deployment's hostname.
      short_name: "pi",
      description: "Talk to the pi coding agent — the same conversations as Chat.",
      start_url: root,
      // Conversation pages are nested documents under the same mount, and the
      // artifact drawer lives on them. A narrow scope would make an installed app
      // open conversation links in a browser tab instead.
      scope: root,
      display: "standalone",
      orientation: "any",
      // Matches `<meta name="theme-color">` and the icon's crust, so the status bar,
      // the splash and the icon agree instead of showing three different reds.
      theme_color: "#a51f34",
      background_color: "#a51f34",
      lang: "en",
      icons: [
        // SVG first: one file, sharp at every size, and the same bytes as the
        // favicon so there is nothing to keep in step. The sizes are declared
        // because Chrome will not offer to install without one, and `any` on an
        // SVG means "ask the browser to scale it".
        { src: input.icon, sizes: "any", type: "image/svg+xml", purpose: "any" },
      ],
    },
    null,
    2,
  );
}

/**
 * A short fingerprint of the manifest as served.
 *
 * Not part of `pageVersion`: the page and the manifest change together only
 * sometimes, and a manifest nobody has installed should not force open panes to
 * reload. Kept here because a cache validator has to come from the bytes actually
 * sent, exactly as the page's does.
 */
export function manifestVersion(body: string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 12);
}
