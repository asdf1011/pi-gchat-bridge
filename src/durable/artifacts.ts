/**
 * Artifacts: the files a conversation wrote or edited.
 *
 * **Derived, not recorded.** Every `write` and `edit` tool call is already a
 * durable entry with the path in its arguments, so the transcript is the ledger:
 * nothing has to be written per tool call, there is no second list to keep in
 * sync, and conversations that predate this file already have their artifact
 * lists. On this store that is 19 artifacts for the largest conversation, found
 * in ~120 ms including opening the database read-only.
 *
 * What that costs, stated up front so it is not a surprise later: a change made
 * through `bash` (`sed -i`, a `>` redirect, a build writing into `dist/`) leaves
 * no artifact, because the tool call does not say which files it touched.
 * Recovering those needs a filesystem diff per turn; the transcript cannot see
 * them.
 *
 * Paths are the other half of the problem. The same file shows up under two
 * spellings in this deployment (`/workspace/pi-chat-bridge/...` is a symlink to
 * `/workspace/pi-gchat-bridge/...`), so grouping is done on the resolved path
 * while the URL and the display use the path as written. Without that, one file
 * becomes two artifacts and the viewer opens whichever spelling it happened to
 * index last.
 */
import fs from "node:fs";
import path from "node:path";

/** The slice of an entry this module reads. Structural, so tests need no harness. */
export interface ArtifactEntryLike {
  id?: number;
  model?: readonly ArtifactMessageLike[];
}

export interface ArtifactMessageLike {
  content?: readonly ArtifactBlockLike[];
}

export interface ArtifactBlockLike {
  type?: string;
  name?: string;
  arguments?: unknown;
}

/** One file a conversation touched, keyed for a URL. */
export interface ArtifactFile {
  /** URL key: the path relative to its root, POSIX separators. */
  key: string;
  /** Absolute, symlink-resolved root the file was found under. */
  root: string;
  /** Absolute path as the tool call wrote it (symlinks NOT resolved). */
  path: string;
  /** How many `write` calls produced it. */
  wrote: number;
  /** How many `edit` calls changed it. */
  edited: number;
  /** Newest entry that touched it, so a view can link back to the turn. */
  entryId?: number;
}

/** Tool names that name the file they change. Anything else is invisible here. */
const WRITING_TOOLS = new Set(["write", "edit"]);

/**
 * Cap on what one artifact request may read. Larger files are truncated rather
 * than refused: a 10 MB log is still worth seeing the beginning of.
 */
export const DEFAULT_MAX_ARTIFACT_BYTES = 1024 * 1024;

/**
 * Roots a request may serve from, in order of preference.
 *
 * `BRIDGE_ARTIFACT_ROOTS` (colon-separated) overrides; otherwise the agent's
 * working directory and the agent config dir. Both are needed: this deployment
 * edits files in `PI_CWD` *and* in the agent config directory (`AGENTS.md`), and
 * a root list of just `PI_CWD` would silently hide the latter.
 */
export function artifactRoots(cwd: string, agentDir: string): string[] {
  const configured = (process.env.BRIDGE_ARTIFACT_ROOTS ?? "")
    .split(":")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  const roots = configured.length > 0 ? configured : [cwd, agentDir];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const root of roots) {
    const canonical = canonicalPath(path.resolve(root));
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
  }
  return out;
}

/**
 * Resolve symlinks where possible, and fall back to resolving the parent.
 *
 * A file that has since been deleted still needs a stable key — a conversation's
 * artifact list must not lose entries because the temporary file it wrote is
 * gone — so a failed `realpath()` on the leaf is not fatal.
 */
export function canonicalPath(target: string): string {
  const absolute = path.resolve(target);
  try {
    return fs.realpathSync(absolute);
  } catch {
    // Fall through: the leaf may be gone, or be a dangling symlink.
  }
  try {
    return path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute));
  } catch {
    return absolute;
  }
}

/** True when `candidate` is strictly inside `root` (not root itself). */
export function isInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * The URL key for one path, relative to the longest root that contains it.
 *
 * Longest wins so nested roots (`PI_CWD` and a repo inside it) produce the
 * shortest, most readable key rather than an ambiguous one. A path outside every
 * root returns `undefined`: it is not an artifact this deployment will serve.
 */
export function artifactKeyFor(
  filePath: string,
  roots: readonly string[],
): { root: string; key: string } | undefined {
  const canonical = canonicalPath(filePath);
  let best: { root: string; key: string } | undefined;
  for (const root of roots) {
    if (!isInsideRoot(root, canonical)) continue;
    if (best && best.root.length >= root.length) continue;
    const key = path.relative(root, canonical).split(path.sep).join("/");
    best = { root, key };
  }
  return best;
}

/** The file path a tool call named, if it named one. */
function toolPath(block: ArtifactBlockLike): string | undefined {
  if (block.type !== "toolCall") return undefined;
  if (typeof block.name !== "string" || !WRITING_TOOLS.has(block.name)) return undefined;
  const args = block.arguments;
  if (typeof args !== "object" || args === null) return undefined;
  const candidate = (args as { path?: unknown }).path;
  return typeof candidate === "string" && candidate !== "" ? candidate : undefined;
}

/**
 * Every file one conversation touched, in first-touch order.
 *
 * `entries` are expected in commit order, which is what `viewState()` and the
 * `entries` table both give. Counting is per tool call, so "wrote once, edited
 * four times" is visible without reading the transcript.
 */
export function deriveArtifacts(
  entries: readonly ArtifactEntryLike[],
  roots: readonly string[],
): ArtifactFile[] {
  const byCanonical = new Map<string, ArtifactFile>();
  for (const entry of entries) {
    for (const message of entry.model ?? []) {
      for (const block of message.content ?? []) {
        const named = toolPath(block);
        if (named === undefined) continue;
        const keyed = artifactKeyFor(named, roots);
        if (keyed === undefined) continue;
        const canonical = canonicalPath(named);
        const existing = byCanonical.get(canonical);
        const isWrite = block.name === "write";
        if (existing) {
          if (isWrite) existing.wrote += 1;
          else existing.edited += 1;
          if (entry.id !== undefined) existing.entryId = entry.id;
          continue;
        }
        byCanonical.set(canonical, {
          key: keyed.key,
          root: keyed.root,
          path: path.resolve(named),
          wrote: isWrite ? 1 : 0,
          edited: isWrite ? 0 : 1,
          ...(entry.id === undefined ? {} : { entryId: entry.id }),
        });
      }
    }
  }
  return [...byCanonical.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export interface ReadArtifactOptions {
  /** Bytes to read at most. Defaults to `DEFAULT_MAX_ARTIFACT_BYTES`. */
  maxBytes?: number;
  /** Applied to the text on the way out. The viewer bypasses the harness, so redaction is the caller's job. */
  redact?: (text: string) => string;
}

export interface ArtifactContent {
  /** UTF-8 text, truncated and/or redacted. Empty for a binary file. */
  content: string;
  /** Size on disk in bytes. */
  size: number;
  /** True when the file was longer than `maxBytes`. */
  truncated: boolean;
  /** True when the file looks binary; `content` is then empty. */
  binary: boolean;
  /** What the path resolved to, after symlinks. */
  resolved: string;
}

/**
 * Read one artifact, refusing anything that escaped its root.
 *
 * The containment check is repeated here rather than trusted from `deriveArtifacts`:
 * between listing and reading, a path component can be swapped for a symlink
 * pointing at `/etc/shadow`. `realpath()` then puts it outside the root and the
 * read fails, which is the whole reason this is not just `readFileSync`.
 */
export function readArtifact(file: ArtifactFile, options: ReadArtifactOptions = {}): ArtifactContent {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  const resolved = canonicalPath(file.path);
  if (!isInsideRoot(file.root, resolved)) {
    throw new Error(`${file.key} resolves outside its root (${file.root})`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error(`${file.key} is not a file`);

  const toRead = Math.min(stat.size, maxBytes);
  const buffer = Buffer.alloc(toRead);
  const handle = fs.openSync(resolved, "r");
  let read = 0;
  try {
    while (read < toRead) {
      const chunk = fs.readSync(handle, buffer, read, toRead - read, read);
      if (chunk === 0) break;
      read += chunk;
    }
  } finally {
    fs.closeSync(handle);
  }
  const bytes = buffer.subarray(0, read);

  // A NUL in the first block is the classic cheap binary test and the one that
  // matters here: the viewer renders text, so anything else is reported rather
  // than served as mojibake.
  const binary = bytes.subarray(0, 8192).includes(0);
  if (binary) {
    return { content: "", size: stat.size, truncated: false, binary: true, resolved };
  }

  const text = bytes.toString("utf8");
  return {
    content: options.redact ? options.redact(text) : text,
    size: stat.size,
    truncated: stat.size > read,
    binary: false,
    resolved,
  };
}

/**
 * Whether a file should be offered as a rendered document by default.
 *
 * Deliberately a short allow-list rather than sniffing: serving the wrong thing
 * as HTML is the one mistake this viewer cannot afford, and an extension check
 * is a decision, not a guess.
 */
export function isMarkdown(key: string): boolean {
  const extension = path.extname(key).toLowerCase();
  return extension === ".md" || extension === ".markdown";
}
