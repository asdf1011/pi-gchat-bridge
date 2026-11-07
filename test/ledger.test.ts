/**
 * The bridge's own memory: a cursor per conversation, and the rules that keep it
 * from doing harm.
 *
 * The rules under test are the ones that decide whether a lost state file costs one
 * confused message or a replayed conversation:
 *
 *   - a bridge with no position adopts at the head, never at zero;
 *   - a corrupt file is treated as absent, not as a reason to refuse to start;
 *   - the in-flight marker survives, so a crash mid-post is explainable;
 *   - the file is replaced atomically, so a kill cannot leave a cursor that reads
 *     as "no position at all".
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { Ledger } from "../src/durable/ledger.js";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
const fileFor = (): string => path.join(scratch, `ledger-${++counter}.json`);

test("a first start has no positions and is not an error", async () => {
  const ledger = await Ledger.load(fileFor());
  assert.equal(ledger.get(1), undefined);
  assert.equal(ledger.recovered, false, "a missing file is the normal first start");
});

test("an adopted position is where the bridge began, and why", async () => {
  const file = fileFor();
  const ledger = await Ledger.load(file);
  ledger.adopt(7, 4100, "new", 1_700_000_000_000);
  await ledger.save();

  const reloaded = await Ledger.load(file);
  assert.deepEqual(reloaded.get(7), {
    cursor: 4100,
    adoptedAt: 1_700_000_000_000,
    adoptedReason: "new",
  });
});

test("confirming advances the cursor and clears the in-flight marker", async () => {
  const ledger = await Ledger.load(fileFor());
  ledger.adopt(1, 100, "new");
  ledger.begin(1, 101, 5);
  assert.deepEqual(ledger.get(1)?.inFlight, { entryId: 101, startedAt: 5 });

  ledger.confirm(1, 101);
  assert.equal(ledger.get(1)?.cursor, 101);
  assert.equal(ledger.get(1)?.inFlight, undefined, "a confirmed post leaves nothing in doubt");
  // Adoption history is not rewritten by ordinary progress.
  assert.equal(ledger.get(1)?.adoptedReason, "new");
});

test("the cursor never goes backwards", async () => {
  const ledger = await Ledger.load(fileFor());
  ledger.adopt(1, 100, "new");
  ledger.confirm(1, 140);
  ledger.confirm(1, 120);
  assert.equal(ledger.get(1)?.cursor, 140);
});

test("an unconfirmed post survives a restart, so it can be reported", async () => {
  const file = fileFor();
  const first = await Ledger.load(file);
  first.adopt(3, 10, "new");
  first.begin(3, 11, 1_700_000_000_000);
  await first.save();

  // The process died between "Chat may have it" and "confirmed".
  const second = await Ledger.load(file);
  assert.deepEqual(second.get(3)?.inFlight, { entryId: 11, startedAt: 1_700_000_000_000 });
  assert.equal(second.get(3)?.cursor, 10, "a post in doubt does not count as progress");
});

test("a corrupt file is treated as absent, and says so", async () => {
  const file = fileFor();
  await fsp.writeFile(file, "{ this is not json", "utf8");
  const ledger = await Ledger.load(file);
  assert.equal(ledger.recovered, true, "the caller must know the adoptions that follow are not history");
  assert.equal(ledger.get(1), undefined);
});

test("a file from a future version is not guessed at", async () => {
  const file = fileFor();
  await fsp.writeFile(file, JSON.stringify({ version: 99, conversations: { "1": { cursor: 5 } } }), "utf8");
  const ledger = await Ledger.load(file);
  assert.equal(ledger.recovered, true);
  assert.equal(ledger.get(1), undefined);
});

test("saving replaces the file, and leaves no temporary behind", async () => {
  const file = fileFor();
  const ledger = await Ledger.load(file);
  ledger.adopt(1, 5, "new");
  await ledger.save();
  ledger.adopt(2, 6, "new");
  await ledger.save();

  const siblings = (await fsp.readdir(path.dirname(file))).filter((name) => name.startsWith(path.basename(file)));
  assert.deepEqual(siblings, [path.basename(file)], "one file, no .tmp siblings");
  const parsed = JSON.parse(await fsp.readFile(file, "utf8")) as { conversations: Record<string, unknown> };
  assert.deepEqual(Object.keys(parsed.conversations).sort(), ["1", "2"]);
});

test("a save that cannot write is logged rather than thrown", async () => {
  // A directory where the file should be: the write fails, and a bridge must not
  // die because its bookkeeping cannot be persisted.
  const file = path.join(scratch, "blocked", "ledger.json");
  await fsp.mkdir(file, { recursive: true });
  const ledger = await Ledger.load(file);
  ledger.adopt(1, 5, "new");
  await ledger.save(); // must not reject
  assert.equal(ledger.get(1)?.cursor, 5, "the in-memory position is still usable");
});
