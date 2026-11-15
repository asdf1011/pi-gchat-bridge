/**
 * The review subagent: a child conversation, and what comes back from it.
 *
 * Two things are worth testing and neither is the model call. One is that a
 * review's conversation is *owned* by the tool call's task — that is what makes
 * it resumable after a restart and what `inspect()`/the task graph show — and the
 * other is that the parent gets the child's answer rather than its transcript.
 *
 * The child here is written to directly, which is exactly what the tool's
 * report-back path reads. Everything else about the tool — the replay-safe
 * commit, the submission, the request id that stops a rerun from reviewing twice
 * — is pi-durable's behaviour, already covered upstream.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  configure,
  defineExtension,
  defineTask,
  Harness,
  MemoryStorage,
  createRegistry,
  type Extension,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { BridgeHost } from "../src/durable/host.js";
import { createReviewAgent } from "../src/durable/extensions/review-agent.js";

async function memoryHost(): Promise<BridgeHost> {
  // Installed, not merely named: `configure()` stores extension *names*, and a name
  // the registry does not hold resolves to nothing without saying so.
  const registry = createRegistry();
  registry.install(Marker);
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: createModels(), registry },
    BACKGROUND_CONTEXT,
  );
  harness.resume();
  const host = Object.create(BridgeHost.prototype) as BridgeHost;
  Object.assign(host, {
    harness,
    context: BACKGROUND_CONTEXT,
    modelRuntime: { getModel: () => undefined, getModels: () => [], getAllAvailable: async () => [] } as unknown as ModelRuntime,
    cwd: "/tmp",
    dbPath: ":memory:",
    pending: new Map(),
  });
  return host;
}

function background(): Context {
  return BACKGROUND_CONTEXT;
}

/** A task a child conversation can be owned by. It commits terminal at once and nothing waits on it. */
const OwnerTask = defineTask({
  name: "review-agent-test-owner",
  version: 1,
  initial: () => ({ phase: "done" as const }),
  phases: {
    done: async () => {
      // Nothing to record: the task exists only to own a conversation.
    },
  },
  abort: async () => {
    // Never aborted in this test.
  },
});

/** A marker extension, so the assertion about inheritance names something visible. */
const Marker: Extension = defineExtension({ name: "review-agent-test-marker" });

test("lastAnswer() is the child's own newest answer, not any prose above it", async () => {
  const host = await memoryHost();
  const created = await host.createNamed("threads/R", { model: { provider: "p", modelId: "m" } });
  const id = created.conversationId;

  assert.equal(await host.lastAnswer(id), undefined, "nothing said yet");

  await host.writeEntry(id, {
    kind: "app.notice",
    data: {},
    model: [{ role: "user", content: "review the pending change" }],
  });
  // One entry per model message, which is what a turn produces: an entry carrying
  // both the question and the answer would be one turn whose "answer" is the
  // question, and the reader under test would pass or fail for the wrong reason.
  await host.writeEntry(id, {
    kind: "app.notice",
    data: {},
    model: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "let me look at the diff" },
          { type: "text", text: "Reviewed src/a.ts; four comments." },
        ],
      },
    ],
  });

  assert.equal(await host.lastAnswer(id), "Reviewed src/a.ts; four comments.");

  // A later turn with no text at all must not erase the answer that does exist.
  await host.writeEntry(id, {
    kind: "app.notice",
    data: {},
    model: [{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }] }],
  });
  assert.equal(await host.lastAnswer(id), "Reviewed src/a.ts; four comments.");

  assert.equal(await host.lastAnswer(999_999), undefined, "an unknown conversation has no answer");
  await host.harness.close(BACKGROUND_CONTEXT);
});

test("a task-owned child starts from its owner's agent and with no history of its own", async () => {
  const host = await memoryHost();
  const parentId = (await host.createNamed("threads/P", { model: { provider: "p", modelId: "m" } })).conversationId;
  const parent = await host.harness.conversation(parentId as never, background());
  assert.ok(parent);
  // The parent is what the child copies, so the marker goes on the parent. It is
  // not in the host's default selection, so the child inheriting it is a fact
  // about the copy rather than about what everything gets anyway.
  await parent.commit((tx) => configure(tx, parentId as never, { extensions: { add: [Marker] } }), background());

  // Created the way the tool creates one: inside a commit, owned by a task, then
  // configured with only the differences. A test cannot be inside a *tool call's*
  // task, so the owner is an ordinary task of the parent — it owns the child just
  // as well, and it is the ownership, not the task's kind, that is under test.
  const owner = await parent.commit(
    (tx) => tx.createTask(OwnerTask, {}, { ownership: { kind: "conversation" } }),
    background(),
  );

  const childId = await parent.commit(async (tx) => {
    const created = await tx.createConversation({ ownership: { kind: "task", taskId: owner } });
    await configure(tx, created.id, { instructions: "You are reviewing a pending change." });
    return created.id;
  }, background());

  const child = await host.harness.conversation(childId, background());
  assert.ok(child, "the child exists");

  const agent = await child.agent(background());
  assert.deepEqual(agent.model, { provider: "p", modelId: "m" }, "the model is inherited, not restated");
  assert.ok(
    agent.extensions.some((extension) => extension.name === "review-agent-test-marker"),
    "the child's extensions are the parent's, plus whatever was added",
  );
  assert.equal(
    (await child.context(background())).entries.length,
    0,
    "the child sees none of the parent's transcript",
  );

  // And the ownership is durable, which is what a restart resumes on.
  const record = (await host.harness.inspect(background())).tasks.find(
    (entry) => entry.record.id === owner,
  );
  assert.ok(record, "the owner is a live task the harness knows about");
  await host.harness.close(BACKGROUND_CONTEXT);
});

test("an empty brief is refused, and nothing is spawned", async () => {
  const replies: string[] = [];
  const extension = createReviewAgent({
    lastAnswer: async () => "summary",
    reply: async (_conversationId, commentId, text) => {
      replies.push(`${commentId}:${text}`);
      return { id: commentId };
    },
  });

  const tool = (extension.tools ?? []).find((candidate) => candidate.name === "review_change");
  assert.ok(tool, "the extension offers review_change");

  // A whitespace-only brief is refused before a conversation exists: an empty
  // review would spend a whole child conversation on nothing.
  const refused = (await (tool as unknown as {
    execute(args: { brief: string }, api: never, context: never): Promise<{ isError?: boolean }>;
  }).execute({ brief: "   " }, {} as never, background() as never)) as { isError?: boolean };
  assert.equal(refused.isError, true);
  assert.deepEqual(replies, [], "the reply writer is not called");
});
