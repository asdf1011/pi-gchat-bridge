#!/usr/bin/env node
/**
 * Run only the test files a change can actually affect.
 *
 * The suite is 600-odd tests across 60 files and takes over a minute even when nothing has changed.
 * Most edits touch one module, so most of that minute is spent re-proving things that cannot have
 * moved. This is the smallest useful version of what Bazel does: each test file has a key made of
 * everything it transitively imports, the key is remembered with the result, and a file whose key is
 * unchanged *and whose last run passed* is skipped.
 *
 * What that means in practice, honestly:
 *
 *   - Editing `test/queries.test.ts` runs one file. Editing `src/durable/ledger.ts` runs the files
 *     that import it, directly or not. Editing `src/adapter/web/page.html` runs everything, because
 *     that file is read at runtime rather than imported, so nothing can prove which tests see it.
 *   - The cache is per checkout (under `node_modules/.cache`), never committed, and never trusted for
 *     a failure: a file that did not pass always runs again.
 *   - `npm run test:all` ignores the cache entirely and runs the suite in isolated processes, which
 *     is what to use before believing a green run.
 *
 * Usage:
 *   node scripts/changed-tests.mjs            # changed files only
 *   node scripts/changed-tests.mjs --all      # everything, cache ignored
 *   node scripts/changed-tests.mjs --list     # say what would run, run nothing
 *   node scripts/changed-tests.mjs --explain path/to/file   # why is a file being run
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const TEST_DIR = path.join(ROOT, "test");
const CACHE = path.join(ROOT, "node_modules", ".cache", "bridge-tests", "results.json");
const TEST_TIMEOUT_MS = 20_000;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const explainAt = args.indexOf("--explain");

const sha = (text) => createHash("sha1").update(text).digest("hex").slice(0, 16);

function read(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Every file under `dir` whose name does not end in `.ts`, as one hash. */
function runtimeInputs() {
  const parts = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (!entry.name.endsWith(".ts")) parts.push(`${path.relative(ROOT, full)}:${sha(read(full) ?? "")}`);
    }
  };
  walk(path.join(ROOT, "src"));
  walk(TEST_DIR);
  return sha(parts.join("|"));
}

/**
 * Every file under `src/` and `test/`, as a hash of their *names*.
 *
 * Contents only matter to a file's importers, so they belong in each key. Existence matters to tests
 * that enumerate — a guard that checks every adapter file is one of the known surfaces reads the
 * directory rather than importing it, and would otherwise be skipped when a file is added or removed.
 * Adding a file is rare, so the rule is cheap: a changed file list reruns everything.
 */
function fileListKey() {
  const names = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else names.push(path.relative(ROOT, full));
    }
  };
  walk(path.join(ROOT, "src"));
  walk(TEST_DIR);
  return sha(names.sort().join("\n"));
}

/**
 * The files a module imports, transitively.
 *
 * Static analysis, deliberately: a dynamic import or a path built at runtime cannot be seen here, so
 * anything that fails to resolve is treated as "this test depends on something unknowable" and the
 * file always runs. A false rerun costs a second; a false skip hides a regression.
 */
function importsOf(file) {
  const source = read(file);
  if (source === null) return [];
  const specifiers = [];
  const patterns = [
    // `import x from "y"`, `import type { X } from "y"`, `export { x } from "y"`, and the multi-line
    // forms — anchored to a statement, because a bare `from "..."` also matches an object property
    // (`paths.from = line.slice("...")`), which is how this first reported half a file as an import.
    /^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm,
    /^\s*import\s+["']([^"']+)["']/gm,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

/** A relative specifier as a file on disk, or null when it is a package or does not exist. */
function resolveImport(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null; // a dependency: covered by the lockfile hash, not by us
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base,
    base.replace(/\.js$/, ".ts"),
    `${base}.ts`,
    path.join(base, "index.ts"),
    base.replace(/\.js$/, ".tsx"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return "unresolved";
}

/** The key for one test file: its own bytes plus everything it can reach. */
function keyFor(testFile, runtimeKey) {
  const seen = new Set();
  const unresolved = [];
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const specifier of importsOf(file)) {
      const resolved = resolveImport(file, specifier);
      if (resolved === "unresolved") unresolved.push(`${path.relative(ROOT, file)} → ${specifier}`);
      else if (resolved) visit(resolved);
    }
  };
  visit(testFile);
  const files = [...seen].sort().map((file) => `${path.relative(ROOT, file)}:${sha(read(file) ?? "")}`);
  // Tooling that changes what a test *means* without being imported by it: the compiler's settings,
  // the dependency set, and the runtime. A tsconfig edit (target, strictness, path aliases) is exactly
  // the kind of change that should invalidate everything and is invisible to import analysis.
  const tooling = sha(
    [
      process.version,
      read(path.join(ROOT, "package.json")) ?? "",
      read(path.join(ROOT, "package-lock.json")) ?? "",
      read(path.join(ROOT, "tsconfig.json")) ?? "",
      read(path.join(ROOT, "tsconfig.e2e.json")) ?? "",
      runtimeKey,
    ].join("|"),
  );
  return { key: sha(`${files.join("|")}|${tooling}`), files: [...seen].sort(), unresolved };
}

function loadCache() {
  try {
    const parsed = JSON.parse(read(CACHE) ?? "{}");
    if (!parsed || typeof parsed.results !== "object") return { results: {}, files: "" };
    return { results: parsed.results, files: typeof parsed.files === "string" ? parsed.files : "" };
  } catch {
    return { results: {}, files: "" };
  }
}

function saveCache(results, files) {
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, `${JSON.stringify({ files, results }, null, 2)}\n`, "utf8");
}

const testFiles = fs
  .readdirSync(TEST_DIR)
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => path.join(TEST_DIR, name));

const runtimeKey = runtimeInputs();
const keys = new Map(testFiles.map((file) => [file, keyFor(file, runtimeKey)]));
const cache = loadCache();
const cached = cache.results;
const files = fileListKey();
// A file appearing or disappearing invalidates the cache wholesale: something enumerates a directory
// somewhere, and no import graph will tell us which test that is.
const addedOrRemoved = cache.files !== "" && cache.files !== files;
if (addedOrRemoved) {
  console.log("a source file was added or removed — running everything");
}

if (explainAt !== -1) {
  // "Why is this running?" answered directly, because a skip rule nobody can interrogate is a rule
  // that gets switched off the first time it looks wrong.
  const wanted = path.resolve(ROOT, args[explainAt + 1] ?? "");
  const entry = keys.get(wanted);
  if (!entry) {
    console.error(`${path.relative(ROOT, wanted)} is not a test file`);
    process.exit(2);
  }
  const previous = cached[path.relative(ROOT, wanted)];
  console.log(`key ${entry.key} (cached: ${previous?.key ?? "none"}, status: ${previous?.status ?? "none"})`);
  console.log(`${entry.files.length} files in its closure:`);
  for (const file of entry.files) console.log(`  ${path.relative(ROOT, file)}`);
  if (entry.unresolved.length) {
    console.log(`runs every time, because these imports could not be resolved statically:`);
    for (const line of entry.unresolved) console.log(`  ${line}`);
  }
  process.exit(0);
}

const toRun = [];
const unchanged = [];
for (const file of testFiles) {
  const relative = path.relative(ROOT, file);
  const entry = keys.get(file);
  const previous = cached[relative];
  const always = entry.unresolved.length > 0;
  if (flag("--all") || always || addedOrRemoved || !previous || previous.key !== entry.key || previous.status !== "pass") {
    toRun.push(file);
  } else {
    unchanged.push(relative);
  }
}

if (unchanged.length > 0) {
  console.log(`skipping ${unchanged.length} of ${testFiles.length} test files whose closure is unchanged since it last passed`);
}
if (toRun.length === 0) {
  console.log("nothing to run — pass --all to prove the whole suite anyway");
  process.exit(0);
}
console.log(`running ${toRun.length} test file${toRun.length === 1 ? "" : "s"}`);
if (flag("--list")) {
  for (const file of toRun) console.log(`  ${path.relative(ROOT, file)}`);
  process.exit(0);
}

// One process for all of them: the per-file process was most of the suite's wall time (60 spawns and
// 60 transpiles of the same graph). Files are independent, so sharing a process is safe as long as
// they do not rely on module state set up by another file — and if one ever does, `--all` isolates.
const run = spawnSync(
  process.execPath,
  [
    path.join(ROOT, "node_modules", ".bin", "tsx"),
    "--test",
    "--test-isolation=none",
    `--test-timeout=${TEST_TIMEOUT_MS}`,
    ...toRun,
  ],
  { stdio: "inherit", cwd: ROOT },
);

// Record results only for the files just run. A file that passed keeps its key; anything else keeps
// its old entry, which now has the wrong key anyway, so it runs next time.
const results = { ...cached };
for (const file of toRun) {
  const relative = path.relative(ROOT, file);
  results[relative] = { key: keys.get(file).key, status: run.status === 0 ? "pass" : "unknown" };
}
// Files that passed in a previous run and still have the same key keep their status: they were not run
// now, so there is nothing to overwrite.
saveCache(results, files);

process.exit(run.status ?? 1);
