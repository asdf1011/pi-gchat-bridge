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
import { runCli, loadState, saveState, say, tail, watch } from "../src/scripts/bridge-cli.js";
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

test("the CLI's watch follows by long poll and remembers its position", async () => {
  // The reference client after the move to polling: ask with the cursor, print what comes back,
  // remember it, ask again. No connection, so nothing to reconnect — which is the whole argument.
  const { seam } = streamSeam([
    { conversationId: 1, entries: [{ entryId: 60, role: "assistant", text: "the answer", origin: "gchat" }] },
  ]);
  const served = await serveEvents(seam, [{ conversationId: 1, address: "spaces/S/threads/T" }]);
  const file = path.join(scratch, `watch-${Date.now()}.json`);
  const lines: string[] = [];
  const stop = new AbortController();
  let running: Promise<number> | undefined;
  try {
    // Adopt first, so the pre-existing entry is deliberately not printed.
    await saveState(file, { version: 1, conversations: { "1": { cursor: 59 } } });
    running = watch(
      { baseUrl: served.baseUrl, statePath: file, out: (line) => lines.push(line) },
      { conversationId: 1, signal: stop.signal, waitSeconds: 1 },
    );
    for (let i = 0; i < 200 && !lines.some((line) => line.includes("[60]")); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(lines.some((line) => line.includes("[60] assistant:gchat: the answer")), lines.join("\n"));
    assert.deepEqual((await loadState(file)).conversations["1"], { cursor: 60 });
  } finally {
    stop.abort();
    await running?.catch(() => {});
    await served.close();
  }
});
