/**
 * The bridge lock exists because a restart during a live turn produced two
 * identical replies in Chat. These tests pin the behaviour that prevents it,
 * and the stale-lock handling that keeps a killed container from wedging.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acquireBridgeLock, BridgeLockedError, readPid } from "../src/durable/lock.js";

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-lock-"));
  return path.join(dir, "bridge.sqlite");
}

test("the first process takes the lock and writes its pid", () => {
  const db = tmpDb();
  const lock = acquireBridgeLock(db);
  assert.equal(readPid(lock.path), process.pid);
  lock.release();
  assert.equal(fs.existsSync(lock.path), false);
});

test("a second process on the same database is refused, naming the owner", () => {
  const db = tmpDb();
  const lock = acquireBridgeLock(db);
  try {
    assert.throws(
      () => acquireBridgeLock(db, { isAlive: () => true, retryDelayMs: 1 }),
      (error: unknown) => {
        assert.ok(error instanceof BridgeLockedError);
        assert.equal(error.ownerPid, process.pid);
        // The message has to say what to do about it, not just that it failed.
        assert.match(error.message, /two bridges on one database/);
        return true;
      },
    );
  } finally {
    lock.release();
  }
});

test("a stale lock from a dead process is taken over, not obeyed", () => {
  const db = tmpDb();
  const lockPath = `${path.resolve(db)}.lock`;
  fs.writeFileSync(lockPath, "999999");

  // 999999 is not running, so the lock is abandoned and must be replaced.
  const lock = acquireBridgeLock(db, { isAlive: () => false, retryDelayMs: 1 });
  assert.equal(readPid(lock.path), process.pid);
  lock.release();
});

test("release only removes a lock this process still owns", () => {
  const db = tmpDb();
  const lock = acquireBridgeLock(db);
  // Simulate a takeover after this process was presumed dead.
  fs.writeFileSync(lock.path, "424242");
  lock.release();
  // The new owner's lock must survive our exit handler.
  assert.equal(readPid(lock.path), 424242);
  fs.unlinkSync(lock.path);
});

test("release is idempotent so a double close cannot throw", () => {
  const db = tmpDb();
  const lock = acquireBridgeLock(db);
  lock.release();
  lock.release();
  assert.equal(fs.existsSync(lock.path), false);
});

test("an empty lock file (owner between open and write) is waited on, then taken", () => {
  const db = tmpDb();
  const lockPath = `${path.resolve(db)}.lock`;
  fs.writeFileSync(lockPath, "");

  // Unreadable pid: readPid returns undefined, and after retries it is treated
  // as abandoned rather than blocking startup forever.
  const lock = acquireBridgeLock(db, { isAlive: () => true, retries: 2, retryDelayMs: 1 });
  assert.equal(readPid(lock.path), process.pid);
  lock.release();
});

test("readPid rejects nonsense instead of coercing it", () => {
  const db = tmpDb();
  const lockPath = `${path.resolve(db)}.lock`;
  fs.writeFileSync(lockPath, "not-a-pid");
  assert.equal(readPid(lockPath), undefined);
  fs.writeFileSync(lockPath, "-5");
  assert.equal(readPid(lockPath), undefined);
  fs.unlinkSync(lockPath);
});
