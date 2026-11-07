/**
 * Where a comment's line went.
 *
 * The anchor model points *backwards*: a comment records the revision that wrote
 * the line, that revision's own line number, and the text. Visibility then requires
 * all three to still match — which is exactly what an agent's edit is meant to
 * break. So the outcome the reviewer asked for (the line changed) used to be
 * reported as the outcome they fear (the review is lost).
 *
 * This module answers the other question, and answers it from history rather than
 * by guessing: given the revision a comment was made against and the revision now
 * being displayed, *which section of the file is the one that replaced it?*
 *
 * The mechanism is one `jj diff` between those revisions with `--context 0`, which
 * makes every hunk the minimal changed region — the same unit a review comment
 * wants. Mapping a commented range through those hunks is then four cases: it was
 * untouched (possibly shifted), it was replaced, it was deleted, or the file is not
 * the file any more.
 *
 * Deliberately **not** done here:
 *
 *   - **No fuzzy text matching.** When the agent rewrites a line, similarity says
 *     nothing useful. jj already knows the exact edit; guessing is only a way to be
 *     subtly wrong about somebody's review.
 *   - **No causality.** A successor is a location, not a claim that this comment
 *     caused the change. That is a judgement the transcript cannot support, and
 *     stating it would be a guess dressed as metadata.
 *   - **No resolution.** The reviewer closes a note; a diff does not.
 *
 * Everything in this file is pure: text in, data out. The jj call lives in
 * `artifact-vcs.ts`, which hands its output here.
 */

/** One hunk of a `--git --context 0` diff: the minimal changed region. */
export interface Hunk {
  /** 1-based first line on the old side. */
  oldStart: number;
  /** 0 for a pure insertion, which sits *between* old lines. */
  oldCount: number;
  /** 1-based first line on the new side. */
  newStart: number;
  /** 0 for a pure deletion. */
  newCount: number;
  /** Old-side text, without the leading `-`. */
  removed: string[];
  /** New-side text, without the leading `+`. */
  added: string[];
}

/** What one revision's diff says about one file. */
export interface FileDiff {
  /** Hunks for this file, or `[]` when its content did not change. */
  hunks: Hunk[];
  /** Set when this revision renamed the file; the new path. */
  renamedTo?: string;
}

/** Where a commented range ended up, and what happened to it. */
export interface Successor {
  /**
   * `unchanged` — the same text is at the same place (a rewrite elsewhere, or a
   * rebase that changed the change id but not the content).
   * `moved` — untouched, but shifted by edits above it.
   * `replaced` — edited in place; `quote` holds what is there now.
   * `removed` — deleted with nothing in its place; `end < start` marks the gap.
   */
  kind: "unchanged" | "moved" | "replaced" | "removed";
  /** 1-based range in the new revision; `end < start` for `removed`. */
  start: number;
  end: number;
  /** The new-side text of the replacing section, for display. */
  quote?: string;
}

/** A line as `jj file annotate` reports it. Structural, so this file needs no import. */
export interface AnnotatedLike {
  changeId: string;
  line: number;
  originalLine: number;
  content: string;
}

/** One anchor, as a comment stores it. Structural for the same reason. */
export interface AnchorLike {
  changeId: string;
  originalLine: number;
  content: string;
}

/**
 * Parse a whole `--git` diff into per-file hunks.
 *
 * Whole-revision rather than per-file: one turn is one diff, and a reviewer's
 * comments are spread over whatever that turn touched. Renames are reported as a
 * mapping rather than an error, because a renamed file is still the file being
 * reviewed — the same line, under a different name.
 */
export function parseRevisionDiff(diff: string): { files: Map<string, Hunk[]>; renames: Map<string, string> } {
  const files = new Map<string, Hunk[]>();
  const renames = new Map<string, string>();
  let current: Hunk[] | undefined;
  let paths = { from: "", to: "" };

  const flush = (): void => {
    if (!current) return;
    if (paths.to) files.set(paths.to, current);
    if (paths.from && paths.to && paths.from !== paths.to) renames.set(paths.from, paths.to);
    current = undefined;
  };

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      current = [];
      // `a/x b/y` — the reliable paths come from the rename headers below when
      // they exist, and from this otherwise. Split on the ` b/` boundary because
      // a path may contain spaces.
      const rest = line.slice("diff --git ".length);
      const split = rest.lastIndexOf(" b/");
      paths = { from: rest.slice(2, split === -1 ? rest.length : split), to: split === -1 ? "" : rest.slice(split + 3) };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("rename from ")) {
      paths.from = line.slice("rename from ".length);
      continue;
    }
    if (line.startsWith("rename to ")) {
      paths.to = line.slice("rename to ".length);
      continue;
    }
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      current.push({
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        removed: [],
        added: [],
      });
      continue;
    }
    const last = current[current.length - 1];
    if (!last) continue;
    if (line.startsWith("-") && !line.startsWith("---")) last.removed.push(line.slice(1));
    else if (line.startsWith("+") && !line.startsWith("+++")) last.added.push(line.slice(1));
  }
  flush();
  return { files, renames };
}

/**
 * Map a commented range from the old revision to the new one.
 *
 * A hunk *entirely* above the range only shifts it; a pure insertion above it does
 * the same. A hunk that overlaps it either replaced it (`newCount > 0`, so the
 * successor is the whole new-side section — it is the smallest region that stands
 * where the commented text stood) or deleted it (`newCount === 0`, so the successor
 * is the gap the deletion left, and there is nothing to quote).
 */
export function mapRange(hunks: readonly Hunk[], start: number, end: number): Successor {
  const overlaps = (hunk: Hunk): boolean =>
    hunk.oldCount > 0 && start <= hunk.oldStart + hunk.oldCount - 1 && end >= hunk.oldStart;

  const shiftAbove = hunks
    .filter((hunk) =>
      hunk.oldCount === 0 ? hunk.oldStart < start : hunk.oldStart + hunk.oldCount - 1 < start,
    )
    .reduce((delta, hunk) => delta + hunk.newCount - hunk.oldCount, 0);

  const touching = hunks.filter(overlaps);
  if (touching.length === 0) {
    return {
      kind: shiftAbove === 0 ? "unchanged" : "moved",
      start: start + shiftAbove,
      end: end + shiftAbove,
    };
  }

  const replacing = touching.filter((hunk) => hunk.newCount > 0);
  if (replacing.length === 0) {
    // Deleted, with nothing in its place: point at the gap so the drawer can still
    // say where the note belongs, rather than dropping it into a list of mysteries.
    const last = touching[touching.length - 1] as Hunk;
    const at = last.newStart + 1;
    return { kind: "removed", start: at, end: at - 1 };
  }

  const lastReplacing = replacing[replacing.length - 1] as Hunk;
  return {
    kind: "replaced",
    start: (replacing[0] as Hunk).newStart,
    end: lastReplacing.newStart + lastReplacing.newCount - 1,
    quote: replacing.flatMap((hunk) => hunk.added).join("\n"),
  };
}

/** A comment and the revision it was written against, as the re-anchoring needs them. */
export interface Reanchorable {
  file: string;
  anchors: readonly AnchorLike[];
  /** Change id of the revision the comment was written against, when known. */
  atRevision?: string;
}

/** Where a comment stands after asking the diff, or `undefined` when it cannot say. */
export interface Reanchored {
  /** The revision displayed now — what the successor's line numbers refer to. */
  revision: string;
  successor: Successor;
}

/** The two history reads the mapping needs. Injected so tests need no repository. */
export interface ReanchorDeps {
  /** The revision being displayed now. `undefined` disables the mapping. */
  current(): Promise<string | undefined>;
  /** Lines of `file` at `revision`, or `undefined` when it cannot be read. */
  annotate(revision: string, file: string): Promise<readonly AnnotatedLike[] | undefined>;
  /** What changed between two revisions. */
  diff(
    from: string,
    to: string,
  ): Promise<{ files: Map<string, Hunk[]>; renames: Map<string, string> } | undefined>;
}

/**
 * Find where a comment's lines went, by diffing the revision it was written
 * against with the revision on screen.
 *
 * Returns `undefined` — never a guess — when: there is no recorded revision (a
 * comment older than the field), the file cannot be read at that revision, the
 * anchors do not resolve there, or the file is not in the diff (unchanged, so the
 * ordinary visibility check already answered).
 *
 * A renamed file is followed: the mapping continues under the new path, because a
 * rename is not a reason to lose a review.
 */
export async function reanchor(
  comment: Reanchorable,
  deps: ReanchorDeps,
): Promise<Reanchored | undefined> {
  if (!comment.atRevision || comment.anchors.length === 0) return undefined;
  const current = await deps.current();
  if (!current || current === comment.atRevision) return undefined;

  const before = await deps.annotate(comment.atRevision, comment.file);
  if (!before) return undefined;
  const range = rangeAtRevision(comment.anchors, before);
  if (!range) return undefined;

  const diff = await deps.diff(comment.atRevision, current);
  if (!diff) return undefined;
  const path = diff.renames.get(comment.file) ?? comment.file;
  const hunks = diff.files.get(path);
  if (!hunks || hunks.length === 0) return undefined;

  return { revision: current, successor: mapRange(hunks, range.start, range.end) };
}

/** Where a comment now stands, once the diff has been asked. */
export interface Placement {
  /**
   * `visible` when the text is still there — the fast path merely lost its change
   * id, which is what a rebase or a squash does. `superseded` when the lines were
   * replaced or removed: still open, still reviewable, but no longer pointing at
   * text that exists.
   */
  state: "visible" | "superseded";
  /** Line numbers to highlight in the displayed revision; empty when superseded. */
  positions: number[];
  /** Where it went. Absent only for the trivial case where nothing moved. */
  successor?: Successor & { revision: string };
}

/**
 * Turn a mapped range into the two things a viewer needs: a state and a place to
 * draw.
 *
 * The distinction that matters is *lost* versus *moved*. A comment whose text is
 * still there has been repaired by the mapping; one whose text was rewritten or
 * deleted has been superseded, which is the outcome it asked for — not an orphan.
 */
export function placeComment(anchorCount: number, found: Reanchored): Placement {
  const survives = found.successor.kind === "unchanged" || found.successor.kind === "moved";
  const successor = { ...found.successor, revision: found.revision };
  return {
    state: survives ? "visible" : "superseded",
    positions: survives
      ? Array.from({ length: anchorCount }, (_, index) => found.successor.start + index)
      : [],
    ...(found.successor.kind === "unchanged" ? {} : { successor }),
  };
}

/**
 * The line range a comment occupied in the revision it was written against.
 *
 * `undefined` when an anchor cannot be found there — a selection that was already
 * partly stale when it was made, which is a fact about that comment rather than
 * something to guess about.
 */
export function rangeAtRevision(
  anchors: readonly AnchorLike[],
  annotated: readonly AnnotatedLike[],
): { start: number; end: number } | undefined {
  const found: number[] = [];
  for (const anchor of anchors) {
    const hit = annotated.find(
      (line) =>
        line.changeId === anchor.changeId &&
        line.originalLine === anchor.originalLine &&
        line.content === anchor.content,
    );
    if (!hit) return undefined;
    found.push(hit.line);
  }
  if (found.length === 0) return undefined;
  return { start: Math.min(...found), end: Math.max(...found) };
}
