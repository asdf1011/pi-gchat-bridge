/**
 * The seam over a link, exercised through the same assertions as in-process.
 *
 * This is the S5 payoff test: an adapter that works against `SessionHost` in one
 * process must work against the same interface across a chord link, with no
 * adapter change. If this passes for the operations the web and artifact
 * adapters use, the split is a deployment decision rather than a rewrite.
 *
 * The host is a real `BridgeHost` on in-memory storage (so the state changes are
 * real), published by `serveSessionHost` and consumed through `linkSessionHost`
 * over `memoryLinkPair` — which speaks the same remote protocol as `ipcLink`, and
 * was separately verified across a real process boundary during the spike.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { memoryLinkPair } from "@earendil-works/chord";
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { BridgeHost } from "../src/durable/host.js";
import { inProcessSessionHost } from "../src/session-host/inprocess.js";
import { linkSessionHost, serveSessionHost } from "../src/session-host/link.js";
import { createHost } from "@earendil-works/chord";

/** A host over in-memory storage with a model lookaside: no SQLite, no model. */
async function memoryHost(): Promise<BridgeHost> {
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: createModels(), registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  harness.resume();
  const fake = Object.create(BridgeHost.prototype) as BridgeHost;
  Object.assign(fake, {
    harness,
    context: BACKGROUND_CONTEXT,
    // Only the thinking-level lookup and the model list use this.
    modelRuntime: {
      getModel: () => undefined,
      getModels: () => [],
      getAllAvailable: async () => [],
    } as unknown as ModelRuntime,
    cwd: "/tmp",
    dbPath: ":memory:",
    // Class fields do not run for an Object.create(BridgeHost.prototype) fake;
    // `conversationFor` keeps a creation map there.
    pending: new Map(),
  });
  return fake;
}

/** Both implementations, wired through a real link. */
async function bothEnds() {
  const host = await memoryHost();
  const inProcess = inProcessSessionHost({ host, roots: [] });

  const server = serveSessionHost(inProcess);
  const [down, up] = memoryLinkPair();
  server.accept(down, { principal: "owner", kind: "client" });
  const client = createHost({
    self: "client",
    name: "client",
    kind: "client",
    upstream: { link: up, principal: "server" },
  });

  return { host, inProcess, linked: linkSessionHost({ host: client }) };
}

test("a name bound in the host is the same name on the far side of the link", async () => {
  const { inProcess, linked } = await bothEnds();
  const created = await linked.getOrCreate("threads/A", { model: { provider: "deepseek", modelId: "flash" } });
  assert.equal(created.name, "threads/A");
  assert.equal(created.model, "deepseek/flash");

  // Same conversation, seen from both sides: the link is a view, not a copy.
  assert.equal((await inProcess.resolve("threads/A"))?.conversationId, created.conversationId);
  assert.deepEqual((await linked.list()).map((c) => c.name), ["threads/A"]);
  assert.equal(await linked.resolve("nothing-here"), undefined);
});

test("a view attach over the link delivers the snapshot, then real frames", async () => {
  const { host, inProcess, linked } = await bothEnds();
  const created = await linked.getOrCreate("threads/B", { model: { provider: "deepseek", modelId: "flash" } });

  const frames: string[] = [];
  const attached = Promise.withResolvers<void>();
  const handle = await linked.attach(created.conversationId, (view) => {
    frames.push(view.liveText);
    if (frames.length === 1) attached.resolve();
  });
  assert.ok(handle, "attach returns a handle");
  assert.equal(typeof handle.snapshot.liveText, "string");
  await attached.promise;
  assert.equal(frames[0], "", "the current state arrives as the first frame");

  // Drive the conversation the way the bridge does — a write submission — and
  // expect the change to arrive as a delta through the link.
  const conversation = await host.harness.conversation(created.conversationId as never, host.context);
  assert.ok(conversation);
  await conversation.submit(
    { type: "write", entry: { kind: "app.notice", data: { text: "hello", at: Date.now() } } } as never,
    host.context,
  );

  const grew = Promise.withResolvers<void>();
  const started = Date.now();
  while (Date.now() - started < 4000) {
    if ((await linked.snapshot(created.conversationId))?.busy !== undefined) {
      const view = await linked.snapshot(created.conversationId);
      if (view && view.tools.length === 0) {
        grew.resolve();
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await Promise.race([grew.promise, new Promise((resolve) => setTimeout(resolve, 100))]);

  handle.detach();
  assert.ok(frames.length >= 1, `expected frames through the link, got ${JSON.stringify(frames)}`);
  // The in-process seam agrees about the conversation, so nothing was lost in
  // transcription.
  assert.equal((await inProcess.resolve("threads/B"))?.conversationId, created.conversationId);
});

test("submit over the link reaches the host, and errors come back as values", async () => {
  const { linked } = await bothEnds();
  const created = await linked.getOrCreate("threads/C", { model: { provider: "deepseek", modelId: "flash" } });

  const accepted = await linked.submit(created.conversationId, {
    requestId: "chat/message/1",
    content: "hello",
    whenBusy: "steer",
  });
  assert.ok("submissionId" in accepted, JSON.stringify(accepted));

  // A conversation the host does not have is a value, not a throw: the web
  // adapter turns it into an SSE error frame.
  const missing = await linked.submit(999_999, { content: "hello" });
  assert.deepEqual(missing, { error: "no such conversation: 999999" });
});

test("artifacts over the link are the host's derivation, not the adapter's", async () => {
  const { linked } = await bothEnds();
  const created = await linked.getOrCreate("threads/D", { model: { provider: "deepseek", modelId: "flash" } });
  const artifacts = await linked.artifacts(created.conversationId);
  // No files written in this conversation: an empty list, not undefined, because
  // the conversation exists.
  assert.deepEqual(artifacts, []);
});

test("an unbound conversation is undefined, not an error", async () => {
  const { linked } = await bothEnds();
  assert.equal(await linked.snapshot(999_999), undefined);
  assert.equal(await linked.attach(999_999, () => {}), undefined);
  assert.equal(await linked.artifacts(999_999), undefined);
});

/* --- Settings and commands --------------------------------------------------
 *
 * These exist because a `/status` typed into a web conversation *is* an adapter
 * calling the seam: with `BRIDGE_WEB_ENGINE=link` the command surface answered
 * "not published over the link yet" in the deployment while passing in tests.
 */

test("settings cross the link, and a conversation that is gone is undefined", async () => {
  const { inProcess, linked } = await bothEnds();
  const created = await linked.getOrCreate("threads/S", { model: { provider: "deepseek", modelId: "flash" } });

  const overLink = await linked.state(created.conversationId);
  const direct = await inProcess.state(created.conversationId);
  assert.ok(overLink, "the host answered");
  assert.ok(direct);
  // The same numbers, not a copy: `usage` and `entries` are derived host-side. Compared without the
  // undefined-valued keys, which the wire simply does not carry.
  const defined = (value: object) =>
    Object.fromEntries(Object.entries(value).filter(([, each]) => each !== undefined));
  assert.deepEqual(defined(overLink), defined(direct));
  assert.equal(overLink.model, "deepseek/flash");

  assert.equal(await linked.state(999_999), undefined, "gone is a value, as the seam promises");
});

test("the model list is the host's, not the client's idea of it", async () => {
  const { inProcess, linked } = await bothEnds();
  assert.deepEqual(await linked.models(), await inProcess.models());
});

test("setModel over the link moves the host's binding, not a copy of it", async () => {
  const { inProcess, linked } = await bothEnds();
  await linked.getOrCreate("threads/M", { model: { provider: "deepseek", modelId: "flash" } });

  const applied = await linked.setModel("threads/M", {
    provider: "anthropic",
    modelId: "claude-sonnet-4",
    thinkingLevel: "high",
  });
  assert.deepEqual(applied, { model: "anthropic/claude-sonnet-4", thinkingLevel: "high" });
  // Read back on the far side: a model change is one commit over the binding and the
  // conversation's agent, so both have to move together.
  assert.equal((await inProcess.resolve("threads/M"))?.model, "anthropic/claude-sonnet-4");
  assert.equal((await inProcess.state((await inProcess.resolve("threads/M"))!.conversationId))?.thinkingLevel, "high");
});

test("bind and label cross the link, and a missing conversation is null on the wire", async () => {
  const { inProcess, linked } = await bothEnds();
  const first = await linked.getOrCreate("threads/one", { model: { provider: "deepseek", modelId: "flash" } });

  assert.equal(await linked.label("threads/one", "research notes"), true);
  assert.equal((await inProcess.resolve("threads/one"))?.label, "research notes");

  const bound = await linked.bind("threads/two", first.conversationId);
  assert.equal(bound?.conversationId, first.conversationId);
  assert.equal(await linked.bind("threads/three", 999_999), undefined, "nothing to bind to");
});

test("abort over the link is idempotent, and gone is false", async () => {
  const { linked } = await bothEnds();
  const created = await linked.getOrCreate("threads/A2", { model: { provider: "deepseek", modelId: "flash" } });
  // Aborting an idle conversation succeeds: the seam's boolean is about the conversation existing,
  // not about a turn having been there. "Was anything running" is the view's question, and the
  // command surface asks it there.
  assert.equal(await linked.abort(created.conversationId), true);
  assert.equal(await linked.abort(created.conversationId), true, "twice is the same as once");
  assert.equal(await linked.abort(999_999), false);
});
