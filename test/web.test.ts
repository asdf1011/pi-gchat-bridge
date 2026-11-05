/**
 * The web sink is a second view onto one conversation.
 *
 * What these pin is not the HTTP plumbing but the property the whole migration
 * was for: a client attached to a conversation receives the state of a turn it
 * did not start. A test that only checked "an event was emitted" would pass
 * even if the browser and Chat saw different conversations.
 *
 * These run against a fake `SessionHost` — no SQLite, no model, no harness. That
 * is the seam doing its job: this file used to fake a BridgeHost *and* a chord
 * view subscription, and assert on raw views the adapter then projected.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { attachWebClient, webIndex, webSubmit, type SseClient, type WebOptions } from "../src/adapter/web.js";
import type { NamedConversation, SessionHost, SubmitRequest } from "../src/session-host/api.js";
import type { ProjectedView } from "../src/session-host/projection.js";

interface Sent {
  event: string;
  data: unknown;
}

/** A fake SSE client that records what it was sent. */
function client(): SseClient & { sent: Sent[]; close(): void } {
  const sent: Sent[] = [];
  let alive = true;
  return {
    sent,
    get open() {
      return alive;
    },
    send(event, data) {
      if (alive) sent.push({ event, data });
    },
    // Test-only kill switch, standing in for a dropped connection.
    close() {
      alive = false;
    },
  } as SseClient & { sent: Sent[]; close(): void };
}

/** What a conversation looks like to a viewer: the projection, nothing more. */
function view(text: string, tools: ProjectedView["tools"] = []): ProjectedView {
  return { liveText: text, tools, busy: text !== "", lastAssistantText: text };
}

interface FakeOptions {
  /** The state a new attachment is seeded with. */
  snapshot?: ProjectedView;
  conversations?: readonly number[];
  listed?: readonly NamedConversation[];
  submitted?: SubmitRequest[];
}

function fakeSeam(options: FakeOptions = {}) {
  const conversations = options.conversations ?? [1];
  const attachments: { id: number; onFrame: (next: ProjectedView) => void; detached: boolean }[] = [];

  const seam = {
    info: () => ({ dbPath: ":memory:", cwd: "/workspace", startedAt: 0 }),
    list: async () => [...(options.listed ?? [])],
    resolve: async () => undefined,
    getOrCreate: async () => {
      throw new Error("not used by the web adapter");
    },
    snapshot: async (id: number) => (conversations.includes(id) ? options.snapshot : undefined),
    attach: async (id: number, onFrame: (next: ProjectedView) => void) => {
      if (!conversations.includes(id)) return undefined;
      const attachment = { id, onFrame, detached: false };
      attachments.push(attachment);
      // The seam contract: the current state arrives as the first frame.
      if (options.snapshot) onFrame(options.snapshot);
      return {
        snapshot: options.snapshot ?? view(""),
        detach() {
          attachment.detached = true;
        },
      };
    },
    artifacts: async () => undefined,
    submit: async (_id: number, request: SubmitRequest) => {
      if (typeof request.content === "string" && request.content.trim() === "") {
        return { error: "empty message" };
      }
      options.submitted?.push(request);
      return { submissionId: 7 };
    },
  } as unknown as SessionHost;

  return {
    seam,
    /** Commit a new state, as the harness does after a run step. */
    push(next: ProjectedView) {
      for (const attachment of attachments) if (!attachment.detached) attachment.onFrame(next);
    },
    attachmentCount: () => attachments.filter((a) => !a.detached).length,
  };
}

function options(seam: SessionHost): WebOptions {
  return { seam, model: { provider: "p", modelId: "m" } };
}

test("an idle conversation paints nothing, rather than an empty answer", async () => {
  const fake = fakeSeam({ snapshot: view("") });
  const c = client();
  await attachWebClient(options(fake.seam), 1, c);
  assert.equal(c.sent.length, 0);
});

test("a client is painted the state of a turn it did not start", async () => {
  const fake = fakeSeam({ snapshot: view("") });
  const c = client();
  await attachWebClient(options(fake.seam), 1, c);

  // A turn committed by *someone else* — this is the sync being tested.
  fake.push(view("Hello"));

  const text = c.sent.filter((s) => s.event === "text");
  assert.equal(text.length, 1);
  assert.deepEqual(text[0].data, { text: "Hello", busy: true });
});

test("a late joiner is seeded from the snapshot, not left blank", async () => {
  const fake = fakeSeam({ snapshot: view("half an ans") });
  const c = client();
  await attachWebClient(options(fake.seam), 1, c);

  // Connecting mid-turn shows the in-progress answer immediately: the first
  // frame is the snapshot, so there is no separate initial paint to get wrong.
  assert.equal((c.sent.at(-1)!.data as { text: string }).text, "half an ans");
});

test("identical states are not re-sent", async () => {
  const fake = fakeSeam({ snapshot: view("") });
  const c = client();
  await attachWebClient(options(fake.seam), 1, c);

  fake.push(view("x"));
  fake.push(view("x")); // a commit that did not change the text
  assert.equal(c.sent.filter((s) => s.event === "text").length, 1);
});

test("a tool frame reports the newest unfinished call, and null clears it", async () => {
  const fake = fakeSeam({ snapshot: view("") });
  const c = client();
  await attachWebClient(options(fake.seam), 1, c);

  fake.push(view("", [{ callId: "1", name: "bash", status: "running", arguments: { command: "sleep 10" } }]));
  // The line is worded exactly as Chat words it ("Running: `sleep 10`"), because
  // both surfaces should say the same thing about the same tool.
  assert.deepEqual(c.sent.at(-1), {
    event: "tool",
    data: { name: "bash", status: "running", output: undefined, line: "Running: sleep 10" },
  });

  fake.push(view("", [{ callId: "1", name: "bash", status: "done" }]));
  assert.deepEqual(c.sent.at(-1), { event: "tool", data: null });
});

test("a second client is independent of the first", async () => {
  const fake = fakeSeam({ snapshot: view("") });
  const a = client();
  const b = client();
  await attachWebClient(options(fake.seam), 1, a);
  await attachWebClient(options(fake.seam), 1, b);

  // Two attachments, as two browsers: not one shared subscription.
  assert.equal(fake.attachmentCount(), 2);

  fake.push(view("both"));
  assert.equal((a.sent.at(-1)!.data as { text: string }).text, "both");
  assert.equal((b.sent.at(-1)!.data as { text: string }).text, "both");
});

test("closing one client leaves the other attached", async () => {
  const fake = fakeSeam({ snapshot: view("") });
  const a = client();
  const b = client();
  const handleA = await attachWebClient(options(fake.seam), 1, a);
  await attachWebClient(options(fake.seam), 1, b);
  handleA.close();

  fake.push(view("after"));
  assert.equal(a.sent.filter((s) => s.event === "text").length, 0);
  assert.equal((b.sent.at(-1)!.data as { text: string }).text, "after");
});

test("an unknown conversation reports an error instead of hanging", async () => {
  const fake = fakeSeam({ conversations: [1] });
  const c = client();
  await attachWebClient(options(fake.seam), 999, c);
  assert.equal(c.sent[0].event, "error");
});

test("the index maps host conversations to what the page renders", async () => {
  const fake = fakeSeam({
    listed: [
      { conversationId: 2, name: "spaces/B", label: "Named", model: "p/m", createdAt: 300 },
      { conversationId: 1, name: "spaces/A", model: "p/m", createdAt: 100 },
    ],
  });
  const rows = await webIndex({ seam: fake.seam });
  // Order is the host's, not the adapter's: newest first is a host guarantee.
  assert.deepEqual(rows.map((r) => r.conversationId), [2, 1]);
  assert.equal(rows[0].name, "Named");
  assert.equal(rows[0].chatKey, "spaces/B");
  assert.equal(rows[1].name, undefined);
});

test("an empty message is refused rather than submitted", async () => {
  const submitted: SubmitRequest[] = [];
  const fake = fakeSeam({ submitted });
  const result = await webSubmit(options(fake.seam), 1, "   ");
  assert.equal(result.ok, false);
  assert.equal(submitted.length, 0);
});

test("a web message steers by default, matching a Chat message", async () => {
  const submitted: SubmitRequest[] = [];
  const fake = fakeSeam({ submitted });
  const result = await webSubmit(options(fake.seam), 1, "hello");
  assert.equal(result.ok, true);
  // A browser message must join a running Chat turn, not queue behind it: that
  // is what makes the two frontends one conversation rather than two.
  assert.equal(submitted[0].whenBusy, "steer");
  assert.equal(submitted[0].content, "hello");
});
