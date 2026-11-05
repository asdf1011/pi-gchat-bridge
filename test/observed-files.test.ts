/**
 * The filesystem half of the artifact ledger.
 *
 * These run against a real temporary tree: the whole point of the walk is that
 * it reports what actually changed, which a fake filesystem would not prove.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { mergeArtifacts } from "../src/durable/artifacts.js";
import { filesChangedSince, mergeObserved } from "../src/durable/observed-files.js";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "observed-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

/** A file written now, with an mtime we control, in a fresh directory. */
function write(dir: string, name: string, mtimeMs: number, body = "x"): string {
  const full = path.join(scratch, dir, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  fs.utimesSync(full, mtimeMs / 1000, mtimeMs / 1000);
  return full;
}

test("files changed since the turn started are found, older ones are not", async () => {
  const now = Date.now();
  const old = write("basic/old.txt", "", now - 60_000);
  const fresh = write("basic/new.txt", "", now);

  const found = await filesChangedSince([path.join(scratch, "basic")], now - 1000);
  const paths = found.map((file) => file.path);
  assert.deepEqual(paths, [fresh]);
  assert.ok(!paths.includes(old));
  assert.ok(found[0]!.at >= now - 1000);
});

test("dependency trees and version-control internals are not walked", async () => {
  const now = Date.now();
  write("skips/node_modules/pkg/index.js", "", now);
  write("skips/.git/HEAD", "", now);
  write("skips/.jj/repo", "", now);
  const real = write("skips/src/app.ts", "", now);

  const found = await filesChangedSince([path.join(scratch, "skips")], now - 1000);
  assert.deepEqual(
    found.map((file) => file.path),
    [real],
  );
});

test("the bridge's own files are not artifacts of every conversation", async () => {
  const now = Date.now();
  const root = path.join(scratch, "own");
  write("own/bridge.sqlite", "", now);
  write("own/bridge.sqlite-wal", "", now);
  write("own/bridge-durable.log", "", now);
  write("own/bridge-restart.log", "", now);
  write("own/.start-bridge.pid", "", now);
  const wanted = write("own/notes.md", "", now);

  const found = await filesChangedSince([root], now - 1000);
  assert.deepEqual(
    found.map((file) => file.path),
    [wanted],
  );
});

test("a symlinked directory is not followed, so nothing is reported twice", async () => {
  const now = Date.now();
  const real = write("links/real/file.ts", "", now);
  fs.symlinkSync(path.join(scratch, "links/real"), path.join(scratch, "links/alias"));

  const found = await filesChangedSince([path.join(scratch, "links")], now - 1000);
  assert.deepEqual(
    found.map((file) => file.path),
    [real],
  );
});

test("one runaway turn cannot fill the list", async () => {
  const now = Date.now();
  for (let i = 0; i < 12; i += 1) write("many", `f${i}.txt`, now);
  const found = await filesChangedSince([path.join(scratch, "many")], now - 1000, { max: 5 });
  assert.equal(found.length, 5);
});

test("mergeObserved deduplicates on path, keeps the newest time, and caps", () => {
  const merged = mergeObserved(
    [{ path: "/a", at: 10 }, { path: "/b", at: 40 }],
    [{ path: "/a", at: 30 }, { path: "/c", at: 20 }],
    2,
  );
  assert.deepEqual(merged, [
    { path: "/b", at: 40 },
    { path: "/a", at: 30 },
  ]);
});

test("mergeArtifacts keeps tool-call counts and adds the files only the walk saw", () => {
  const roots = [scratch];
  const keyed = path.join(scratch, "src/app.ts");
  const walked = path.join(scratch, "docs/readme.md");
  const outside = path.join(os.tmpdir(), "elsewhere.txt");

  const merged = mergeArtifacts(
    [
      {
        key: "src/app.ts",
        root: scratch,
        path: keyed,
        wrote: 2,
        edited: 3,
        entryId: 7,
      },
    ],
    [
      { path: keyed, at: 100 }, // already known by name: counts stay
      { path: walked, at: 90 },
      { path: outside, at: 80 }, // outside the roots: cannot be served
    ],
    roots,
  );

  assert.deepEqual(
    merged.map((file) => ({ key: file.key, wrote: file.wrote, edited: file.edited })),
    [
      { key: "docs/readme.md", wrote: 0, edited: 0 },
      { key: "src/app.ts", wrote: 2, edited: 3 },
    ],
  );
});
