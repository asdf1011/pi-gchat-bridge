/**
 * The protocol, and the second bridge that proves it.
 *
 * Two halves, tested against each other: the `/v1` handlers over a fake seam, and the CLI
 * client over a real HTTP server wrapping those handlers. That pairing is the point — the
 * claim being checked is not "the CLI works" but "a new surface needs no server changes",
 * and a conformance test is the only way to know whether the two ends agree.
 *
 * The cursor rule gets the most attention, because it is the one that decides whether a
 * bridge can be closed for a week: a first read adopts at the head (nothing replays), and
 * a second read resumes from the CLI's own file (nothing repeats).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { handleV1, type ConversationAddress } from "../src/adapter/v1-routes.js";
import { ActivityFeed } from "../src/durable/activity.js";
import { runCli, loadState, say, tail, watch } from "../src/scripts/bridge-cli.js";
import type { SessionHost, TranscriptMessage } from "../src/session-host/api.js";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "v1-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
const statePath = (): string => path.join(scratch, `state-${++counter}.json`);

/** A conversation as the protocol sees it: entries with origins, and a submit that appends. */
function fakeSeam(
  messages: { entryId: number; role: "user" | "assistant"; text: string; origin?: string }[],
  options: { conversations?: number[] } = {},
) {
  const known = new Set(options.conversations ?? [1]);
  const submitted: { conversationId: number; text: string; origin?: string }[] = [];
  const seam = {
    history: async (conversationId: number, page?: { limit?: number; offset?: number }) => {
      if (!known.has(conversationId)) return undefined;
      const limit = page?.limit ?? 20;
      const offset = page?.offset ?? 0;
      const end = Math.max(0, messages.length - offset);
      return messages.slice(Math.max(0, end - limit), end) as readonly TranscriptMessage[];
    },
    submit: async (conversationId: number, request: { content: string; origin?: string }) => {
      submitted.push({ conversationId, text: request.content, ...(request.origin ? { origin: request.origin } : {}) });
      return { submissionId: 99 };
    },
  } as unknown as SessionHost;
  return { seam, submitted, messages };
}

/** The `/v1` routes behind a real socket, so the CLI is exercised over HTTP. */
async function serve(
  seam: SessionHost,
  addresses: ConversationAddress[] = [{ conversationId: 1, address: "spaces/S/threads/T", name: "test" }],
  token?: string,
): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void handleV1(req, res, url, { seam, conversations: async () => addresses, ...(token ? { token } : {}) });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("entries are grouped by entry and carry their origin", async () => {
  const { seam } = fakeSeam([
    { entryId: 4, role: "user", text: "from the browser", origin: "webui" },
    { entryId: 5, role: "assistant", text: "checking", },
    { entryId: 6, role: "assistant", text: "the answer", origin: "webui" },
  ]);
  const served = await serve(seam);
  try {
    const body = (await (await fetch(`${served.baseUrl}/v1/conversations/1/entries?since=3`)).json()) as {
      entries: { entryId: number; role: string; origin?: string }[];
      newest: number;
    };
    assert.deepEqual(
      body.entries.map((entry) => [entry.entryId, entry.origin]),
      [
        [4, "webui"],
        [5, undefined],
        [6, "webui"],
      ],
      "an unstamped entry is commentary, and absence is reported as absence",
    );
    assert.equal(body.newest, 6);
  } finally {
    await served.close();
  }
});

test("`since` is a filter, not a page offset", async () => {
  const { seam } = fakeSeam([
    { entryId: 10, role: "user", text: "old" },
    { entryId: 11, role: "assistant", text: "older answer" },
  ]);
  const served = await serve(seam);
  try {
    const body = (await (await fetch(`${served.baseUrl}/v1/conversations/1/entries?since=10`)).json()) as {
      entries: { entryId: number }[];
    };
    assert.deepEqual(body.entries.map((entry) => entry.entryId), [11], "strictly after the cursor");
  } finally {
    await served.close();
  }
});

test("an unknown conversation is 404, not an empty page", async () => {
  const { seam } = fakeSeam([], { conversations: [] });
  const served = await serve(seam);
  try {
    // A reader must be able to tell "nothing new" from "gone": both would otherwise look
    // like an empty list, and a bridge would keep adopting a conversation that is not there.
    assert.equal((await fetch(`${served.baseUrl}/v1/conversations/7/entries?since=0`)).status, 404);
  } finally {
    await served.close();
  }
});

test("a submission carries an origin, so it is a first-class message", async () => {
  const { seam, submitted } = fakeSeam([]);
  const served = await serve(seam);
  try {
    const response = await fetch(`${served.baseUrl}/v1/conversations/1/submissions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello from a terminal", origin: "cli" }),
    });
    assert.equal(response.status, 202);
    assert.deepEqual(submitted, [{ conversationId: 1, text: "hello from a terminal", origin: "cli" }]);
  } finally {
    await served.close();
  }
});

test("writes need the token when one is configured; reads do not", async () => {
  const { seam, submitted } = fakeSeam([{ entryId: 1, role: "user", text: "hi" }]);
  const served = await serve(seam, [{ conversationId: 1, address: "spaces/S" }], "s3cret");
  try {
    assert.equal((await fetch(`${served.baseUrl}/v1/conversations`)).status, 200);
    const denied = await fetch(`${served.baseUrl}/v1/conversations/1/submissions`, {
      method: "POST",
      body: JSON.stringify({ text: "nope" }),
    });
    assert.equal(denied.status, 401);
    assert.deepEqual(submitted, []);
  } finally {
    await served.close();
  }
});

test("the CLI adopts at the head on a first read, then resumes from its own file", async () => {
  const { seam } = fakeSeam([{ entryId: 7, role: "user", text: "already happened" }]);
  const served = await serve(seam);
  const file = statePath();
  const lines: string[] = [];
  const deps = { baseUrl: served.baseUrl, statePath: file, out: (line: string) => lines.push(line) };
  try {
    // First run: a captured conversation is not replayed at a person's terminal.
    await tail(deps, { conversationId: 1 });
    assert.match(lines.join("\n"), /adopted at entry 7/);
    assert.equal((await loadState(file)).conversations["1"]?.cursor, 7);

    // A new entry arrives; the second run prints it — and only it.
    seam.history = async (_id: number, page?: { limit?: number }) =>
      (page?.limit ?? 20) >= 2
        ? ([
            { entryId: 7, role: "user", text: "already happened" },
            { entryId: 8, role: "assistant", text: "and then this", origin: "gchat" },
          ] as readonly TranscriptMessage[])
        : ([{ entryId: 8, role: "assistant", text: "and then this", origin: "gchat" }] as readonly TranscriptMessage[]);
    lines.length = 0;
    await tail(deps, { conversationId: 1 });
    assert.deepEqual(lines, ["[8] assistant:gchat: and then this"]);

    // And a third run has nothing to say.
    lines.length = 0;
    await tail(deps, { conversationId: 1 });
    assert.deepEqual(lines, []);
  } finally {
    await served.close();
  }
});

test("the CLI speaks into the conversation, and names itself", async () => {
  const { seam, submitted } = fakeSeam([]);
  const served = await serve(seam);
  try {
    const lines: string[] = [];
    await say({ baseUrl: served.baseUrl, out: (line: string) => lines.push(line) }, 1, "say this");
    assert.deepEqual(submitted, [{ conversationId: 1, text: "say this", origin: "cli" }]);
    assert.match(lines[0] ?? "", /origin cli/);
  } finally {
    await served.close();
  }
});

test("the command line behaves like a person would expect", async () => {
  const { seam } = fakeSeam([{ entryId: 3, role: "user", text: "hi" }]);
  const served = await serve(seam);
  const lines: string[] = [];
  const deps = {
    baseUrl: served.baseUrl,
    statePath: statePath(),
    out: (line: string) => lines.push(line),
  };
  try {
    assert.equal(await runCli(["list"], deps), 0);
    assert.match(lines.join("\n"), /spaces\/S\/threads\/T/);

    lines.length = 0;
    assert.equal(await runCli(["tail"], deps), 2, "tail without a conversation is a usage error");
    assert.match(lines[0] ?? "", /needs --conversation/);

    lines.length = 0;
    assert.equal(await runCli(["say", "--conversation", "1"], deps), 2, "say without words is a usage error");
  } finally {
    await served.close();
  }
});

/* --- the two verbs a bridge needs to not be in-process ------------------------------ */

test("one conversation's state is a snapshot, not a subscription", async () => {
  // What the painter's busy check and the restart gate's quiet test both need: a question with an
  // answer, not a watch.
  const { seam } = fakeSeam([]);
  (seam as unknown as Record<string, unknown>).snapshot = async (id: number) =>
    id === 1 ? { liveText: "half", busy: true, lastAssistantText: "", tools: [] } : undefined;
  const served = await serve(seam);
  try {
    const body = (await (await fetch(`${served.baseUrl}/v1/conversations/1`)).json()) as {
      view: { busy: boolean; liveText: string };
    };
    assert.equal(body.view.busy, true);
    assert.equal(body.view.liveText, "half");
    assert.equal((await fetch(`${served.baseUrl}/v1/conversations/9`)).status, 404);
  } finally {
    await served.close();
  }
});

/* --- the log as a stream ------------------------------------------------------------ */

/** Read SSE events (skipping heartbeats) until `count` of them have arrived. */
async function readEvents(response: Response, count: number): Promise<{ event: string; data: string }[]> {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const events: { event: string; data: string }[] = [];
  let buffer = "";
  while (events.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf("\n\n");
    while (index !== -1) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
      const data = /^data: (.*)$/m.exec(block)?.[1] ?? "";
      if (event !== "heartbeat") events.push({ event, data });
      index = buffer.indexOf("\n\n");
    }
  }
  reader.cancel().catch(() => {});
  return events;
}

/** A seam whose history a test can grow, plus an activity feed to trigger the read-forward. */
function streamSeam(
  initial: {
    conversationId: number;
    entries: { entryId: number; role: "user" | "assistant"; text: string; origin?: string }[];
  }[],
) {
  const state = initial.map((conversation) => ({ ...conversation, entries: [...conversation.entries] }));
  const seam = {
    history: async (id: number, page?: { limit?: number; offset?: number }) => {
      const conversation = state.find((candidate) => candidate.conversationId === id);
      if (!conversation) return undefined;
      const limit = page?.limit ?? 20;
      const offset = page?.offset ?? 0;
      const end = Math.max(0, conversation.entries.length - offset);
      return conversation.entries.slice(Math.max(0, end - limit), end) as readonly TranscriptMessage[];
    },
    // The activity feed watches a turn to know when it settles; these tests only drive boundaries,
    // so the watch simply never reports an end.
    attach: async () => ({ snapshot: { liveText: "", busy: true, lastAssistantText: "", tools: [] }, detach() {} }),
    // `observe=1` asks for the running turn alongside the content.
    snapshot: async () => ({ liveText: "", busy: false, lastAssistantText: "", tools: [] }),
  } as unknown as SessionHost;
  return {
    seam,
    add(
      conversationId: number,
      entry: { entryId: number; role: "user" | "assistant"; text: string; origin?: string },
    ) {
      state.find((candidate) => candidate.conversationId === conversationId)?.entries.push(entry);
    },
  };
}

/** The `/v1` routes behind a socket, with an activity feed the test can drive. */
async function serveEvents(seam: SessionHost, addresses: ConversationAddress[], feed?: ActivityFeed) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    handleV1(req, res, url, { seam, conversations: async () => addresses, ...(feed ? { activity: feed } : {}) })
      .then((handled) => {
        if (!handled && !res.headersSent) {
          res.writeHead(404);
          res.end("unhandled");
        }
      })
      .catch((error: unknown) => {
        console.error("v1 threw:", error);
        if (!res.headersSent) res.writeHead(500);
        res.end(String(error));
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    // An SSE connection is still open when the test finishes, and `close()` waits for it: drop the
    // sockets explicitly, or every stream test hangs in its own teardown.
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

test("the log replays from a cursor, in one order across conversations", async () => {
  // The client's whole protocol: "I have seen 10, send me everything after it." Order is the id
  // sequence, so a stream of several conversations needs no per-conversation bookkeeping.
  const { seam } = streamSeam([
    {
      conversationId: 1,
      entries: [
        { entryId: 9, role: "user", text: "before the cursor" },
        { entryId: 11, role: "assistant", text: "first", origin: "gchat" },
      ],
    },
    { conversationId: 2, entries: [{ entryId: 10, role: "user", text: "second", origin: "webui" }] },
  ]);
  const served = await serveEvents(seam, [
    { conversationId: 1, address: "spaces/S/threads/T" },
    { conversationId: 2, address: "spaces/S/threads/U" },
  ]);
  try {
    const response = await fetch(`${served.baseUrl}/v1/events?since=10`);
    const events = await readEvents(response, 2);
    assert.equal(events[0]?.event, "ready", "where the stream starts, before anything arrives");
    assert.equal(JSON.parse(events[0]!.data).cursor, 10);
    const entry = events[1]!;
    assert.equal(entry.event, "entry");
    assert.equal(JSON.parse(entry.data).entryId, 11, "only what is past the cursor");
    assert.equal(JSON.parse(entry.data).origin, "gchat");
  } finally {
    await served.close();
  }
});

test("a filter narrows the same stream, and an unreadable conversation is refused", async () => {
  const { seam } = streamSeam([
    { conversationId: 1, entries: [{ entryId: 20, role: "assistant", text: "mine", origin: "gchat" }] },
    { conversationId: 2, entries: [{ entryId: 21, role: "assistant", text: "not yours" }] },
  ]);
  // Only conversation 1 is served by this bridge: scope is the right to read, not a filter the
  // client chooses.
  const served = await serveEvents(seam, [{ conversationId: 1, address: "spaces/S/threads/T" }]);
  try {
    const filtered = await fetch(`${served.baseUrl}/v1/events?since=19&conversation=1`);
    const events = await readEvents(filtered, 2);
    assert.equal(JSON.parse(events[1]!.data).entryId, 20);

    assert.equal((await fetch(`${served.baseUrl}/v1/events?since=0&conversation=2`)).status, 404);
  } finally {
    await served.close();
  }
});

test("a turn boundary is the trigger that reads the log forward", async () => {
  // Entries are not pushed by themselves — there is no "entry appended" event — but every entry
  // follows a boundary, so activity is the trigger. One page read per boundary, not a poll.
  const { seam, add } = streamSeam([{ conversationId: 1, entries: [] }]);
  const feed = new ActivityFeed({ seam });
  const served = await serveEvents(seam, [{ conversationId: 1, address: "spaces/S/threads/T" }], feed);
  try {
    const response = await fetch(`${served.baseUrl}/v1/events?since=0`);
    await new Promise((resolve) => setTimeout(resolve, 20));

    add(1, { entryId: 30, role: "assistant", text: "written while connected", origin: "gchat" });
    feed.started(1);
    await new Promise((resolve) => setTimeout(resolve, 40));

    const events = await readEvents(response, 3);
    assert.deepEqual(
      events.map((event) => event.event),
      ["ready", "activity", "entry"],
      "the position, the boundary, then the content it announced",
    );
    const entry = events.find((event) => event.event === "entry")!;
    assert.equal(JSON.parse(entry.data).text, "written while connected");
  } finally {
    await served.close();
    feed.close();
  }
});

test("a cursor further back than the replay window is told so, rather than flooded", async () => {
  // "You are too far behind" is a protocol answer, not a client heuristic: the reader decides
  // whether to accept the newest position or fetch history another way.
  const entries = Array.from({ length: 620 }, (_, index) => ({
    entryId: index + 1,
    role: "assistant" as const,
    text: `entry ${index + 1}`,
  }));
  const { seam } = streamSeam([{ conversationId: 1, entries }]);
  const served = await serveEvents(seam, [{ conversationId: 1, address: "spaces/S/threads/T" }]);
  try {
    const response = await fetch(`${served.baseUrl}/v1/events?since=1`);
    const events = await readEvents(response, 202);
    const resync = events.find((event) => event.event === "resync");
    assert.ok(resync, "the window ran out, and it says so");
    assert.ok(JSON.parse(resync.data).cursor > 1, "with the position it continued from");
  } finally {
    await served.close();
  }
});

test("the CLI's watch follows the stream and remembers its position", async () => {
  // The first client ported onto /v1/events, and the smallest: send the last id seen, print what
  // comes back, remember it. This is the endpoint's whole claim demonstrated by a client small
  // enough to read in one sitting.
  const { seam, add } = streamSeam([{ conversationId: 1, entries: [] }]);
  const feed = new ActivityFeed({ seam });
  const served = await serveEvents(seam, [{ conversationId: 1, address: "spaces/S/threads/T" }], feed);
  const file = path.join(scratch, `watch-${Date.now()}.json`);
  const lines: string[] = [];
  const stop = new AbortController();
  let running: Promise<number> | undefined;
  try {
    running = watch(
      { baseUrl: served.baseUrl, statePath: file, out: (line) => lines.push(line) },
      { conversationId: 1, signal: stop.signal },
    );
    // Wait for adoption before adding anything: a first run adopts at the head, so an entry that
    // arrives before the adopt is deliberately not printed. Racing that is how this test was flaky.
    for (let i = 0; i < 100 && !lines.some((line) => line.startsWith("# adopted")); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(lines.some((line) => line.startsWith("# adopted")), `watch never adopted: ${lines.join("\n")}`);

    // A turn in progress, then the entry it produced — the boundary is what makes the stream read.
    add(1, { entryId: 50, role: "assistant", text: "the answer arrives", origin: "gchat" });
    feed.started(1);
    // Poll for the printed line rather than sleeping a fixed time: the stream is asynchronous and a
    // fixed wait is how this test was occasionally red for the wrong reason.
    for (let i = 0; i < 200 && !lines.some((line) => line.includes("[50]")); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(lines.some((line) => line.includes("[50] assistant:gchat: the answer arrives")), lines.join("\n"));
    assert.deepEqual((await loadState(file)).conversations["1"], { cursor: 50 });

    // The remembered position is the whole point: a restart resumes from it rather than replaying.
    assert.deepEqual((await loadState(file)).conversations["1"], { cursor: 50 });
    stop.abort();
    await running.catch(() => {});
  } finally {
    stop.abort();
    await running?.catch(() => {});
    await served.close().catch(() => {});
    feed.close();
  }
});

test("live text is opt-in, needs a conversation, and arrives on the same connection", async () => {
  // The one thing the log stream cannot carry: the answer being written. It is ephemeral and
  // per-turn, so it is a flag on a *filtered* stream rather than a property of the log.
  const { seam } = streamSeam([
    { conversationId: 1, entries: [{ entryId: 40, role: "user", text: "go", origin: "gchat" }] },
  ]);
  const frames: ((view: unknown) => void)[] = [];
  (seam as unknown as Record<string, unknown>).attach = async (_id: number, onFrame: (view: unknown) => void) => {
    frames.push(onFrame);
    return {
      snapshot: { liveText: "half", busy: true, lastAssistantText: "", tools: [] },
      detach() {},
    };
  };
  const served = await serveEvents(seam, [{ conversationId: 1, address: "spaces/S/threads/T" }]);
  try {
    // Unfiltered: refused, because per-token text for every running turn is not something to fan out.
    assert.equal((await fetch(`${served.baseUrl}/v1/events?live=1`)).status, 400);

    const response = await fetch(`${served.baseUrl}/v1/events?since=39&conversation=1&live=1`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    frames[0]?.({ liveText: "half an answer", busy: true, lastAssistantText: "", tools: [] });

    const events = await readEvents(response, 4);
    assert.deepEqual(
      events.map((event) => event.event),
      ["ready", "entry", "view", "view"],
      "position, content, the live snapshot, then live text",
    );
    assert.match(events[2]!.data, /"liveText":"half"/, "the snapshot, so a joiner paints");
    assert.match(events[3]!.data, /half an answer/);
  } finally {
    await served.close();
  }
});

/* --- the log as a long poll ---------------------------------------------------------- */

test("a poll returns what is after the cursor, and does not wait for more", async () => {
  const { seam } = streamSeam([
    {
      conversationId: 1,
      entries: [
        { entryId: 10, role: "user", text: "old" },
        { entryId: 11, role: "assistant", text: "new", origin: "gchat" },
      ],
    },
  ]);
  const served = await serveEvents(seam, [{ conversationId: 1, address: "spaces/S/threads/T" }]);
  try {
    const body = (await (await fetch(`${served.baseUrl}/v1/poll?since=10&wait=0`)).json()) as {
      cursor: number;
      entries: { entryId: number; text: string }[];
    };
    assert.deepEqual(body.entries.map((entry) => entry.entryId), [11]);
    assert.equal(body.cursor, 11, "the cursor is the last thing handed over, so a client can resume");
  } finally {
    await served.close();
  }
});

test("a poll waits for a turn and comes back with its burst in one response", async () => {
  // The shape this replaces a subscription with: block until something happens, then answer. The
  // batch window is why a turn's prompt and answer arrive together rather than as two round trips.
  const { seam, add } = streamSeam([{ conversationId: 1, entries: [] }]);
  const feed = new ActivityFeed({ seam });
  const served = await serveEvents(seam, [{ conversationId: 1, address: "spaces/S/threads/T" }], feed);
  try {
    const started = Date.now();
    const pending = fetch(`${served.baseUrl}/v1/poll?since=0&wait=5&batch=80&conversation=1`);
    await new Promise((resolve) => setTimeout(resolve, 30));

    add(1, { entryId: 20, role: "user", text: "the prompt", origin: "gchat" });
    feed.started(1);
    // The answer lands inside the batch window, so one response carries both.
    await new Promise((resolve) => setTimeout(resolve, 20));
    add(1, { entryId: 21, role: "assistant", text: "the answer", origin: "gchat" });

    const body = (await (await pending).json()) as { cursor: number; entries: { entryId: number }[] };
    assert.deepEqual(body.entries.map((entry) => entry.entryId), [20, 21], "one response, in order");
    assert.equal(body.cursor, 21);
    assert.ok(Date.now() - started < 5_000, "it came back on the event, not on the timeout");
  } finally {
    await served.close();
    feed.close();
  }
});

test("a poll with nothing to report times out and says so by returning the same cursor", async () => {
  const { seam } = streamSeam([{ conversationId: 1, entries: [] }]);
  const served = await serveEvents(seam, [{ conversationId: 1, address: "spaces/S/threads/T" }]);
  try {
    const started = Date.now();
    const body = (await (await fetch(`${served.baseUrl}/v1/poll?since=99&wait=0.15`)).json()) as {
      cursor: number;
      entries: unknown[];
    };
    assert.deepEqual(body.entries, []);
    assert.equal(body.cursor, 99, "a timeout is an ordinary answer, not an error");
    assert.ok(Date.now() - started >= 100, "and it did wait");
  } finally {
    await served.close();
  }
});

test("observe adds the running turn to the same response, and needs a conversation", async () => {
  const { seam } = streamSeam([{ conversationId: 1, entries: [] }]);
  (seam as unknown as Record<string, unknown>).snapshot = async () => ({
    liveText: "half",
    busy: true,
    lastAssistantText: "",
    tools: [],
  });
  const served = await serveEvents(seam, [{ conversationId: 1, address: "spaces/S/threads/T" }]);
  try {
    const body = (await (await fetch(`${served.baseUrl}/v1/poll?since=0&wait=0&conversation=1&observe=1`)).json()) as {
      busy: boolean;
      view: { liveText: string };
    };
    assert.equal(body.busy, true);
    assert.equal(body.view.liveText, "half", "live text arrives in the same response as content");

    // Unfiltered observation would be a view snapshot per conversation — refused, as with live=1.
    assert.equal((await fetch(`${served.baseUrl}/v1/poll?observe=1&wait=0`)).status, 400);
  } finally {
    await served.close();
  }
});

test("a poll that carried entries is cacheable, an empty one never is", async () => {
  // The distinction is prefix-ness. "Everything after X" is a prefix of an append-only log, so an
  // answer with entries stays true for ever and a cached chain gives catch-up without the origin.
  // An *empty* answer is a state: cached, every later poll gets an instant "nothing new" and the
  // client spins while the tunnel looks busy.
  const { seam } = streamSeam([
    { conversationId: 1, entries: [{ entryId: 11, role: "assistant", text: "news", origin: "gchat" }] },
  ]);
  const served = await serveEvents(seam, [{ conversationId: 1, address: "spaces/S/threads/T" }]);
  try {
    const withNews = await fetch(`${served.baseUrl}/v1/poll?since=10&wait=0&conversation=1`);
    assert.match(withNews.headers.get("cache-control") ?? "", /max-age=3600/);
    assert.match(withNews.headers.get("cache-control") ?? "", /immutable/);
    assert.equal(withNews.headers.get("vary"), "Authorization", "scope is not in the URL, so it must vary");

    // Observation is live state, so it de-duplicates the cacheable answer above.
    const observed = await fetch(`${served.baseUrl}/v1/poll?since=10&wait=0&conversation=1&observe=1`);
    assert.match(observed.headers.get("cache-control") ?? "", /no-store/);

    // Nothing new: a state, never a fact.
    const empty = await fetch(`${served.baseUrl}/v1/poll?since=99&wait=0&conversation=1`);
    assert.match(empty.headers.get("cache-control") ?? "", /no-store/);
    assert.equal(empty.headers.get("cdn-cache-control"), "no-store");
  } finally {
    await served.close();
  }
});

test("a poll reports how long it waited, so a cached empty answer is detectable", async () => {
  const { seam } = streamSeam([{ conversationId: 1, entries: [] }]);
  const served = await serveEvents(seam, [{ conversationId: 1, address: "spaces/S/threads/T" }]);
  try {
    const response = await fetch(`${served.baseUrl}/v1/poll?since=5&wait=0.15`);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    assert.equal(response.headers.get("pragma"), "no-cache");

    const body = (await response.json()) as { waitedMs: number; cursor: number };
    assert.ok(body.waitedMs >= 100, "it reports its own patience, which is what makes a cached answer detectable");
    assert.equal(response.headers.get("x-poll-waited-ms"), String(body.waitedMs));
    assert.equal(body.cursor, 5, "and the cursor is unchanged, so a client resumes exactly where it was");
  } finally {
    await served.close();
  }
});
