/**
 * Mapping a commented range through the revision that changed it.
 *
 * The cases here are the ones a review actually produces: the line was edited, it
 * was deleted, it survived but moved, or the file was renamed. A comment that asked
 * for a change and got one must not be reported as lost, which is what these tests
 * are about — the difference between "your note is orphaned" and "your note is now
 * about this".
 *
 * Pure: text in, data out. The jj end of it is proven in `artifact-vcs.test.ts`
 * against real repositories, because parsing a diff nobody generated would prove
 * only that the strings were joined correctly.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  mapRange,
  parseRevisionDiff,
  placeComment,
  rangeAtRevision,
  reanchor,
  type AnnotatedLike,
  type Hunk,
} from "../src/durable/successor.js";

const DIFF = [
  "diff --git a/a.md b/a.md",
  "index 111..222 100644",
  "--- a/a.md",
  "+++ b/a.md",
  "@@ -3,1 +3,1 @@ # Title",
  "-the crumbs were enough",
  "+the mutant mice were enough",
  "@@ -9,2 +9,0 @@ # Title",
  "-a line that went",
  "-another that went",
  "",
].join("\n");

test("a git diff parses into hunks with their own text on each side", () => {
  const { files, renames } = parseRevisionDiff(DIFF);
  const hunks = files.get("a.md") as Hunk[];
  assert.equal(hunks.length, 2);
  assert.deepEqual(hunks[0], {
    oldStart: 3,
    oldCount: 1,
    newStart: 3,
    newCount: 1,
    removed: ["the crumbs were enough"],
    added: ["the mutant mice were enough"],
  });
  // A pure deletion: nothing on the new side, and the old side says how much went.
  assert.equal(hunks[1]!.newCount, 0);
  assert.deepEqual(hunks[1]!.removed, ["a line that went", "another that went"]);
  assert.equal(renames.size, 0);
});

test("a rename is reported as a path mapping, not as a lost file", () => {
  const { files, renames } = parseRevisionDiff(
    [
      "diff --git a/old.md b/new.md",
      "rename from old.md",
      "rename to new.md",
      "--- a/old.md",
      "+++ b/new.md",
      "@@ -2,1 +2,1 @@ x",
      "-one",
      "+two",
    ].join("\n"),
  );
  assert.equal(renames.get("old.md"), "new.md");
  assert.equal(files.get("new.md")?.length, 1, "hunks belong to the path it now has");
});

test("the edited line is replaced by the section that stands in its place", () => {
  const { files } = parseRevisionDiff(DIFF);
  const mapped = mapRange(files.get("a.md") ?? [], 3, 3);
  assert.equal(mapped.kind, "replaced");
  assert.deepEqual([mapped.start, mapped.end], [3, 3]);
  // The new text is carried, so a drawer can show what the note is about now.
  assert.equal(mapped.quote, "the mutant mice were enough");
});

test("a deleted line leaves a gap, and says where the gap is", () => {
  const { files } = parseRevisionDiff(DIFF);
  // Old lines 9-10 were removed. `@@ -9,2 +9,0 @@` means the deletion sits *after*
  // new line 9, so the gap is at 10 — "insert here", which is a real position.
  const mapped = mapRange(files.get("a.md") ?? [], 9, 10);
  assert.equal(mapped.kind, "removed");
  assert.equal(mapped.start, 10);
  assert.ok(mapped.end < mapped.start, "an empty range, not a line that does not exist");
  assert.equal(mapped.quote, undefined);
});

test("an untouched line moves by the edits above it, and keeps its text", () => {
  const hunks: Hunk[] = [
    { oldStart: 2, oldCount: 0, newStart: 3, newCount: 2, removed: [], added: ["new", "lines"] },
  ];
  const mapped = mapRange(hunks, 5, 5);
  assert.equal(mapped.kind, "moved");
  assert.deepEqual([mapped.start, mapped.end], [7, 7]);
  assert.equal(mapRange([], 5, 5).kind, "unchanged");
});

test("an insertion between lines does not count as replacing the line below it", () => {
  // `@@ -2,0 +3,1 @@` is "one line added after old line 2": the line the reviewer
  // commented on (old 3) is untouched and simply shifted down.
  const hunks: Hunk[] = [{ oldStart: 2, oldCount: 0, newStart: 3, newCount: 1, removed: [], added: ["x"] }];
  const mapped = mapRange(hunks, 3, 3);
  assert.equal(mapped.kind, "moved");
  assert.deepEqual([mapped.start, mapped.end], [4, 4]);
});

test("a range spanning two hunks becomes one section", () => {
  const hunks: Hunk[] = [
    { oldStart: 4, oldCount: 2, newStart: 4, newCount: 3, removed: ["a", "b"], added: ["A", "B", "C"] },
    { oldStart: 7, oldCount: 1, newStart: 8, newCount: 2, removed: ["c"], added: ["D", "E"] },
  ];
  const mapped = mapRange(hunks, 5, 7);
  assert.equal(mapped.kind, "replaced");
  // From the first hunk's new start to the last hunk's new end: the region that
  // stands where the selection stood.
  assert.deepEqual([mapped.start, mapped.end], [4, 9]);
  assert.equal(mapped.quote, "A\nB\nC\nD\nE");
});

test("a comment's range is located in the revision it was written against", () => {
  const annotated: AnnotatedLike[] = [
    { changeId: "aaa", originalLine: 1, line: 1, content: "one" },
    { changeId: "bbb", originalLine: 1, line: 2, content: "two" },
    { changeId: "bbb", originalLine: 2, line: 3, content: "three" },
  ];
  // Anchors carry the change id and *that revision's* line number, so the range has
  // to be resolved — not assumed from the anchor order.
  assert.deepEqual(
    rangeAtRevision(
      [
        { changeId: "bbb", originalLine: 1, content: "two" },
        { changeId: "bbb", originalLine: 2, content: "three" },
      ],
      annotated,
    ),
    { start: 2, end: 3 },
  );
  // An anchor that does not resolve there is a stale selection, not a range.
  assert.equal(rangeAtRevision([{ changeId: "ccc", originalLine: 1, content: "gone" }], annotated), undefined);
});

test("a comment whose text survived is repaired, not superseded", () => {
  // A rebase or a squash rewrites change ids without touching content. The anchor
  // no longer matches, and the comment is not lost — it is where it always was.
  const placed = placeComment(1, {
    revision: "now",
    successor: { kind: "unchanged", start: 4, end: 4 },
  });
  assert.equal(placed.state, "visible");
  assert.deepEqual(placed.positions, [4]);
  assert.equal(placed.successor, undefined, "nothing moved, so nothing to report");
});

test("a comment on a replaced line is superseded, and carries where it went", () => {
  const placed = placeComment(2, {
    revision: "now",
    successor: { kind: "replaced", start: 7, end: 9, quote: "a\nb\nc" },
  });
  // Superseded, but not orphaned: "your note is about this new text now" is a thing
  // a reader can act on, and it is the outcome the comment asked for.
  assert.equal(placed.state, "superseded");
  assert.deepEqual(placed.positions, [], "nothing of the old lines is on screen");
  assert.deepEqual(placed.successor, { kind: "replaced", start: 7, end: 9, quote: "a\nb\nc", revision: "now" });
});

test("a comment whose line was deleted is superseded, pointing at the gap", () => {
  const placed = placeComment(1, { revision: "now", successor: { kind: "removed", start: 10, end: 9 } });
  assert.equal(placed.state, "superseded");
  assert.equal(placed.successor?.start, 10);
  assert.ok((placed.successor?.end ?? 0) < (placed.successor?.start ?? 0));
});

test("re-anchoring needs a recorded revision, and refuses to guess without one", async () => {
  const deps = {
    current: async () => "now",
    annotate: async () => [{ changeId: "c", originalLine: 1, line: 1, content: "x" }],
    diff: async () => ({ files: new Map([["a.md", []]]), renames: new Map<string, string>() }),
  };
  // A comment older than the field: the diff could be run from *somewhere*, but
  // which somewhere is exactly what is unknown, so nothing is claimed.
  assert.equal(await reanchor({ file: "a.md", anchors: [{ changeId: "c", originalLine: 1, content: "x" }] }, deps), undefined);
});

test("a renamed file is followed into its new path", async () => {
  const annotated: AnnotatedLike[] = [{ changeId: "c", originalLine: 5, line: 5, content: "old text" }];
  const hunks: Hunk[] = [{ oldStart: 5, oldCount: 1, newStart: 5, newCount: 1, removed: ["old text"], added: ["new text"] }];
  const found = await reanchor(
    { file: "old.md", anchors: [{ changeId: "c", originalLine: 5, content: "old text" }], atRevision: "was" },
    {
      current: async () => "now",
      annotate: async () => annotated,
      diff: async () => ({ files: new Map([["new.md", hunks]]), renames: new Map([["old.md", "new.md"]]) }),
    },
  );
  assert.equal(found?.revision, "now");
  assert.equal(found?.successor.kind, "replaced");
  assert.equal(found?.successor.quote, "new text");
});

test("an unchanged file yields no successor, because the fast path already answered", async () => {
  const found = await reanchor(
    { file: "a.md", anchors: [{ changeId: "c", originalLine: 1, content: "x" }], atRevision: "was" },
    {
      current: async () => "now",
      annotate: async () => [{ changeId: "c", originalLine: 1, line: 1, content: "x" }],
      diff: async () => ({ files: new Map(), renames: new Map<string, string>() }),
    },
  );
  assert.equal(found, undefined);
});
