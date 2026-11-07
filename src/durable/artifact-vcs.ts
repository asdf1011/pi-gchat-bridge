/**
 * Version control for a conversation's artifact directory.
 *
 * Scratch files and ad-hoc scripts are written to one directory per
 * conversation, and that directory is a jj repository. Each finished turn that
 * changed anything becomes a commit described `turn <submissionId>`. The point
 * is not archival — the transcript already holds what was generated and why.
 * The point is an **anchor** for review comments: a comment names a commit and a
 * line, and `jj file annotate` says whether that line is still live.
 *
 * Design notes worth keeping:
 *
 *   - **One repository per conversation.** They are independent, and a shared
 *     repository buys nothing: jj's oplog cost is the same total either way, a
 *     shared working copy would serialise concurrent turns from different
 *     conversations, and `jj log` would interleave unrelated histories that a
 *     human then has to filter. `rm -rf` is the whole teardown story.
 *   - **Commits, not snapshots.** A turn that changes a file gets its own
 *     revision, because a comment is only meaningful relative to one. A turn
 *     that changes nothing costs nothing: jj skips the snapshot entirely when
 *     the working copy is clean, so `turn <id>` descriptions legitimately have
 *     gaps and every reader must treat "no revision" as normal.
 *   - **`change_id` is the anchor, never `commit_id`.** `jj describe` and rebase
 *     churn commit ids; change ids survive. `jj file annotate` can emit change
 *     ids directly, so a comment resolves with one call and no join.
 *   - **Never push, never rewrite.** Only `init`, `describe`, `new`, and read
 *     commands. The harness is not a place to publish anything, and the
 *     AGENTS.md rule about never pushing applies to this code path too.
 *   - **Bookkeeping must never fail a turn.** Every call here is bounded and
 *     swallowed by the caller: a repository in a strange state is a lost
 *     annotation, not a lost answer.
 */
import { execFile } from "node:child_process";

import { parseRevisionDiff, type Hunk } from "./successor.js";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

/** How long any one jj invocation may take. Generous; jj is fast or broken. */
const JJ_TIMEOUT_MS = 15_000;

/**
 * The path a key names *inside* the repository.
 *
 * Two spellings are in play and they are not the same string. An artifact key is
 * relative to the artifacts root (`conversation/7/a.sh`), because that is what the
 * viewer serves; the repository is the conversation's own directory, so `jj` wants
 * `a.sh`. Converting in one place keeps every call site honest — and the fallback
 * matters: a repository that happens to be rooted somewhere else must still work,
 * so a key already relative to the root is passed through unchanged.
 */
export function repoRelativePath(repoDir: string, key: string): string {
  const parts = repoDir.replace(/\/+$/, "").split("/");
  const name = parts.pop() ?? "";
  const parent = parts.pop() ?? "";
  const prefix = `${parent}/${name}/`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

/** The inverse of `repoRelativePath`: what the viewer calls a file the repo changed. */
export function artifactKeyForPath(repoDir: string, filePath: string): string {
  const parts = repoDir.replace(/\/+$/, "").split("/");
  const name = parts.pop() ?? "";
  const parent = parts.pop() ?? "";
  return `${parent}/${name}/${filePath}`.replace(/^\/+/, "");
}

/**
 * Files never worth committing in a scratch directory.
 *
 * Written at init rather than left to the model: a runaway log or a stray venv
 * would otherwise hit `snapshot.max-new-file-size` and fail the snapshot with an
 * error that reads like a harness bug.
 */
const GITIGNORE = ["node_modules/", ".venv/", "__pycache__/", "*.log", "*.tmp", ".DS_Store", ""].join("\n");

/**
 * One annotated line of an artifact, as jj sees it now.
 *
 * Two line numbers, and the difference between them is the whole trick:
 *
 *   - `line` is where the line sits in the revision being annotated — what a
 *     browser needs in order to draw a highlight.
 *   - `originalLine` is where it sat in `changeId`'s own revision. That is the
 *     half that survives an edit *above* it: insert three lines at the top and
 *     `line` shifts by three while `originalLine` does not move at all.
 *
 * A comment is written against `(changeId, originalLine)`, so "is it still
 * there" is a set lookup rather than a search for text that has drifted.
 */
export interface AnnotatedLine {
  /** Change id of the revision that last touched this line in place. */
  changeId: string;
  /** 1-based line number in the revision being annotated. */
  line: number;
  /** 1-based line number in `changeId`'s own revision. */
  originalLine: number;
  content: string;
}

/**
 * Where one line of a comment points.
 *
 * All three fields are needed. The change id narrows to "this revision touched
 * it", `originalLine` says which of that revision's lines, and `content` rules
 * out a *different* line from the same revision having slid into that position
 * after a deletion. Two of the three would accept a comment about text that is
 * no longer there.
 */
export interface ArtifactAnchor {
  changeId: string;
  originalLine: number;
  content: string;
}

/** A comment on an artifact, anchored to `(revision, line)` pairs. */
export interface ArtifactComment {
  /** Stable id, unique within a conversation. */
  id: string;
  /** The artifact, relative to the repository root. */
  file: string;
  /**
   * One anchor per selected line, in order. A selection spanning lines that came
   * from different turns is normal, and is why this is a list rather than a
   * single triple.
   */
  anchors: ArtifactAnchor[];
  /**
   * The selected text, when the selection was narrower than whole lines.
   *
   * `charStart`/`charEnd` are 1-based and inclusive within the *first* anchored
   * line, and are dropped for a selection spanning several lines. Code points,
   * not bytes, so a comment on a line of CJK or emoji points where the reader's
   * cursor was.
   */
  quote?: string;
  charStart?: number;
  charEnd?: number;
  /** Which occurrence of `quote` this was, 0-based: a rendered view needs it. */
  occurrence?: number;
  /** What the reviewer said. */
  text: string;
  /** When it was written, epoch ms. */
  at: number;
  /** Who wrote it, when the surface knows. */
  author?: string;
  /** Set only by an explicit action. Comments are never auto-resolved. */
  resolved?: boolean;
  /**
   * Submissions this comment has started, oldest first.
   *
   * An id is enough to recover the answer later (`awaitSubmission` is durable),
   * so a thread's replies are joins rather than a second copy of the transcript.
   */
  submissions?: number[];
  /** What the agent said in the thread itself; never a transcript entry. */
  replies?: { text: string; at: number; author?: string }[];
  /**
   * The revision this comment was written against, as a change id.
   *
   * Absent on comments that predate the field, and on deployments with no
   * repository. Without it a superseded comment cannot be placed, only reported.
   */
  atRevision?: string;
}

/**
 * Where a comment currently stands relative to the revision being displayed.
 *
 * `superseded` is the case this model used to report as `orphaned`: the lines it
 * was written on are gone, and the revision that replaced them is known (see
 * `successor.ts`). It is a different thing from lost, and a reader can act on it.
 */
export type CommentState = "visible" | "superseded" | "orphaned" | "resolved";

export interface ResolvedComment extends ArtifactComment {
  state: CommentState;
  /**
   * Line numbers, in the revision being displayed, where each anchor was found.
   *
   * Empty for an orphaned comment; shorter than `anchors` only when a selection
   * was partly rewritten, in which case the state is already orphaned but the
   * surviving lines can still be highlighted honestly.
   */
  positions: number[];
}

/** Run jj in `dir`, resolving to stdout. Rejects on non-zero exit or timeout. */
function jj(dir: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "jj",
      args as string[],
      {
        cwd: dir,
        timeout: JJ_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        // jj opens an editor for anything that wants a description; there is no
        // terminal here to answer it. `-m` covers describe/new, this covers the
        // rest.
        env: { ...process.env, JJ_EDITOR: "true", JJ_CONFIG: process.env.JJ_CONFIG ?? "" },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`jj ${args.join(" ")}: ${stderr.trim() || error.message}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/** True when `dir` is a jj repository (its own, or an ancestor's). */
async function isInJjRepo(dir: string): Promise<boolean> {
  try {
    await jj(dir, ["root"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Make `dir` a jj repository, if it is not one already.
 *
 * Idempotent, and deliberately tolerant of an enclosing repository: an artifact
 * directory inside an existing checkout should be tracked by that checkout, not
 * given a nested repo jj would refuse to create. Returns whether `dir`'s own
 * history is now available for annotation.
 */
export async function initArtifactRepo(dir: string): Promise<boolean> {
  await fsp.mkdir(dir, { recursive: true });
  if (await isInJjRepo(dir)) return true;

  const ignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(ignore)) await fsp.writeFile(ignore, GITIGNORE, "utf8");

  try {
    await jj(dir, ["git", "init", "--colocate"]);
    // Fold the `.gitignore` into an initial revision immediately, so it is not
    // attributed to the first turn that writes a file. Without this, turn 1
    // always looks like it changed something the model never touched.
    await jj(dir, ["describe", "-m", "artifacts repository"]);
    await jj(dir, ["new", "-m", "wip"]);
  } catch (error) {
    // A directory that cannot be a repo (permissions, a broken parent repo) is
    // still a usable place to put files. Say so, do not fail.
    throw new Error(`could not initialise artifact repo at ${dir}: ${String(error)}`);
  }
  return true;
}

/**
 * Commit whatever the finished turn changed, described `turn <submissionId>`.
 *
 * Called once per turn, after the turn has settled. Returns the new revision's
 * change id, or `undefined` when the turn changed nothing — in which case jj
 * creates no revision at all, which is the cheap and correct outcome. The
 * description is written with `describe` and then `new`, in one invocation each,
 * because `new -m` would describe the *new* empty commit rather than the one
 * holding the changes.
 */
export async function commitTurn(
  dir: string,
  submissionId: number | string,
): Promise<string | undefined> {
  try {
    // `--ignore-working-copy` on the reads keeps a display from creating an op,
    // but the write path needs the snapshot, so it is deliberately absent here.
    //
    // Cleanliness is read from the entry lines only. Testing the header as well
    // was a bug: `jj st` prints "Working copy changes:" even when the only entry
    // is the `.gitignore` written at init, so the first turn of every repository
    // looked idle and never committed.
    const changed = await jj(dir, ["st", "--no-pager"]);
    // `R` matters: a turn that only renamed a file prints one `R {a => b}` line, and
    // omitting it silently skipped the commit — which left the rename outside history
    // and every comment on that file un-mappable. `C` for a copy, same argument.
    if (!/^[AMDRC]\s/m.test(changed)) {
      return undefined; // clean: jj would make no operation, so make none
    }

    await jj(dir, ["describe", "-m", `turn ${submissionId}`]);
    const log = await jj(dir, [
      "log",
      "--no-graph",
      "-r",
      "@",
      "-T",
      "change_id.short()",
    ]);
    return log.trim() || undefined;
  } finally {
    // Whether or not there was anything to commit, start the next turn on a
    // fresh empty commit. Doing this in `finally` means a turn that throws
    // half-way still leaves a usable working copy behind it.
    //
    // Described `wip` but *empty*, and abandoned immediately: the next turn's
    // `describe` names it, so it never appears as a `wip` revision in the log
    // unless the conversation ends on it.
    //
    // No `--no-edit`: with it, `jj new` keeps the current change id instead of
    // starting a fresh change, so the next turn's work lands on this turn's
    // revision and two turns share one anchor. `JJ_EDITOR=true` in the
    // environment is what keeps `-m` from needing an editor.
    await jj(dir, ["new", "-m", "wip"]).catch(() => {});
  }
}

/**
 * Annotate `file` at `revision`, one entry per line.
 *
 * `--ignore-working-copy` because a reader must not participate in history: a
 * display request that arrives mid-turn would otherwise snapshot a half-written
 * file into an operation.
 */
export async function annotate(
  dir: string,
  revision: string,
  file: string,
): Promise<AnnotatedLine[]> {
  // A tab separator, because jj's template language supports `\t` but not
  // `\u0001` (it fails to parse). File content can contain a tab, so the split is
  // bounded to the first three fields and the remainder is content.
  //
  // `original_line_number` is the load-bearing field: `line_number` is where the
  // line sits *now*, which changes as soon as anything above it is inserted.
  const out = await jj(dir, [
    "file",
    "annotate",
    "--ignore-working-copy",
    "-r",
    revision,
    "-T",
    'commit.change_id().short() ++ "\t" ++ original_line_number ++ "\t" ++ line_number ++ "\t" ++ content',
    file,
  ]);

  const lines: AnnotatedLine[] = [];
  for (const raw of out.split("\n")) {
    if (raw === "") continue;
    const fields = [raw.indexOf("\t")];
    if (fields[0] === -1) continue;
    fields.push(raw.indexOf("\t", fields[0] + 1));
    if (fields[1] === -1) continue;
    fields.push(raw.indexOf("\t", fields[1] + 1));
    if (fields[2] === -1) continue;
    const changeId = raw.slice(0, fields[0]);
    const originalLine = raw.slice(fields[0] + 1, fields[1]);
    const line = raw.slice(fields[1] + 1, fields[2]);
    if (!changeId || !originalLine || !line) continue;
    lines.push({
      changeId,
      originalLine: Number(originalLine),
      line: Number(line),
      content: raw.slice(fields[2] + 1),
    });
  }
  return lines;
}

/**
 * Determine where every comment stands against one revision of its file.
 *
 * Annotation is a **display** witness, not the source of truth: it can prove a
 * comment is still live (its anchor appears on some line) but it cannot prove a
 * comment is dead, because a deleted or rewritten line annotates to something else
 * entirely. So "not found" means *orphaned* — still open, no longer visible — and
 * only an explicit resolution ever closes a comment. That is what keeps a line
 * that merely shifted four rows down from silently discarding a review.
 *
 * Matching is on `(changeId, originalLine, content)`, never on the current line
 * number: a line pushed down by an insertion above it keeps its anchor and is
 * still the same line, which is the case a reviewer actually hits.
 */
export function classifyComments(
  comments: readonly ArtifactComment[],
  annotated: ReadonlyMap<string, readonly AnnotatedLine[]>,
): ResolvedComment[] {
  return comments.map((comment) => {
    if (comment.resolved) return { ...comment, state: "resolved", positions: [] };
    const lines = annotated.get(comment.file);
    if (!lines || comment.anchors.length === 0) {
      return { ...comment, state: "orphaned", positions: [] };
    }
    const positions: number[] = [];
    let found = 0;
    for (const anchor of comment.anchors) {
      const hit = lines.find(
        (line) =>
          line.changeId === anchor.changeId &&
          line.originalLine === anchor.originalLine &&
          line.content === anchor.content,
      );
      if (hit) {
        found += 1;
        positions.push(hit.line);
      }
    }
    // Every anchor must survive. A partly-matched selection is one the reviewer
    // should look at again, so it reports as orphaned while still carrying the
    // positions that did match.
    return { ...comment, state: found === comment.anchors.length ? "visible" : "orphaned", positions };
  });
}

/**
 * The change id of the revision a viewer is looking at.
 *
 * Read with `--ignore-working-copy` for the same reason as `annotate`: a display
 * request must not snapshot a half-written file into history. Used to record what a
 * comment was written *against*, which is the input the successor mapping needs.
 */
export async function currentRevision(dir: string): Promise<string | undefined> {
  try {
    // `@` is the working copy, and the harness keeps it *empty*: `commitTurn` ends
    // every turn by describing `@` and starting a fresh one. An empty `@` is a
    // mutable name for the parent's content — the next turn is described into it —
    // so a comment recorded against it would later diff against itself and find
    // nothing. The revision a reader actually saw is therefore the last
    // non-empty one, which is `@-` in the normal case.
    const at = await jj(dir, [
      "log",
      "--no-graph",
      "--ignore-working-copy",
      "-r",
      "@",
      "-T",
      'change_id.short() ++ "\t" ++ empty',
    ]);
    const [changeId, empty] = at.trim().split("\t");
    if (!changeId) return undefined;
    if (empty !== "true") return changeId;
    const parent = await jj(dir, [
      "log",
      "--no-graph",
      "--ignore-working-copy",
      "-r",
      "@-",
      "-T",
      "change_id.short()",
    ]);
    // A brand-new repository has only the root as parent and no content at all;
    // `@` is then the honest answer even though it is empty.
    return parent.trim() || changeId;
  } catch {
    return undefined;
  }
}

/**
 * What one revision changed, as parseable hunks per file.
 *
 * One call for the whole revision rather than one per file: a turn is a single
 * diff, and the files a review cares about are however many that turn touched.
 * `--context 0` keeps hunks minimal — the smallest region that changed is exactly
 * the region a comment's successor should be measured against.
 */
export async function revisionDiff(
  dir: string,
  from: string,
  to: string,
): Promise<{ files: Map<string, Hunk[]>; renames: Map<string, string> }> {
  const out = await jj(dir, ["diff", "--from", from, "--to", to, "--git", "--context", "0", "--ignore-working-copy"]);
  return parseRevisionDiff(out);
}

/**
 * The file at one revision, as text.
 *
 * `--ignore-working-copy` for the same reason `annotate` has it: reading must not
 * create an operation, and a display request arriving mid-turn must not snapshot
 * a half-written file into the history.
 */
export async function showFile(dir: string, revision: string, file: string): Promise<string> {
  return jj(dir, ["file", "show", "--ignore-working-copy", "-r", revision, file]);
}

/**
 * The paths a revision changed, relative to the repository root.
 *
 * Used to pin "this is the version of the file this conversation produced", so a
 * reopened conversation shows what it made rather than whatever the file says
 * today.
 */
export async function changedFiles(dir: string, revision: string): Promise<string[]> {
  const out = await jj(dir, ["diff", "--summary", "--ignore-working-copy", "-r", revision]);
  const files: string[] = [];
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    // `M path`, `A path`, `D path`, `R {old => new}`. The status is one letter,
    // and a rename's brace form is not a path we can serve — skip it.
    const match = /^[MADRC]\s+(.*)$/.exec(line);
    if (!match) continue;
    const candidate = match[1]!.trim();
    if (candidate.includes(" => ")) continue;
    files.push(candidate);
  }
  return files;
}

/**
 * Revisions that changed `file`, newest first, as the viewer's history offers.
 *
 * `files(...)` is a revset function, so this is one call, and the description is
 * what makes a revision recognisable in a dropdown (`turn 41`).
 */
export async function revisionLog(
  dir: string,
  file: string,
): Promise<{ changeId: string; description: string; at: number }[]> {
  const out = await jj(dir, [
    "log",
    "--no-graph",
    "--ignore-working-copy",
    "-r",
    `::@ & files(${file})`,
    "-T",
    'change_id.short() ++ "\t" ++ description.first_line() ++ "\t" ++ committer.timestamp() ++ "\n"',
  ]);
  const revisions: { changeId: string; description: string; at: number }[] = [];
  for (const raw of out.split("\n")) {
    if (raw === "") continue;
    const first = raw.indexOf("\t");
    const second = first === -1 ? -1 : raw.indexOf("\t", first + 1);
    if (first === -1 || second === -1) continue;
    const changeId = raw.slice(0, first);
    const seconds = Number(raw.slice(second + 1));
    revisions.push({
      changeId,
      description: raw.slice(first + 1, second),
      at: Number.isFinite(seconds) ? seconds * 1000 : 0,
    });
  }
  return revisions;
}

/** The open comments no longer visible in the latest artifact, for review. */
export function orphanedComments(comments: readonly ResolvedComment[]): ResolvedComment[] {
  return comments.filter((comment) => comment.state === "orphaned");
}
