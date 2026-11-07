/**
 * The cursor walk, in shadow mode: what it would post, and what it refuses to skip.
 *
 * Shadow mode is the point of this test file. The pass runs against real ledgers and
 * a fake transcript, posts nothing, and is asserted on two things that will still be
 * true when the painter replaces the logger:
 *
 *   - an entry is handed over **once**, in order, and the cursor moves past it;
 *   - nothing is silently skipped. A bridge that was away too long adopts at the
 *     head and says so, because "I missed 400 entries" is a fact, and "I skipped 400
 *     entries" is a bug.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { runPass, type EntryRef, type MessageLike, type PassDeps } from "../src/durable/delivery-pass.js";
import { Ledger } from "../src/durable/ledger.js";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pass-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
const fileFor = (): string => path.join(scratch, `ledger-${++counter}.json`);

/** A transcript: entry id → messages, in the order one entry holds them. */
type Transcript = Record<number, MessageLike[]>;

/** Build fake deps over one conversation, paging the way the seam pages. */
function fakeDeps(
  transcript: Transcript,
  options: { conversationId?: number; name?: string; owns?: (name: string) => boolean } = {},
): PassDeps & { presented: EntryRef[]; lines: string[] } {
  const conversationId = options.conversationId ?? 1;
  const messages: MessageLike[] = [];
  for (const entryId of Object.keys(transcript).map(Number).sort((a, b) => a - b)) {
    for (const message of transcript[entryId] ?? []) messages.push({ ...message, entryId });
  }
  const presented: EntryRef[] = [];
  const lines: string[] = [];
  return {
    presented,
    lines,
    conversations: async () => [
      { conversationId, name: options.name ?? "spaces/S/threads/T", lastActivityAt: 1_000 },
    ],
    owns: options.owns ?? (() => true),
    // Newest last, `offset` counting back from the newest — the seam's convention.
    history: async (_id: number, limit: number, offset: number) => {
      const end = Math.max(0, messages.length - offset);
      return messages.slice(Math.max(0, end - limit), end);
    },
    present: (entry: EntryRef) => {
      presented.push(entry);
    },
    log: (message: string) => lines.push(message),
    now: () => 1_000,
  };
}

const reply = (text: string, role: "user" | "assistant" = "assistant"): MessageLike => ({ role, text, at: 1 });

test("a first pass adopts at the head and presents nothing", async () => {
  const ledger = await Ledger.load(fileFor());
  const deps = fakeDeps({ 10: [reply("question", "user")], 11: [reply("answer")] });
  const summary = await runPass(ledger, deps);

  assert.equal(summary.adopted, 1);
  assert.equal(summary.presented, 0, "a conversation that already happened is not replayed");
  assert.equal(ledger.get(1)?.cursor, 11);
  assert.match(deps.lines.join("\n"), /adopted at entry 11/);
});

test("entries after the cursor are presented once each, in order", async () => {
  const ledger = await Ledger.load(fileFor());
  ledger.adopt(1, 11, "new");
  const deps = fakeDeps({ 11: [reply("old answer")], 12: [reply("next", "user")], 13: [reply("new answer")] });
  const summary = await runPass(ledger, deps);

  assert.deepEqual(
    deps.presented.map((entry) => [entry.entryId, entry.role, entry.text]),
    [
      [12, "user", "next"],
      [13, "assistant", "new answer"],
    ],
  );
  assert.equal(summary.presented, 2);
  assert.equal(ledger.get(1)?.cursor, 13);

  // Shadow mode: it said what it would do, and sent nothing.
  assert.match(deps.lines.join("\n"), /would post conversation 1 entry 13 \(assistant, 10 chars\)/);
  assert.match(deps.lines.join("\n"), /shadow mode, nothing was sent/);
});

test("a second pass over the same transcript does nothing", async () => {
  const ledger = await Ledger.load(fileFor());
  ledger.adopt(1, 11, "new");
  const transcript = { 12: [reply("one")] };
  const first = fakeDeps(transcript);
  await runPass(ledger, first);
  assert.equal(first.presented.length, 1);

  // The cursor is the whole of the memory: nothing is re-sent because nothing new
  // arrived, and that stays true across a restart of the process.
  const reloaded = await Ledger.load(fileFor());
  reloaded.adopt(1, 12, "new");
  const second = fakeDeps(transcript);
  await runPass(reloaded, second);
  assert.deepEqual(second.presented, []);
});

test("one entry with several messages is presented once", async () => {
  const ledger = await Ledger.load(fileFor());
  ledger.adopt(1, 5, "new");
  // An answer that arrived with an image, and a user entry with text plus a photo:
  // a surface posts an *entry*, not a message.
  const deps = fakeDeps({
    6: [
      { role: "user", text: "look", at: 1 },
      { role: "user", text: "", at: 2 },
    ],
  });
  await runPass(ledger, deps);
  assert.deepEqual(deps.presented.map((entry) => entry.entryId), [6]);
});

test("a gap beyond the pages read is adopted, not skipped", async () => {
  const ledger = await Ledger.load(fileFor());
  ledger.adopt(1, 1, "new");
  // 30 entries, and a page size of 5 with 2 pages: the cursor is out of reach.
  const transcript: Transcript = {};
  for (let id = 2; id <= 31; id += 1) transcript[id] = [reply(`entry ${id}`)];
  const deps = fakeDeps(transcript);
  const summary = await runPass(ledger, { ...deps, pageSize: 5, maxPages: 2 });

  assert.equal(summary.gaps, 1);
  assert.equal(summary.presented, 0, "entries it cannot prove it did not miss are not posted out of order");
  assert.equal(ledger.get(1)?.cursor, 31, "it starts again from the head");
  assert.equal(ledger.get(1)?.adoptedReason, "gap");
  assert.match(deps.lines.join("\n"), /adopting at entry 31 instead of replaying the gap/);
});

test("an empty conversation is adopted at zero, which is a real position", async () => {
  const ledger = await Ledger.load(fileFor());
  const deps = fakeDeps({});
  const summary = await runPass(ledger, deps);
  assert.equal(summary.adopted, 1);
  assert.equal(ledger.get(1)?.cursor, 0);

  // And the first thing said in it is presented, because zero is a position and not
  // "unknown".
  const later = fakeDeps({ 1: [reply("first words", "user")] });
  await runPass(ledger, later);
  assert.deepEqual(later.presented.map((entry) => entry.text), ["first words"]);
});

test("an unconfirmed post from an earlier run is reported", async () => {
  const ledger = await Ledger.load(fileFor());
  ledger.adopt(1, 10, "new");
  ledger.begin(1, 11, 1_000);
  const deps = fakeDeps({ 10: [reply("a")], 11: [reply("b")] });
  const summary = await runPass(ledger, deps);

  assert.deepEqual(summary.unfinished, [1]);
  assert.match(deps.lines.join("\n"), /may be on the surface twice/);
});

test("conversations this bridge does not own are left alone", async () => {
  const ledger = await Ledger.load(fileFor());
  const deps = fakeDeps({ 5: [reply("x")] }, { name: "webui/local-1", owns: (name) => name.startsWith("spaces/") });
  const summary = await runPass(ledger, deps);
  assert.equal(summary.looked, 0);
  assert.equal(ledger.get(1), undefined);
});

test("an unreadable conversation does not stop the rest", async () => {
  const ledger = await Ledger.load(fileFor());
  const lines: string[] = [];
  const presented: number[] = [];
  const summary = await runPass(ledger, {
    conversations: async () => [
      { conversationId: 1, name: "spaces/S/threads/A", lastActivityAt: 1_000 },
      { conversationId: 2, name: "spaces/S/threads/B", lastActivityAt: 1_000 },
    ],
    history: async (id: number) => {
      if (id === 1) throw new Error("storage hiccup");
      return [{ role: "assistant", text: "fine", entryId: 9, at: 1 }];
    },
    present: (entry) => presented.push(entry.conversationId),
    log: (message) => lines.push(message),
    now: () => 1_000,
  });
  assert.equal(summary.looked, 2);
  assert.deepEqual(presented, []);
  assert.equal(ledger.get(2)?.cursor, 9, "the healthy conversation still got a position");
  assert.match(lines.join("\n"), /conversation 1: storage hiccup/);
});

test("a position file that was unreadable is labelled as such, not as a first sight", async () => {
  const file = fileFor();
  fs.writeFileSync(file, "not json at all", "utf8");
  const ledger = await Ledger.load(file);
  const deps = fakeDeps({ 4: [reply("x")] });
  await runPass(ledger, deps);
  assert.equal(ledger.get(1)?.adoptedReason, "lost-position");
  assert.match(deps.lines.join("\n"), /position file was unreadable/);
});
