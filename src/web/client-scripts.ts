/**
 * The client-side scripts the artifact origin serves, as text.
 *
 * They used to be template literals inside `artifacts-server.ts`, and that cost real bugs:
 * a backtick in a comment, or `\d` in a regex, is mangled by the enclosing literal, and the
 * failure is a script that is subtly wrong rather than a compile error. Three separate
 * defects in this session were exactly that, and each took a browser to find.
 *
 * As `.js` files they are checked by the same tooling as any other script, edited without
 * escaping anything, and read once at startup the way `page.html` and `artifacts.js` already
 * are (see `sink.ts`). There is no build step: this deployment serves `dist/` for JavaScript
 * and `src/web/` for assets, so the files are read from the source tree at load.
 *
 * **Composition is by include, not by string interpolation.** A script that needs another
 * writes `/* @@include:name.js@@ *\/` where it would otherwise be copied, and the reader
 * splices it in. That is the same mechanism the page already uses for `artifacts.js`, for the
 * same reason: one copy of the shared part, edited in one place, with no second file to drift.
 */
import fs from "node:fs";

/**
 * Where a script may live, in order.
 *
 * The same two-candidate rule `sink.ts` uses for the page: `tsc` emits JavaScript only, so a
 * `.js` asset is *not* copied into `dist/` and a built bridge must find it in the source tree.
 * Trying the compiled location first keeps a build that does copy them working too.
 */
function candidates(name: string): URL[] {
  return [
    new URL(`./client/${name}`, import.meta.url),
    new URL(`../../src/web/client/${name}`, import.meta.url),
  ];
}

/**
 * One script, with its includes resolved.
 *
 * `stack` is the include chain, so a cycle is an error at startup rather than four copies of a
 * script nested inside each other in a document that then behaves strangely.
 */
function load(name: string, stack: readonly string[] = []): string {
  if (stack.includes(name)) {
    throw new Error(`client script include cycle: ${[...stack, name].join(" → ")}`);
  }
  const source = read(name);
  // Every include must resolve. A missing one would otherwise leave an inert comment in the
  // middle of a script — a document that loads and then does nothing, which is the failure
  // that costs an hour to find.
  return source.replace(/\/\* @@include:([\w.-]+)@@ \*\//g, (_match, included: string) =>
    load(included, [...stack, name]),
  );
}

/** Resolve one client script, from the build or from the source tree. */
function read(name: string): string {
  const failures: string[] = [];
  for (const candidate of candidates(name)) {
    try {
      return fs.readFileSync(candidate, "utf8");
    } catch (error) {
      failures.push(`${candidate.pathname}: ${(error as Error).message}`);
    }
  }
  throw new Error(`client script ${name} not found — tried ${failures.join(", ")}`);
}

/**
 * The scripts, read once.
 *
 * Read at module load rather than per request, matching `WEB_PAGE`: a script cannot change
 * under a running bridge because a file on disk changed, and the cost is four small reads at
 * startup.
 *
 * `comment.js` and `render.js` each include `key-handler.js` and `swipe.js`, so the copies
 * they are spliced into are self-contained — a document carries one script block, not four.
 */
export const SWIPE_SCRIPT = load("swipe.js");
export const REGION_SCRIPT = load("region.js");
export const COMMENT_SCRIPT = load("comment.js");
export const RENDER_SCRIPT = load("render.js");
