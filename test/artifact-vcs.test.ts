/**
 * Version control over a conversation's artifact directory.
 *
 * These run against real jj repositories in a temporary tree. The whole point is
 * that history is real — a fake would prove only that the strings were joined
 * correctly, not that a comment still resolves after a turn changed the file.
 *
 * Skipped wholesale when jj is not installed, because a missing jj is a
 * deployment fact, not a test failure.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  annotate,
  changedFiles,
  classifyComments,
  commitTurn,
  currentRevision,
  initArtifactRepo,
  orphanedComments,
  revisionDiff,
  showFile,
  type ArtifactComment,
} from "../src/durable/artifact-vcs.js";
import { reanchor } from "../src/durable/successor.js";
import { conversationArtifactDir } from "../src/durable/extensions/artifact-guidance.js";

function haveJj(): boolean {
  try {
    execFileSync("jj", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const JJ = haveJj();
const skip = JJ ? false : "jj not installed";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-vcs-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
/** A fresh, empty directory name, unique per test. */
function freshDir(name: string): string {
  return path.join(scratch, `${name}-${++counter}`);
}

/**
 * An initialised repository, unique per test.
 *
 * `jj git init --colocate` plus the initial commit costs about a second, and thirteen tests each
 * paying it was most of this file's wall time. So it is built once and copied: a copy is a real,
 * independent repository — `.jj` and `.git` are ordinary files — and `initArtifactRepo` on it is the
 * documented no-op. The one test that is *about* initialisation uses `freshDir` and builds its own.
 */
let template: string | undefined;
async function repo(name: string): Promise<string> {
  if (!template) {
    template = path.join(scratch, "template");
    await initArtifactRepo(template);
  }
  const dir = freshDir(name);
  fs.cpSync(template, dir, { recursive: true });
  return dir;
}

function write(dir: string, file: string, body: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), body, "utf8");
}

test("init creates a repository once, and again is a no-op", { skip }, async () => {
  const dir = freshDir("init");
  assert.equal(await initArtifactRepo(dir), true);
  assert.ok(fs.existsSync(path.join(dir, ".jj")));

  // A second call must not throw and must leave the existing history alone.
  write(dir, "a.sh", "echo hi\n");
  const first = await commitTurn(dir, 1);
  assert.ok(first, "a turn that wrote a file should produce a revision");

  assert.equal(await initArtifactRepo(dir), true);
  const log = execFileSync("jj", ["log", "--no-graph", "-T", "description.first_line() ++ \"\\n\""], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.ok(log.includes("turn 1"), "re-init must not discard history");
});

test("a turn that changes nothing creates no revision", { skip }, async () => {
  const dir = await repo("noop");
  // Nothing written: the working copy is clean, so there is nothing to describe.
  assert.equal(await commitTurn(dir, 7), undefined);

  const log = execFileSync("jj", ["log", "--no-graph", "-T", "description.first_line() ++ \"\\n\""], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.ok(!log.includes("turn 7"), "an idle turn must not add a revision");
});

test("each changing turn becomes its own revision, described with the turn id", { skip }, async () => {
  const dir = await repo("turns");

  write(dir, "a.sh", "echo one\n");
  const first = await commitTurn(dir, 11);
  write(dir, "a.sh", "echo one\necho two\n");
  const second = await commitTurn(dir, 12);

  assert.ok(first);
  assert.ok(second);
  assert.notEqual(first, second, "two changing turns are two change ids");

  const log = execFileSync("jj", ["log", "--no-graph", "-T", "description.first_line() ++ \"\\n\""], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.ok(log.includes("turn 11"));
  assert.ok(log.includes("turn 12"));
});

test("annotate reports the change id that introduced each line", { skip }, async () => {
  const dir = await repo("annotate");

  write(dir, "a.sh", "echo one\n");
  const created = await commitTurn(dir, 21);
  write(dir, "a.sh", "echo one\necho TWO\n");
  const edited = await commitTurn(dir, 22);
  assert.ok(created && edited);

  const lines = await annotate(dir, edited, "a.sh");
  assert.equal(lines.length, 2);
  assert.equal(lines[0]!.line, 1);
  assert.equal(lines[0]!.content, "echo one");
  // The untouched line keeps the earlier change; the new line belongs to the edit.
  assert.equal(lines[0]!.changeId, created);
  assert.equal(lines[1]!.changeId, edited);
  assert.equal(lines[1]!.content, "echo TWO");
});

test("a comment is visible while its line is unchanged, orphaned once it is not", { skip }, async () => {
  const dir = await repo("classify");

  write(dir, "a.sh", "echo one\necho two\n");
  const created = await commitTurn(dir, 31);
  assert.ok(created);

  const comment: ArtifactComment = {
    id: "c1",
    file: "a.sh",
    anchors: [{ changeId: created, originalLine: 2, content: "echo two" }],
    text: "this should be quoted",
    at: Date.now(),
  };

  // Against the revision it was written on: visible.
  const atCreation = await annotate(dir, created, "a.sh");
  let resolved = classifyComments([comment], new Map([["a.sh", atCreation]]));
  assert.equal(resolved[0]!.state, "visible");

  // Rewrite that line: the comment no longer matches any annotation.
  write(dir, "a.sh", "echo one\necho 'two'\n");
  const rewritten = await commitTurn(dir, 32);
  assert.ok(rewritten);
  const atRewrite = await annotate(dir, rewritten, "a.sh");
  resolved = classifyComments([comment], new Map([["a.sh", atRewrite]]));
  assert.equal(resolved[0]!.state, "orphaned");

  // Orphaned is not resolved: it must still be reported as open.
  assert.equal(orphanedComments([...resolved]).length, 1);
});

test("a comment whose line an agent rewrote is mapped to the section that replaced it", { skip }, async () => {
  // The whole point of a review comment is to change the line, so "the line is
  // gone" is the *successful* outcome. History knows where it went; this is that
  // answer, against a real repository.
  const dir = await repo("successor");

  write(dir, "a.sh", "echo one\necho two\necho three\n");
  const first = await commitTurn(dir, 51);
  assert.ok(first);

  const lines = await annotate(dir, first, "a.sh");
  const atRevision = await currentRevision(dir);
  assert.ok(atRevision, "the working-copy revision is readable");

  const comment: ArtifactComment = {
    id: "c3",
    file: "a.sh",
    anchors: [lines[1]!].map((line) => ({
      changeId: line.changeId,
      originalLine: line.originalLine,
      content: line.content,
    })),
    text: "this should be quoted",
    at: Date.now(),
    atRevision,
  };

  write(dir, "a.sh", "echo one\necho 'two'\necho three\n");
  assert.ok(await commitTurn(dir, 52));

  // Annotation now says nothing about it: the line was rewritten, so its change id
  // changed and the ordinary visibility check fails.
  const resolved = classifyComments([comment], new Map([["a.sh", await annotate(dir, "@", "a.sh")]]));
  assert.equal(resolved[0]!.state, "orphaned");

  // The diff says exactly where it went.
  const found = await reanchor(
    { file: comment.file, anchors: comment.anchors, atRevision },
    {
      current: () => currentRevision(dir),
      annotate: (revision, file) => annotate(dir, revision, file).catch(() => undefined),
      diff: (from, to) => revisionDiff(dir, from, to).catch(() => undefined),
    },
  );
  assert.equal(found?.successor.kind, "replaced");
  assert.deepEqual([found?.successor.start, found?.successor.end], [2, 2]);
  assert.equal(found?.successor.quote, "echo 'two'");
});

test("a comment mapped through a rename keeps its place in the new path", { skip }, async () => {
  const dir = await repo("successor-rename");

  // Ten lines, not two: rename detection is a similarity judgement, and a two-line
  // file with one line changed is legitimately below the threshold — jj then reports
  // a deletion and an addition, and "the file you reviewed is gone" is the honest
  // answer. A file worth reviewing is long enough for the rename to be recognised.
  const body = Array.from({ length: 10 }, (_, index) => `echo line-${index + 1}`).join("\n") + "\n";
  write(dir, "old.sh", body);
  const first = await commitTurn(dir, 53);
  assert.ok(first);
  const lines = await annotate(dir, first, "old.sh");
  const atRevision = await currentRevision(dir);

  // Rename and edit in one turn: the file the comment names no longer exists, which
  // used to be the end of the story.
  fs.renameSync(path.join(dir, "old.sh"), path.join(dir, "new.sh"));
  write(dir, "new.sh", body.replace("echo line-5", "echo 'line-5'"));
  assert.ok(await commitTurn(dir, 54));

  const found = await reanchor(
    {
      file: "old.sh",
      // The anchor is on the line the turn changed (line 5 of ten), which is what a
      // reviewer would have commented on.
      anchors: [
        { changeId: lines[4]!.changeId, originalLine: lines[4]!.originalLine, content: lines[4]!.content },
      ],
      atRevision,
    },
    {
      current: () => currentRevision(dir),
      annotate: (revision, file) => annotate(dir, revision, file).catch(() => undefined),
      diff: (from, to) => revisionDiff(dir, from, to).catch(() => undefined),
    },
  );
  assert.equal(found?.successor.kind, "replaced");
  assert.equal(found?.successor.quote, "echo 'line-5'");
});

test("a deleted line orphans its comment rather than dropping it", { skip }, async () => {
  const dir = await repo("deleted");

  write(dir, "a.sh", "echo one\necho two\necho three\n");
  const created = await commitTurn(dir, 41);
  assert.ok(created);

  const comment: ArtifactComment = {
    id: "c2",
    file: "a.sh",
    anchors: [{ changeId: created, originalLine: 2, content: "echo two" }],
    text: "drop this line",
    at: Date.now(),
  };

  // The line the comment named is gone entirely. Annotation cannot prove the
  // comment is stale, so it must survive as orphaned, not vanish.
  write(dir, "a.sh", "echo one\necho three\n");
  const after = await commitTurn(dir, 42);
  assert.ok(after);
  const lines = await annotate(dir, after, "a.sh");

  const resolved = classifyComments([comment], new Map([["a.sh", lines]]));
  assert.equal(resolved[0]!.state, "orphaned");
  assert.equal(orphanedComments([...resolved]).length, 1);
});

test("a line sliding into a deleted line's position does not resurrect its comment", { skip }, async () => {
  const dir = await repo("slide");

  write(dir, "a.sh", "echo one\necho two\necho three\n");
  const created = await commitTurn(dir, 61);
  assert.ok(created);

  // The comment names line 2 of turn 61. Deleting that line pulls `echo three`
  // up into position 2 — and `echo three` is *also* from turn 61, so change id
  // and line number both still match. Only the content distinguishes them.
  const comment: ArtifactComment = {
    id: "c3",
    file: "a.sh",
    anchors: [{ changeId: created, originalLine: 2, content: "echo two" }],
    text: "this line is wrong",
    at: Date.now(),
  };

  write(dir, "a.sh", "echo one\necho three\n");
  const after = await commitTurn(dir, 62);
  assert.ok(after);
  const lines = await annotate(dir, after, "a.sh");

  // Sanity: the trap is real — position 2 is still attributed to turn 61.
  assert.equal(lines[1]!.changeId, created);
  assert.equal(lines[1]!.line, 2);

  const resolved = classifyComments([comment], new Map([["a.sh", lines]]));
  assert.equal(
    resolved[0]!.state,
    "orphaned",
    "a different line occupying the same number is not the same comment",
  );
});

test("an explicitly resolved comment stays resolved even if its line is live", { skip }, async () => {
  const dir = await repo("resolved");
  write(dir, "a.sh", "echo one\n");
  const created = await commitTurn(dir, 51);
  assert.ok(created);

  const comment: ArtifactComment = {
    id: "c4",
    file: "a.sh",
    anchors: [{ changeId: created, originalLine: 1, content: "echo one" }],
    text: "done",
    at: Date.now(),
    resolved: true,
  };
  const lines = await annotate(dir, created, "a.sh");
  const resolved = classifyComments([comment], new Map([["a.sh", lines]]));
  assert.equal(resolved[0]!.state, "resolved");
  assert.equal(orphanedComments([...resolved]).length, 0);
});

test("the artifact directory is a deployment choice, not a repo in the cwd", () => {
  // The path the prompt names must be the path the session host commits.
  assert.equal(conversationArtifactDir("/srv/artifacts", 42), "/srv/artifacts/conversation/42");
});

test("a line pushed down by an insertion above it keeps its comment", { skip }, async () => {
  // The claim the whole anchor design rests on. `line_number` alone would fail
  // here — the comment was written against line 2 and now lives at line 4 — so
  // the anchor names the revision's own line number instead.
  const dir = await repo("shift");

  write(dir, "a.sh", "echo one\necho two\n");
  const created = await commitTurn(dir, 71);
  assert.ok(created);

  const comment: ArtifactComment = {
    id: "shift",
    file: "a.sh",
    anchors: [{ changeId: created, originalLine: 2, content: "echo two" }],
    text: "does this need quoting?",
    at: Date.now(),
  };

  // Two lines inserted above: the commented line is untouched, and has moved.
  write(dir, "a.sh", "# header\n# more header\necho one\necho two\n");
  const after = await commitTurn(dir, 72);
  assert.ok(after);
  const lines = await annotate(dir, after, "a.sh");
  assert.equal(lines[3]!.line, 4, "the line really did move");
  assert.equal(lines[3]!.changeId, created, "and still belongs to the revision that wrote it");

  const resolved = classifyComments([comment], new Map([["a.sh", lines]]));
  assert.equal(resolved[0]!.state, "visible", "an insertion above must not orphan a review");
  assert.deepEqual(resolved[0]!.positions, [4], "and it reports where to draw the highlight");
});

test("the file at a revision is the file that revision held", { skip }, async () => {
  const dir = await repo("show");
  write(dir, "a.sh", "echo one\n");
  const first = await commitTurn(dir, 81);
  write(dir, "a.sh", "echo one\necho two\n");
  const second = await commitTurn(dir, 82);
  assert.ok(first && second);

  assert.equal(await showFile(dir, first, "a.sh"), "echo one\n");
  assert.equal(await showFile(dir, second, "a.sh"), "echo one\necho two\n");
  // Which is the point: a comment can be shown against the text it was written on.
  assert.deepEqual(await changedFiles(dir, second), ["a.sh"]);
});
