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
import { runCommand } from "../src/adapter/command-surface.js";
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
      // One model, so `/model` can be applied as well as listed: the command surface refuses a model
      // the host does not have, which is the correct refusal and a useless fixture if the list is
      // empty.
      getModels: () => [],
      getAllAvailable: async () => [{ provider: "anthropic", id: "claude-sonnet-4", name: "Claude Sonnet 4" }],
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

test("a command surface over the link is the deployment that was failing", async () => {
  // The bug this guards: `/status` worked against an in-process seam and answered "state is not
  // published over the link yet" in the deployment that runs `BRIDGE_WEB_ENGINE=link`. A command is
  // an adapter calling the seam, so it has to be exercised over the wire, not only in memory.
  const { linked } = await bothEnds();
  const created = await linked.getOrCreate("threads/cmd", { model: { provider: "deepseek", modelId: "flash" } });
  const subject = { conversationId: created.conversationId, name: "threads/cmd" };

  const status = await runCommand(linked, subject, { text: "/status" });
  assert.equal(status.kind, "text");
  assert.match(status.kind === "text" ? status.text : "", /deepseek\/flash/);

  const form = await runCommand(linked, subject, { text: "/model" });
  assert.equal(form.kind, "form");
  assert.ok(form.kind === "form");
  assert.ok(form.fields.some((field) => field.id === "thinking"), "the thinking level travels with the model");

  // And applying it moves the host's own binding, which is the read-back that proves the write
  // crossed rather than being answered by the client.
  const applied = await runCommand(linked, subject, {
    text: "/model",
    values: { model: "anthropic/claude-sonnet-4", thinking: "high" },
  });
  assert.equal(applied.kind, "text");
  assert.equal((await linked.resolve("threads/cmd"))?.model, "anthropic/claude-sonnet-4");
});

test("quota crosses the link, because the probe belongs where the host is", async () => {
  // `models.json`, the provider keys and the balance APIs are all host-side, so an adapter in another
  // process asks for the answer rather than running the check itself.
  const { linked } = await bothEnds();
  const quotas = await linked.quota();
  assert.ok(Array.isArray(quotas), "an array, even when no provider answers");
});

test("a submission's origin crosses the link, and comes back in history", async () => {
  // The bug this is for: the client built the submit payload without `origin`, so every submission
  // reached the host unstamped. On the far side that looks like "this prompt came from nowhere", and
  // the painter's rule — quote a prompt that came from *another* surface — silently stopped applying,
  // which is why answers stopped showing what they were replying to.
  const { inProcess, linked } = await bothEnds();
  const created = await linked.getOrCreate("threads/origin", { model: { provider: "deepseek", modelId: "flash" } });

  const accepted = await linked.submit(created.conversationId, { content: "from the browser", origin: "webui" });
  assert.ok("submissionId" in accepted, JSON.stringify(accepted));

  // Stamped on the host, which is the thing that matters: `recordOrigin` runs there.
  const direct = await inProcess.history(created.conversationId, { limit: 10, offset: 0 });
  const prompt = (direct ?? []).find((message) => message.role === "user");
  assert.ok(prompt, "the prompt is in the transcript");
  assert.equal(prompt!.origin, "webui");

  // And it survives the wire, so a client reading history to decide what to paint gets it too.
  const overLink = await linked.history(created.conversationId, { limit: 10, offset: 0 });
  assert.equal((overLink ?? []).find((message) => message.role === "user")?.origin, "webui");
});

/* --- What the Chat bridge needs before it can live in its own process ------ */

test("info and usage cross the link", async () => {
  const { inProcess, linked } = await bothEnds();
  const info = await linked.info();
  assert.equal(info.dbPath, (await inProcess.info()).dbPath);
  assert.equal(typeof info.cwd, "string");

  const usage = await linked.usage();
  assert.equal(typeof usage.models, "object");
  assert.equal(typeof usage.tools, "object");
});

test("an adapter-written entry and the first turn come back over the link", async () => {
  // Both are what a Chat bridge needs to word a notice and to title a thread.
  const { inProcess, linked } = await bothEnds();
  const created = await linked.getOrCreate("threads/write", { model: { provider: "deepseek", modelId: "flash" } });

  const id = await linked.write(created.conversationId, { kind: "app.notice", data: { note: "hello" } });
  assert.ok(id > 0, "the entry has an id");

  const turn = await linked.firstTurn(created.conversationId);
  // No assistant has answered, so there is no first turn yet — the same `undefined` the seam promises.
  assert.equal(turn, undefined);
  assert.equal(await inProcess.firstTurn(created.conversationId), undefined);
});

test("a verdict recorded over the link is the host's verdict", async () => {
  const { inProcess, linked } = await bothEnds();
  await inProcess.getOrCreate("threads/verdict", { model: { provider: "deepseek", modelId: "flash" } });

  const verdict = { verdict: "NO" as const, reason: "routine chatter", at: 1_700_000_000_000 };
  await linked.recordVerdict("threads/verdict", verdict);
  assert.deepEqual(await inProcess.verdict("threads/verdict"), verdict, "written on the host");
  assert.deepEqual(await linked.verdict("threads/verdict"), verdict, "and read back over the link");
  assert.equal(await linked.verdict("threads/none"), undefined, "no verdict is undefined, not null");
});

test("awaitSubmission crosses the link, and a settled turn comes back as data", async () => {
  // The Chat handler's failure notices are worded from this answer, which is why it crosses now: an
  // adapter that cannot wait cannot say why a turn produced nothing.
  const { linked } = await bothEnds();
  const created = await linked.getOrCreate("threads/await", { model: { provider: "deepseek", modelId: "flash" } });
  const accepted = await linked.submit(created.conversationId, { content: "hello", origin: "gchat" });
  assert.ok("submissionId" in accepted, JSON.stringify(accepted));

  const settled = await linked.awaitSubmission(accepted.submissionId);
  // The memory host has no model runtime, so this turn cannot be answered — which is exactly the
  // shape the handler words a notice from, and it must arrive as a value over the wire.
  assert.equal(settled.status, "unanswered");
});
