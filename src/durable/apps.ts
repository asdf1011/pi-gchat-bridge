/**
 * Apps: a directory of files in a conversation that is served as a web page.
 *
 * The rule is deliberately the whole of it: **a directory containing `app.json` is an
 * app**, and this module knows nothing else about it. What the app is for, what it
 * loads, whether it has a backend — none of that is the bridge's business. This is the
 * same shape as the artifact kind rules in `artifacts.ts`: an extension (or here, a
 * marker file) decides what a thing *is*, and a decision beats a guess.
 *
 * Why a marker file rather than "any directory": serving a directory as runnable code
 * is a different promise from serving a file as text. An artifact directory is mostly
 * notes, scripts and generated output, and none of that should become a page because it
 * happens to sit next to an `index.html`. `app.json` is the author saying "run this".
 *
 * The app lives in the conversation that produced it — the same repository the artifacts
 * come from — so there is no separate registry to keep in step, no id to allocate, and
 * deleting the directory un-publishes the app. That is why the URL is
 * `/apps/<conversation>/<directory>/`: the address is where the code already is.
 *
 * ## What an app is trusted with
 *
 * Serving an app means serving it with scripts enabled, which the artifact origin
 * otherwise never does. An app therefore runs with the authority of the artifact origin:
 * it can read every artifact of every conversation on that hostname, because they are
 * same-origin. That is acceptable only because apps are self-authored (the marker file
 * has to be written deliberately) and the hostname is behind Access, and it is stated
 * here rather than buried: **do not publish an app you did not write.** A separate
 * hostname per app is the fix if that ever stops being true, and the docs note the
 * certificate cost of wildcard subdomains.
 */
import fs from "node:fs";
import path from "node:path";

/** The marker file whose presence makes a directory an app. */
export const APP_MANIFEST = "app.json";

/** What `app.json` may say. Everything is optional: the marker is the point. */
export interface AppManifest {
  /** Shown in the index. Falls back to the directory name. */
  name?: string;
  /** One line, shown in the index. */
  description?: string;
  /**
   * Whether a report posted by this app should start a conversation turn by itself.
   *
   * Off unless it says otherwise, and off is the correct default: a page that runs on load,
   * reports, and is answered would otherwise loop on its own, spending turns nobody asked
   * for. Turning it on is a statement that this app is a development loop rather than
   * something a person uses.
   */
  /**
   * Whether this app can read text aloud, for the chat page's talking mode.
   *
   * A capability the app advertises, not something the bridge knows: the web UI carries no model
   * or vendor, and asks for "the app that speaks" rather than for any particular one. The app
   * implements the `{speak, stop}` / `{started, word, end}` postMessage protocol.
   */
  speech?: boolean;
  /** Whether a report posted by this app should start a conversation turn by itself. */
  reports?: {
    /** Start a turn when a report arrives. Default false. */
    autoSubmit?: boolean;
  };
}

/** One app, as the index needs it. */
export interface AppEntry {
  /** The directory name, which is also the URL segment. */
  id: string;
  name: string;
  description: string;
}

/**
 * Whether a request path names a file the app may serve.
 *
 * Rejects anything that could leave the app's own directory. Two checks, because this is
 * the one function standing between a URL and the filesystem: the segments are inspected
 * before they are joined, and the joined result is compared against the directory after
 * `realpath`, which is what catches a symlink pointing outward.
 *
 * `undefined` for a path that is refused; the caller answers 404 rather than explaining,
 * because "that file exists but is not yours" is a fact an attacker would like to have.
 */
export function appRelativePath(raw: string): string | undefined {
  // A leading slash or an absolute path is not relative, and `..` in any position is an
  // attempt to leave. Backslashes are separators on Windows and ordinary characters
  // here, so a name containing one is simply refused rather than quietly normalised.
  if (raw.startsWith("/") || raw.includes("\\") || raw.includes("\0")) return undefined;
  const parts = raw.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.some((part) => part === "..")) return undefined;
  if (parts.length === 0) return undefined;
  // `.jj` is the repository the artifacts are committed to; serving it would leak the
  // history of everything in the conversation, not just the app.
  if (parts.some((part) => part === ".jj" || part === ".git")) return undefined;
  return parts.join("/");
}

/**
 * The absolute path of a file inside an app directory, or `undefined`.
 *
 * `realpath` on both sides is what makes this robust against symlinks: a link inside the
 * app that points at `/etc/passwd` resolves outside the directory and is refused, where a
 * plain `path.join` comparison would have allowed it.
 */
export function resolveAppFile(appDir: string, relative: string): string | undefined {
  const safe = appRelativePath(relative);
  if (safe === undefined) return undefined;
  const candidate = path.resolve(appDir, safe);
  let realFile: string;
  let realDir: string;
  try {
    realFile = fs.realpathSync(candidate);
    realDir = fs.realpathSync(appDir);
  } catch {
    return undefined;
  }
  if (realFile !== realDir && !realFile.startsWith(realDir + path.sep)) return undefined;
  return realFile;
}

/** The directory of one app inside a conversation, if it really is an app. */
export function appDirOf(conversationDir: string, appName: string): string | undefined {
  const safe = appRelativePath(appName);
  // One segment only: an app is a directory of a conversation, not a nested path.
  if (safe === undefined || safe.includes("/")) return undefined;
  const dir = path.join(conversationDir, safe);
  try {
    if (!fs.statSync(dir).isDirectory()) return undefined;
    if (!fs.statSync(path.join(dir, APP_MANIFEST)).isFile()) return undefined;
  } catch {
    return undefined;
  }
  return dir;
}

/** Read an app's manifest, tolerating a file that is absent, empty or not JSON. */
function readManifest(appDir: string, id: string): AppEntry {
  let manifest: AppManifest = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(appDir, APP_MANIFEST), "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      manifest = parsed as AppManifest;
    }
  } catch {
    // A manifest that does not parse is still a marker: the directory is an app, it just
    // has nothing to say about itself. Refusing it would make a typo into an outage.
  }
  return {
    id,
    name: typeof manifest.name === "string" && manifest.name !== "" ? manifest.name : id,
    description: typeof manifest.description === "string" ? manifest.description : "",
  };
}

/**
 * Every app in a conversation, sorted by id so the index does not reshuffle between loads.
 *
 * Unreadable entries are skipped rather than thrown: one app with a permissions problem
 * must not take the index down with it.
 */
export function appsIn(conversationDir: string): AppEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(conversationDir);
  } catch {
    return [];
  }
  const apps: AppEntry[] = [];
  for (const name of names.sort()) {
    const dir = appDirOf(conversationDir, name);
    if (dir !== undefined) apps.push(readManifest(dir, name));
  }
  return apps;
}

/**
 * Read an app's `app.json`, or an empty manifest if it is absent or unreadable.
 *
 * Separate from `appsIn` because the *policy* questions ("may this app start a turn") are
 * asked on a path where the answer must never be "guess".
 */
export function appManifest(appDir: string): AppManifest {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(appDir, APP_MANIFEST), "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as AppManifest;
    }
  } catch {
    // A manifest that does not parse simply has nothing to say.
  }
  return {};
}

/**
 * The content type for a file an app serves.
 *
 * A table rather than `mime-types`, for the reason `artifacts.ts` gives about images: the
 * answer decides what a browser *does* with the bytes. Three of these are load-bearing and
 * are the reason this is not `application/octet-stream` for everything:
 *
 *   `.js`   — a module script is refused unless it is a JavaScript MIME type.
 *   `.wasm` — `WebAssembly.instantiateStreaming` is refused unless it is `application/wasm`;
 *             the fallback is a slow non-streaming compile.
 *   `.json` — apps read their own config with `fetch().json()`.
 *
 * Everything else falls back to `application/octet-stream`, which downloads rather than
 * renders — the safe default for a model file, and the reason a `.gguf` needs no entry.
 */
const APP_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".woff2": "font/woff2",
  ".data": "application/octet-stream",
  ".bin": "application/octet-stream",
};

/** The content type to serve one app file as. */
export function appFileType(file: string): string {
  return APP_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}
