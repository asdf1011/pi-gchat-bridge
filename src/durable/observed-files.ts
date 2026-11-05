/**
 * Files the filesystem saw change, so `bash` edits count as artifacts.
 *
 * The transcript can only name a file when a tool call names it, and the tools
 * that do (`write`, `edit`) are one way to change a file among many: `sed -i`, a
 * `cat > file <<EOF`, a formatter, a build. Those leave no path in the entry to
 * derive from — see the note at the top of `artifacts.ts`.
 *
 * So this asks the only witness that cannot be bypassed: the filesystem. Around
 * each turn, note the wall clock before submitting, walk the artifact roots after
 * the turn settles, and keep the files whose mtime is newer than that. No command
 * parsing, no per-tool special cases, and a new way of writing a file is covered
 * the day it is used.
 *
 * The cost is a walk of the roots per turn — 8.6k files here, ~0.4 s, off the
 * reply path and after the answer has settled. The limits below keep one runaway turn (a checkout, a build tree)
 * from turning into an unbounded list.
 *
 * What it cannot do is tell a write from an edit: mtime says "changed", nothing
 * more. That is why observed files carry no write/edit counts, and why paths a
 * tool call already named keep the counts the transcript gave them.
 */
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * One file seen changing, and when.
 *
 * A type alias, not an interface: it is stored inside a pi-durable document, and
 * those accept literals with an implicit index signature — interfaces do not get
 * one.
 */
export type ObservedFile = {
  /** Absolute path, as the walk found it (symlinks not resolved). */
  path: string;
  /** Epoch ms of the modification that made it count. */
  at: number;
};

/** Most files one turn may contribute. A checkout should not fill the drawer. */
export const OBSERVED_MAX_PER_SCAN = 400;

/** Most files one conversation keeps. Older observations fall off the end. */
export const OBSERVED_MAX_PER_CONVERSATION = 200;

/**
 * Directories never worth walking: dependency trees and version-control internals
 * are neither written by hand nor interesting as artifacts, and together they are
 * most of the file count under a working directory.
 */
const SKIP_DIRS = new Set(["node_modules", ".git", ".jj"]);

/**
 * Files this bridge writes itself, so they would otherwise appear as artifacts of
 * every conversation: the database (one WAL write per message), our logs, our pid
 * file. Matched on the base name at any depth, because the roots are not fixed.
 */
const SKIP_NAMES = new Set([
  "bridge.sqlite",
  "bridge.sqlite-wal",
  "bridge.sqlite-shm",
  "bridge-durable.log",
  "bridge-restart.log",
  ".start-bridge.pid",
]);

/** Directories the walk refuses to descend into, by base name. */
function skipped(name: string): boolean {
  return SKIP_DIRS.has(name) || SKIP_NAMES.has(name);
}

/** Stats in flight at once. Enough to hide latency, few enough not to swamp IO. */
const STAT_CONCURRENCY = 64;

/**
 * Files under `roots` with an mtime at or after `since`.
 *
 * Symlinks are not followed: a link to a directory inside the same root would
 * report every file twice under two spellings, and a link out of the roots is
 * not ours to serve anyway.
 *
 * Directories are listed in parallel and stats run in batches, because the naive
 * version — one `await` per file, depth first — took 1.6 s on this working
 * directory for what is a hundred milliseconds of actual work.
 */
export async function filesChangedSince(
  roots: readonly string[],
  since: number,
  options: { max?: number } = {},
): Promise<ObservedFile[]> {
  const max = options.max ?? OBSERVED_MAX_PER_SCAN;
  const found: ObservedFile[] = [];
  let frontier = roots.map((root) => path.resolve(root));

  while (frontier.length > 0 && found.length < max) {
    const listings = await Promise.all(
      frontier.map(async (dir) => {
        try {
          return await fs.readdir(dir, { withFileTypes: true });
        } catch {
          return [] as Dirent[]; // gone, or not readable: neither is an artifact
        }
      }),
    );

    const next: string[] = [];
    const candidates: string[] = [];
    listings.forEach((entries, index) => {
      const dir = frontier[index]!;
      for (const entry of entries) {
        if (skipped(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) next.push(full);
        else if (entry.isFile()) candidates.push(full);
      }
    });

    for (let at = 0; at < candidates.length && found.length < max; at += STAT_CONCURRENCY) {
      const batch = candidates.slice(at, at + STAT_CONCURRENCY);
      const stats = await Promise.all(
        batch.map(async (full) => {
          try {
            return { full, stat: await fs.stat(full) };
          } catch {
            return undefined; // deleted between listing and stat
          }
        }),
      );
      for (const result of stats) {
        if (!result || result.stat.mtimeMs < since) continue;
        found.push({ path: result.full, at: Math.round(result.stat.mtimeMs) });
      }
    }
    frontier = next;
  }

  // The cap is per scan, not per directory, but a directory can overshoot it by a
  // batch; trim after the fact so the caller always gets at most `max`.
  return found.length > max ? found.slice(0, max) : found;
}

/**
 * Add observations to what a conversation already knows.
 *
 * Newest first, deduplicated on the path, capped. Called with one turn's finds,
 * so a file changed five times in five turns stays one entry with the latest
 * time rather than five rows in the drawer.
 */
export function mergeObserved(
  existing: readonly ObservedFile[] | undefined,
  fresh: readonly ObservedFile[],
  max = OBSERVED_MAX_PER_CONVERSATION,
): ObservedFile[] {
  const byPath = new Map<string, ObservedFile>();
  for (const file of existing ?? []) byPath.set(file.path, file);
  for (const file of fresh) {
    const previous = byPath.get(file.path);
    byPath.set(file.path, previous && previous.at > file.at ? previous : file);
  }
  return [...byPath.values()].sort((a, b) => b.at - a.at).slice(0, max);
}
