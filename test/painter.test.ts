/**
 * The painter: the one mouth a surface has.
 *
 * These are the decisions that were previously spread over two posters and a claim
 * protocol, so they are worth pinning one at a time: an answer is painted once, a
 * turn's commentary never, a placeholder becomes the answer rather than a second
 * message, and an answer from another surface carries that surface's prompt because
 * Chat has no other way to show it.
 *
 * No Chat client, no store: the surface and the view are fakes, which is the point —
 * the interesting behaviour is the ordering, not the transport.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { Ledger } from "../src/durable/ledger.js";
import { Painter, type PaintStream, type PaintSurface } from "../src/durable/painter.js";
import type { MessageLike } from "../src/durable/delivery-pass.js";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "paint-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

let counter = 0;

/** A transcript: entry id → the messages that entry carries. */
type Transcript = Record<number, MessageLike[]>;

function fakeSurface() {
  const streams: { conversationId: number; calls: string[] }[] = [];
  const posted: { conversationId: number; text: string }[] = [];
  const surface: PaintSurface = {
    open: async (conversationId) => {
      const record = { conversationId, calls: [] as string[] };
      streams.push(record);
      const stream: PaintStream = {
        text: (full) => record.calls.push(`text:${full.length}`),
        tool: (name) => record.calls.push(`tool:${name}`),
        clearTool: () => record.calls.push("clear"),
        finish: async (text) => record.calls.push(`finish:${text.length}`),
        abandon: async () => record.calls.push("abandon"),
      };
      return { stream, detach() {} };
    },
    post: async (conversationId, text) => posted.push({ conversationId, text }),
  };
  return {
    surface,
    streams,
    posted,
    /**
     * Drive the stream the way the surface's view subscription would.
     *
     * Opening a stream *is* subscribing it — on a real transport a placeholder must
     * exist before it can be patched — so the painter's contract under test is "open
     * once, never post" and the frames are the surface's business.
     */
    driveText: (index: number, text: string) => {
      const record = streams[index];
      if (record) record.calls.push(`text:${text.length}`);
    },
  };
}

function painterFor(
  ledger: Ledger,
  transcript: Transcript,
  options: { busy?: boolean; owns?: (id: number) => boolean; conversationId?: number } = {},
) {
  const fake = fakeSurface();
  const conversationId = options.conversationId ?? 1;
  const messages: MessageLike[] = [];
  for (const id of Object.keys(transcript).map(Number).sort((a, b) => a - b)) {
    for (const message of transcript[id] ?? []) messages.push({ ...message, entryId: id });
  }
  const painter = new Painter({
    surface: "gchat",
    ledger,
    owns: options.owns ?? (() => true),
    conversations: async () => [{ conversationId }],
    history: async (_id, limit, offset) => {
      const end = Math.max(0, messages.length - offset);
      return messages.slice(Math.max(0, end - limit), end);
    },
    busy: async () => options.busy ?? false,
    surfaceClient: fake.surface,
    log: () => {},
  });
  return { painter, ...fake };
}

const answer = (text: string, origin = "gchat"): MessageLike => ({ role: "assistant", text, origin, at: 1 });
const commentary = (text: string): MessageLike => ({ role: "assistant", text, at: 1 });
const prompt = (text: string, origin: string): MessageLike => ({ role: "user", text, origin, at: 1 });

test("a settled answer is painted once, then the cursor is past it", async () => {
  const ledger = await Ledger.load(path.join(scratch, `l${++counter}.json`));
  ledger.adopt(1, 10, "new");
  const { painter, posted } = painterFor(ledger, { 10: [prompt("hi", "gchat")], 11: [answer("the answer")] });

  const summary = await painter.tick();
  assert.equal(summary.painted, 1);
  assert.deepEqual(posted, [{ conversationId: 1, text: "the answer" }]);
  assert.equal(ledger.get(1)?.cursor, 11, "the cursor is the retry story: behind = try again");

  // A second tick has nothing to do — the entry is accounted for.
  const again = await painter.tick();
  assert.equal(again.painted, 0);
  assert.equal(posted.length, 1);
});

test("a turn's commentary is never painted", async () => {
  const ledger = await Ledger.load(path.join(scratch, `l${++counter}.json`));
  ledger.adopt(1, 10, "new");
  const { painter, posted } = painterFor(ledger, {
    11: [commentary("checking now")],
    12: [commentary("and the tests")],
    13: [answer("all done")],
  });

  await painter.tick();
  // One message for the turn, not three: an assistant entry only counts as an answer
  // when the host stamped it as one.
  assert.deepEqual(posted, [{ conversationId: 1, text: "all done" }]);
  assert.equal(ledger.get(1)?.cursor, 13);
});

test("several submissions that share one answer produce exactly one post", async () => {
  // The production bug this replaces a whole claim mechanism to prevent: four messages
  // queued behind a stuck tool all settled on one assistant entry, and the bridge posted
  // that entry once per submission — four identical 2.5k-character replies. The painter
  // cannot reproduce it, because it posts *entries* and there is one of those.
  const ledger = await Ledger.load(path.join(scratch, `l${++counter}.json`));
  ledger.adopt(1, 10, "new");
  const { painter, posted } = painterFor(ledger, {
    11: [prompt("first", "gchat")],
    12: [prompt("second", "gchat")],
    13: [prompt("third", "gchat")],
    14: [prompt("fourth", "gchat")],
    15: [answer("the one answer")],
  });

  await painter.tick();
  assert.deepEqual(posted, [{ conversationId: 1, text: "the one answer" }]);
  assert.equal(ledger.get(1)?.cursor, 15);
});

test("a running turn streams into the placeholder instead of posting", async () => {
  const ledger = await Ledger.load(path.join(scratch, `l${++counter}.json`));
  ledger.adopt(1, 10, "new");
  const { painter, streams, posted, driveText } = painterFor(
    ledger,
    { 11: [prompt("hi", "gchat")] },
    { busy: true },
  );

  await painter.tick();
  assert.equal(streams.length, 1, "a placeholder is opened");
  assert.deepEqual(posted, [], "nothing is posted while the turn runs");

  // The view is what a running turn is: live text and tool state, not entries.
  driveText(0, "Thinking");
  assert.deepEqual(streams[0]!.calls, ["text:8"]);

  // The turn never wrote an entry, so a second tick does not open a second stream.
  await painter.tick();
  assert.equal(streams.length, 1);
});

test("the placeholder becomes the answer in place", async () => {
  const ledger = await Ledger.load(path.join(scratch, `l${++counter}.json`));
  ledger.adopt(1, 10, "new");
  let busy = true;
  const fake = fakeSurface();
  const messages: MessageLike[] = [{ role: "user", text: "hi", origin: "gchat", entryId: 11, at: 1 }];
  const painter = new Painter({
    surface: "gchat",
    ledger,
    owns: () => true,
    conversations: async () => [{ conversationId: 1 }],
    history: async (_id, limit, offset) => {
      const end = Math.max(0, messages.length - offset);
      return messages.slice(Math.max(0, end - limit), end);
    },
    busy: async () => busy,
    surfaceClient: fake.surface,
    log: () => {},
  });

  await painter.tick();
  assert.equal(fake.streams.length, 1);

  // The turn settles: the answer appears as an entry and the view goes idle.
  busy = false;
  messages.push({ role: "assistant", text: "the answer", origin: "gchat", entryId: 12, at: 1 });
  const summary = await painter.tick();

  assert.equal(summary.streamed, 1);
  assert.deepEqual(fake.streams[0]!.calls, ["finish:10"], "patched in place, not posted again");
  assert.deepEqual(fake.posted, [], "a second create would be a second notification");
  assert.equal(ledger.get(1)?.cursor, 12);
});

test("an answer to another surface's prompt carries that prompt", async () => {
  const ledger = await Ledger.load(path.join(scratch, `l${++counter}.json`));
  ledger.adopt(1, 10, "new");
  const { painter, posted } = painterFor(ledger, {
    11: [prompt("typed in the browser", "webui")],
    12: [answer("typed in the browser", "webui")],
  });

  await painter.tick();
  assert.equal(posted.length, 1);
  // Chat cannot show a web message as the person, so the answer quotes it — the trade
  // `mirror.ts` made, now in the one component that posts.
  assert.match(posted[0]!.text, /^> typed in the browser\n\ntyped in the browser$/);
});

test("a prompt typed in Chat is not quoted back at it", async () => {
  const ledger = await Ledger.load(path.join(scratch, `l${++counter}.json`));
  ledger.adopt(1, 10, "new");
  const { painter, posted } = painterFor(ledger, {
    11: [prompt("typed in chat", "gchat")],
    12: [answer("the answer", "gchat")],
  });
  await painter.tick();
  assert.deepEqual(posted, [{ conversationId: 1, text: "the answer" }]);
});

test("a conversation this painter does not own is left alone", async () => {
  const ledger = await Ledger.load(path.join(scratch, `l${++counter}.json`));
  ledger.adopt(1, 10, "new");
  const { painter, posted, streams } = painterFor(ledger, { 11: [answer("x")] }, { owns: () => false });

  const summary = await painter.tick();
  assert.equal(summary.painted, 0);
  assert.deepEqual(posted, []);
  assert.deepEqual(streams, []);
  assert.equal(ledger.get(1)?.cursor, 10, "not owned means untouched, not advanced");
});

test("a turn that produced no answer leaves no placeholder and no message", async () => {
  const ledger = await Ledger.load(path.join(scratch, `l${++counter}.json`));
  ledger.adopt(1, 10, "new");
  const fake = fakeSurface();
  let busy = true;
  const messages: MessageLike[] = [{ role: "user", text: "hi", origin: "gchat", entryId: 11, at: 1 }];
  const painter = new Painter({
    surface: "gchat",
    ledger,
    owns: () => true,
    conversations: async () => [{ conversationId: 1 }],
    history: async (_id, limit, offset) => {
      const end = Math.max(0, messages.length - offset);
      return messages.slice(Math.max(0, end - limit), end);
    },
    busy: async () => busy,
    surfaceClient: fake.surface,
    log: () => {},
  });

  await painter.tick(); // opens a placeholder
  busy = false; // the turn ended without an answer entry
  messages.push({ role: "assistant", text: "checking", entryId: 12, at: 1 }); // commentary only
  await painter.tick();

  assert.deepEqual(fake.streams[0]!.calls, ["abandon"], "the placeholder goes, rather than hanging there");
  assert.deepEqual(fake.posted, [], "and the failure notice is not this component's to write");
  assert.equal(ledger.get(1)?.cursor, 12, "the commentary is accounted for so it is not re-read");
});

test("two ticks cannot both post the same answer", async () => {
  // A wake on the way into a turn and a wake on the way out can land together, and the
  // interval can fire at the same moment. Two ticks reading one unposted answer would
  // each post it — the duplication this component exists to prevent, so ticks queue.
  const ledger = await Ledger.load(path.join(scratch, `l${++counter}.json`));
  ledger.adopt(1, 10, "new");
  const { painter, posted } = painterFor(ledger, { 11: [answer("the answer")] });

  await Promise.all([painter.tick(), painter.tick(), painter.tick()]);
  assert.deepEqual(posted, [{ conversationId: 1, text: "the answer" }]);
});

test("a cursor too far behind is adopted, never repainted", async () => {
  // The failure this exists for: the bridge was down for a week, the cursor sits at the
  // far end, and walking forward would put every missed answer into the thread as a burst
  // of messages. That is a replay, not catch-up, so the position is abandoned loudly and
  // the conversation resumes from the head.
  const ledger = await Ledger.load(path.join(scratch, `l${++counter}.json`));
  ledger.adopt(1, 1, "new");
  const transcript: Transcript = {};
  for (let id = 2; id <= 40; id += 1) transcript[id] = [answer(`entry ${id}`)];

  const fake = fakeSurface();
  const messages: MessageLike[] = [];
  for (const id of Object.keys(transcript).map(Number).sort((a, b) => a - b)) {
    for (const message of transcript[id] ?? []) messages.push({ ...message, entryId: id });
  }
  const painter = new Painter({
    surface: "gchat",
    ledger,
    owns: () => true,
    conversations: async () => [{ conversationId: 1 }],
    history: async (_id, limit, offset) => {
      const end = Math.max(0, messages.length - offset);
      return messages.slice(Math.max(0, end - limit), end);
    },
    busy: async () => false,
    surfaceClient: fake.surface,
    pageSize: 5,
    maxPages: 2,
    log: () => {},
  });

  const summary = await painter.tick();
  assert.equal(summary.adopted, 1);
  assert.equal(summary.painted, 0);
  assert.deepEqual(fake.posted, [], "39 missed answers are not posted");
  assert.equal(ledger.get(1)?.cursor, 40, "it starts again from the head");
  assert.equal(ledger.get(1)?.adoptedReason, "gap");
});

test("a conversation with no position is adopted at the head, not replayed", async () => {
  // The painter owns its conversations outright, so nobody else is going to take a
  // position for it. Adopting at the head is the same rule the shadow pass uses: the
  // history that predates this bridge is not repainted, and the first thing said after
  // it is.
  const ledger = await Ledger.load(path.join(scratch, `l${++counter}.json`));
  const { painter, posted } = painterFor(ledger, { 11: [answer("x"), { role: "user", text: "hi", origin: "gchat", at: 1 }] });

  const first = await painter.tick();
  assert.equal(first.painted, 0, "adoption is not painting");
  assert.deepEqual(posted, [], "nothing that already happened is repainted");
  assert.equal(ledger.get(1)?.cursor, 11);
  assert.equal(ledger.get(1)?.adoptedReason, "new");
});

test("a poke finishes the answer immediately, without waiting for a tick", async () => {
  // The settle edge of a view frame calls this, which is what stops a finished turn from
  // sitting unposted until the next tick. It does the same work a tick does for one
  // conversation, so there is one definition of "here is the answer".
  const ledger = await Ledger.load(path.join(scratch, `l${++counter}.json`));
  ledger.adopt(1, 10, "new");
  const { painter, posted } = painterFor(ledger, { 11: [answer("the answer")] });

  await painter.poke(1);
  assert.deepEqual(posted, [{ conversationId: 1, text: "the answer" }]);
  assert.equal(ledger.get(1)?.cursor, 11);
});

test("a poke does nothing for a conversation this painter does not own, or has not adopted", async () => {
  const ledger = await Ledger.load(path.join(scratch, `l${++counter}.json`));
  const { painter, posted } = painterFor(ledger, { 11: [answer("x")] }, { owns: () => false });
  await painter.poke(1);
  assert.deepEqual(posted, [], "not owned, not painted");

  // Owned but never adopted: a poke must not invent a position, or the first thing it saw
  // would be treated as already-delivered history.
  const fresh = await Ledger.load(path.join(scratch, `l${++counter}.json`));
  const second = painterFor(fresh, { 11: [answer("x")] });
  await second.painter.poke(1);
  assert.deepEqual(second.posted, []);
  assert.equal(fresh.get(1), undefined, "adoption stays the tick's job");
});
