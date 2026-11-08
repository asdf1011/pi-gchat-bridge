/**
 * The bridge's own memory: one cursor, and the rules that keep it from doing harm.
 *
 * The cursor is global because entry ids are: a single number addresses "everything that has
 * happened, in order", which is what lets the log be streamed (`GET /v1/events?since=`). The rules
 * under test are the ones that decide whether a lost state file costs one confused message or a
 * replayed conversation, plus the migration from the per-conversation map this used to be.
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

test("a first start has no position and is not an error", async () => {
  const ledger = await Ledger.load(fileFor());
  assert.equal(ledger.hasPosition(), false);
  assert.equal(ledger.cursor, 0);
  assert.equal(ledger.recovered, false, "a missing file is the normal first start");
});

test("an adopted position is where the bridge began, and why", async () => {
  const file = fileFor();
  const ledger = await Ledger.load(file);
  ledger.adopt(4100, "new", 1_700_000_000_000);
  await ledger.save();

  const reloaded = await Ledger.load(file);
  assert.equal(reloaded.cursor, 4100);
  assert.equal(reloaded.adoptedReason, "new");
  assert.deepEqual(reloaded.snapshot(), {
    version: 2,
    cursor: 4100,
    adoptedAt: 1_700_000_000_000,
    adoptedReason: "new",
  });
});

test("the cursor only moves forward", async () => {
  const ledger = await Ledger.load(fileFor());
  ledger.adopt(100, "new");
  ledger.advance(140);
  ledger.advance(120); // out of order: harmless, ignored
  ledger.advance(Number.NaN);
  assert.equal(ledger.cursor, 140);
});

test("advancing does not rewrite where the bridge began", async () => {
  const ledger = await Ledger.load(fileFor());
  ledger.adopt(100, "new", 5);
  ledger.advance(140);
  assert.equal(ledger.adoptedReason, "new");
  assert.equal(ledger.snapshot().adoptedAt, 5);
});

test("a corrupt file is treated as absent, and says so", async () => {
  const file = fileFor();
  await fsp.writeFile(file, "{ this is not json", "utf8");
  const ledger = await Ledger.load(file);
  assert.equal(ledger.recovered, true, "the caller must know the adoptions that follow are not history");
  assert.equal(ledger.hasPosition(), false);
});

test("a file from a future version is not guessed at", async () => {
  const file = fileFor();
  await fsp.writeFile(file, JSON.stringify({ version: 99, cursor: 5 }), "utf8");
  const ledger = await Ledger.load(file);
  assert.equal(ledger.recovered, true);
  assert.equal(ledger.hasPosition(), false);
});

test("per-conversation positions from version 1 become one cursor", async () => {
  // The migration this change needed: version 1 kept a position per conversation. The highest of
  // them is the safe global cursor — taking the maximum can only skip entries that a per-conversation
  // cursor would have re-read *below* the maximum anyway, which the sweep reads forward from.
  const file = fileFor();
  await fsp.writeFile(
    file,
    JSON.stringify({
      version: 1,
      conversations: {
        "1": { cursor: 400, adoptedAt: 1, adoptedReason: "new" },
        "2": { cursor: 950, adoptedAt: 2, adoptedReason: "new" },
        "3": { cursor: 120, adoptedAt: 3, adoptedReason: "gap" },
      },
    }),
    "utf8",
  );
  const ledger = await Ledger.load(file);
  assert.equal(ledger.cursor, 950);
  assert.equal(ledger.adoptedReason, "migrated");
  assert.equal(ledger.recovered, false, "a migration is not damage");
});

test("saving replaces the file, and leaves no temporary behind", async () => {
  const file = fileFor();
  const ledger = await Ledger.load(file);
  ledger.adopt(5, "new");
  await ledger.save();
  ledger.advance(6);
  await ledger.save();

  const siblings = (await fsp.readdir(path.dirname(file))).filter((name) => name.startsWith(path.basename(file)));
  assert.deepEqual(siblings, [path.basename(file)], "one file, no .tmp siblings");
  assert.equal(((await Ledger.load(file)).cursor as number), 6);
});

test("a save that cannot write is logged rather than thrown", async () => {
  // A directory where the file should be: the write fails, and a bridge must not die because its
  // bookkeeping cannot be persisted.
  const file = path.join(scratch, "blocked", "ledger.json");
  await fsp.mkdir(file, { recursive: true });
  const ledger = await Ledger.load(file);
  ledger.adopt(5, "new");
  await ledger.save(); // must not reject
  assert.equal(ledger.cursor, 5, "the in-memory position is still usable");
});
