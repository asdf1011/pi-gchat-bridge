/**
 * A comment on a file the *checkout* holds, not the conversation directory.
 *
 * The deployment this bridge runs in keeps `BRIDGE_ARTIFACTS_DIR` inside a checkout:
 * `<repo>/artifacts/conversation/<id>`. `initArtifactRepo` deliberately does not nest a
 * repository inside an existing one, so the conversation directory belongs to the
 * checkout's repository — and a conversation can therefore hold a comment on
 * `src/durable/host.ts` as well as on `conversation/7/a.sh`.
 *
 * That combination used to refuse every comment with
 * `No such path: <repo>/src/durable/docs/…`: the path was derived by stripping two
 * components off the repository directory, which is only right when the repository *is*
 * the conversation directory. These tests pin the fix at the seam a browser actually
 * reaches, rather than only at the path helper.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { BridgeHost } from "../src/durable/host.js";
import { commitTurn, initArtifactRepo } from "../src/durable/artifact-vcs.js";
import { inProcessSessionHost } from "../src/session-host/inprocess.js";

function haveJj(): boolean {
  try {
    execFileSync("jj", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const skip = haveJj() ? false : "jj not installed";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "comment-in-checkout-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

let counter = 0;

/**
 * A checkout-shaped repository with a conversation directory inside it, and a
 * seam wired the way `durable/main.ts` wires it: one repo for the conversation,
 * and every artifact root in `roots`.
 */
async function deployment(): Promise<{
  seam: ReturnType<typeof inProcessSessionHost>;
  conversationId: number;
  repo: string;
  conversation: string;
  parent: string;
}> {
  // `<parent>/checkout`, and `parent` is a root but *not* a repository — the shape of
  // `PI_CWD=/workspace` with the checkout one level below it. A key written against
  // the parent (`checkout/docs/planning/plan.md`) is then correct and yet cannot be
  // resolved by asking the parent, which is the case that refused a comment.
  const parent = path.join(scratch, `parent-${++counter}`);
  const checkout = path.join(parent, "checkout");
  fs.mkdirSync(path.join(checkout, "docs/planning"), { recursive: true });
  fs.mkdirSync(path.join(checkout, "artifacts/conversation/7"), { recursive: true });
  await initArtifactRepo(checkout);

  fs.writeFileSync(path.join(checkout, "docs/planning/plan.md"), "# Plan\n\nThe job.\n");
  fs.writeFileSync(path.join(checkout, "artifacts/conversation/7/a.sh"), "echo hi\n");
  assert.ok(await commitTurn(checkout, 1));

  const harness = await Harness.open(
    new MemoryStorage(),
    { models: createModels(), registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  harness.resume();
  const host = Object.create(BridgeHost.prototype) as BridgeHost;
  Object.assign(host, {
    harness,
    context: BACKGROUND_CONTEXT,
    modelRuntime: {
      getModel: () => undefined,
      getModels: () => [],
      getAllAvailable: async () => [],
    } as unknown as ModelRuntime,
    cwd: checkout,
    dbPath: ":memory:",
    pending: new Map(),
  });

  const conversation = path.join(checkout, "artifacts/conversation/7");
  const seam = inProcessSessionHost({
    host,
    // The parent first, as `PI_CWD` is: it is a root the origin keys files against,
    // and it is not a repository, which is exactly what has to be survived.
    roots: [parent, path.join(checkout, "artifacts"), checkout],
    artifactRepoFor: () => conversation,
  });
  const created = await host.createNamed("threads/A", { model: { provider: "p", modelId: "m" } });
  return { seam, conversationId: created.conversationId, repo: checkout, conversation, parent };
}

test("a comment on a file in the checkout is accepted and anchors to a real line", { skip }, async () => {
  const { seam, conversationId } = await deployment();

  const created = await seam.addComment(conversationId, {
    file: "docs/planning/plan.md",
    selection: { line: 3 },
    text: "who is this for?",
  });
  assert.ok("comment" in created, `expected a comment, got ${JSON.stringify(created)}`);
  assert.equal(created.comment.file, "docs/planning/plan.md");
  assert.equal(created.comment.anchors.length, 1);
  assert.equal(created.comment.anchors[0]!.content, "The job.", "anchored to the line that was named");

  const listed = await seam.comments(conversationId);
  assert.equal(listed?.[0]?.state, "visible");
  assert.deepEqual(listed?.[0]?.positions, [3]);

  // A quote instead of a line number has to land in the same place: a rendered
  // document reports text, and the host is what turns it into an address.
  const quoted = await seam.addComment(conversationId, {
    file: "docs/planning/plan.md",
    selection: { quote: "The job." },
    text: "and this heading?",
  });
  assert.ok("comment" in quoted);
  assert.equal(quoted.comment.anchors[0]!.content, "The job.");
});

test("a comment on the conversation's own file still works", { skip }, async () => {
  const { seam, conversationId } = await deployment();
  const created = await seam.addComment(conversationId, {
    file: "conversation/7/a.sh",
    selection: { line: 1 },
    text: "is this the right script?",
  });
  assert.ok("comment" in created, `expected a comment, got ${JSON.stringify(created)}`);
  assert.equal(created.comment.anchors[0]!.content, "echo hi");
});

test("a comment on a file no repository holds is refused with a reason", { skip }, async () => {
  const { seam, conversationId } = await deployment();
  const created = await seam.addComment(conversationId, {
    file: "docs/planning/not-a-file.md",
    selection: { line: 1 },
    text: "nothing here",
  });
  assert.ok("error" in created);
  assert.match(created.error, /cannot annotate docs\/planning\/not-a-file\.md/);
  assert.doesNotMatch(created.error, /No such path/, "the refusal is the host's, not jj's");
});

test("a key written against a non-repository parent still resolves", { skip }, async () => {
  // The deployment's actual key: relative to `PI_CWD`, which is the parent of the
  // checkout and is not itself a repository. Asking the parent for the file answers
  // "not a repository"; asking the conversation's repo answers "no such path". The
  // key has to be turned into a path first, and the repository found from there.
  const { seam, conversationId } = await deployment();

  const created = await seam.addComment(conversationId, {
    file: "checkout/docs/planning/plan.md",
    selection: { line: 3 },
    text: "keyed against the parent",
  });
  assert.ok("comment" in created, `expected a comment, got ${JSON.stringify(created)}`);
  assert.equal(created.comment.anchors[0]!.content, "The job.");
});
