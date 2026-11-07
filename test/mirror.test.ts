/**
 * A turn started in the browser has to be visible in Chat, and it must not cost
 * more noise than the same turn typed in Chat.
 *
 * Two errors to avoid, and they pull against each other: dropping the turn from
 * Chat (the conversation is then incomplete in the surface the person actually
 * reads on a phone) and posting a separate message for the prompt (a
 * notification about words they typed a second earlier — the original
 * complaint). The compromise is one message per turn, quoting the prompt above
 * the answer, which is what these tests pin.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { chatTarget, mirrorTurn, quotePrompt, type MirrorDeps, type SettledTurn } from "../src/durable/mirror.js";

function fakeClient() {
  const calls: string[] = [];
  const client = {
    async sendMessage(space: string, text: string, thread?: string, opts?: { silent?: boolean }) {
      calls.push(`send ${space} thread=${thread ?? "-"} silent=${opts?.silent === true} :: ${text}`);
    },
    async createMessageWithThreadKey(space: string, text: string, threadKey: string) {
      calls.push(`keyed ${space} ${threadKey} :: ${text}`);
      return { threadName: `${space}/threads/keyed-${threadKey}` };
    },
  };
  return { client, calls };
}

const releases: string[] = [];
const relocations: string[] = [];

function deps(
  client: MirrorDeps["client"],
  options: {
    chatKey?: string;
    settled?: SettledTurn;
    claim?: boolean;
    painting?: boolean;
  } = {},
): MirrorDeps {
  return {
    client,
    chatKeyFor: async () => options.chatKey,
    awaitSubmission: async () =>
      options.settled ?? ({ status: "done", answerId: 7, text: "The build passes." } as SettledTurn),
    claimAnswer: async () => options.claim ?? true,
    releaseAnswer: async (key: string, answerId: number) => {
      releases.push(`${key}#${answerId}`);
    },
    isPainting: () => options.painting ?? false,
    relocate: async (key: string) => {
      relocations.push(key);
    },
    now: () => 1000,
  };
}

test("the prompt and the answer arrive as one message in the conversation's thread", async () => {
  const { client, calls } = fakeClient();
  const mirrored = await mirrorTurn(
    deps(client, { chatKey: "spaces/S/threads/T" }),
    1,
    42,
    "henry (webui): build?",
  );

  assert.equal(mirrored, true);
  assert.equal(calls.length, 1, "one message: a second one would be a second notification");
  // Threaded where the conversation lives (so continuity holds), prompt quoted
  // above the answer (so nothing is missing), and not silent (the answer is news).
  assert.match(calls[0] as string, /^send spaces\/S thread=spaces\/S\/threads\/T silent=false/);
  assert.match(calls[0] as string, /> henry \(webui\): build\?\n\nThe build passes\./);
});

test("a web-only conversation mirrors nothing", async () => {
  const { client, calls } = fakeClient();
  assert.equal(await mirrorTurn(deps(client), 1, 42, "hi"), false);
  assert.equal(await mirrorTurn(deps(client, { chatKey: "webui/local" }), 1, 42, "hi"), false);
  assert.deepEqual(calls, []);
});

test("a prompt that steers a turn Chat is painting is posted, in its own right", async () => {
  const { client, calls } = fakeClient();
  relocations.length = 0;
  // The Chat handler will post the answer, but these words are the person's and
  // are not in the thread yet: a missing message is worse than one more ping.
  const mirrored = await mirrorTurn(
    deps(client, { chatKey: "spaces/S/threads/T", painting: true }),
    1,
    42,
    "henry (webui): also check the tests",
  );

  assert.equal(mirrored, true);
  assert.deepEqual(calls, ["send spaces/S thread=spaces/S/threads/T silent=false :: henry (webui): also check the tests"]);
  // And the running reply moves below it, or the answer renders above the steer.
  assert.deepEqual(relocations, ["spaces/S/threads/T"]);
});

test("a prompt whose answer was posted elsewhere still reaches the thread", async () => {
  const { client, calls } = fakeClient();
  // Race: a steer, so both submissions watched the same turn and the other one
  // claimed the answer. The answer needs no second copy, but these words have
  // never been posted.
  assert.equal(await mirrorTurn(deps(client, { chatKey: "spaces/S/threads/T", claim: false }), 1, 42, "hi"), true);
  assert.deepEqual(calls, ["send spaces/S thread=spaces/S/threads/T silent=false :: hi"]);
});

test("a turn that produced nothing still lands in Chat, with the reason", async () => {
  const { client, calls } = fakeClient();
  const settled: SettledTurn = { status: "unanswered", reason: "aborted" };
  await mirrorTurn(deps(client, { chatKey: "spaces/S/threads/T", settled }), 1, 42, "henry (webui): hi");

  // A missing turn is the bug being fixed; "no answer" is still an outcome the
  // thread has to show, or the conversation reads as if the prompt was ignored.
  assert.equal(calls.length, 1);
  assert.match(calls[0] as string, /> henry \(webui\): hi/);
  assert.match(calls[0] as string, /was stopped/);
});

test("a keyed thread is joined by key, and overflow chunks go into it", async () => {
  const { client, calls } = fakeClient();
  const long = "x".repeat(9000);
  const settled: SettledTurn = { status: "done", answerId: 7, text: long };
  await mirrorTurn(deps(client, { chatKey: "spaces/S/cron-invites", settled }), 1, 42, "nightly");

  assert.match(calls[0] as string, /^keyed spaces\/S cron-invites/);
  assert.ok(calls.length >= 3, "a 9k answer is chunked, not truncated");
  for (const call of calls.slice(1)) {
    // Later chunks follow the first into the thread the keyed create returned.
    assert.match(call, /thread=spaces\/S\/threads\/keyed-cron-invites/);
  }
});

test("a top-level conversation posts the answer once, then silently", async () => {
  const { client, calls } = fakeClient();
  const settled: SettledTurn = { status: "done", answerId: 7, text: "y".repeat(9000) };
  await mirrorTurn(deps(client, { chatKey: "spaces/S", settled }), 1, 42, "");

  // The first message is the answer arriving, so it notifies; the rest is
  // continuation and asks to stay quiet where the API allows it.
  assert.match(calls[0] as string, /silent=false/);
  assert.match(calls[1] as string, /silent=true/);
});

test("a failed post hands the claim back, so the answer can still reach Chat", async () => {
  const client = {
    async sendMessage() {
      throw new Error("chat refused the post");
    },
    async createMessageWithThreadKey() {
      throw new Error("unused");
    },
  };
  releases.length = 0;
  await assert.rejects(
    mirrorTurn(deps(client, { chatKey: "spaces/S/threads/T" }), 1, 42, "hi"),
    /chat refused/,
  );
  // Otherwise the claim would suppress the Chat handler that could have posted it.
  assert.deepEqual(releases, ["spaces/S/threads/T#7"]);
});

test("a prompt is quoted line by line, so a paragraph break cannot end the quote", () => {
  assert.equal(quotePrompt("one"), "> one");
  assert.equal(quotePrompt("one\n\ntwo"), "> one\n>\n> two");
  assert.equal(quotePrompt("  "), "");
});

test("chat keys split into space, thread and thread key", () => {
  assert.deepEqual(chatTarget("spaces/S"), { space: "spaces/S" });
  assert.deepEqual(chatTarget("spaces/S/threads/T"), {
    space: "spaces/S",
    threadName: "spaces/S/threads/T",
  });
  // "threads" alone must not be read as a thread *key*: order matters here.
  assert.deepEqual(chatTarget("spaces/S/cron-invites"), { space: "spaces/S", threadKey: "cron-invites" });
  assert.equal(chatTarget(undefined), undefined);
  assert.equal(chatTarget(""), undefined);
  assert.equal(chatTarget("notspace"), undefined);
});
