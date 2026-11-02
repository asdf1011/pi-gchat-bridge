/**
 * One process per bridge database.
 *
 * pi-durable's SQLite storage has no cross-process locking, so two bridge
 * processes on the same `bridge.sqlite` do not corrupt anything — they simply
 * both run. That is worse than corruption in one specific way: both pull the
 * same Pub/Sub subscription and both hold the same conversation, so a message
 * arriving during the overlap gets answered twice. `requestId` does not help:
 * dedupe is per-harness, and these are two harnesses.
 *
 * This was not theoretical. Restarting the bridge mid-turn left the old process
 * finishing a reply while its replacement started, and Chat received the same
 * 1487-character answer twice, 0.3 s apart.
 *
 * The lock is a pid file, not an empty sentinel, so a stale lock (a process that
 * died without cleaning up — the common case when a container is killed) can be
 * detected and taken over instead of wedging the bridge forever.
 *
 * Scope: this guards *this host machine's* runs. It is not a distributed lock.
 * Two containers sharing a volume would each take it. For the single-container
 * deployment this bridge is designed for, that distinction does not arise; a
 * note here so it is not mistaken for something stronger than it is.
 */
import fs from "node:fs";
import path from "node:path";

export interface BridgeLock {
  /** Absolute path to the pid file. */
  path: string;
  /** Release the lock. Idempotent, and safe to call on a lock this process lost. */
  release(): void;
}

/** Thrown when another live process owns the database. */
export class BridgeLockedError extends Error {
  constructor(
    readonly lockPath: string,
    readonly ownerPid: number,
  ) {
    super(
      `bridge database is in use by pid ${ownerPid} (lock: ${lockPath}). ` +
        `Stop that process first: two bridges on one database both answer the same Chat message.`,
    );
    this.name = "BridgeLockedError";
  }
}

const LOCK_SUFFIX = ".lock";

/**
 * Take the lock for `dbPath`, or throw `BridgeLockedError`.
 *
 * `readPid` and `isAlive` exist so the stale-lock and retry behaviour can be
 * tested without spawning processes.
 */
export function acquireBridgeLock(
  dbPath: string,
  deps: { isAlive?: (pid: number) => boolean; retries?: number; retryDelayMs?: number } = {},
): BridgeLock {
  const lockPath = `${path.resolve(dbPath)}${LOCK_SUFFIX}`;
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const retries = deps.retries ?? 20;
  const retryDelayMs = deps.retryDelayMs ?? 25;

  for (let attempt = 0; ; attempt += 1) {
    try {
      // wx: create exclusively. This is the atomic part — two processes racing
      // here cannot both succeed.
      const fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, String(process.pid));
      fs.closeSync(fd);
      let released = false;
      return {
        path: lockPath,
        release() {
          if (released) return;
          released = true;
          // Only remove it if it is still ours: a lock taken over after we were
          // presumed dead must not be deleted by our exit handler.
          try {
            if (fs.readFileSync(lockPath, "utf8").trim() === String(process.pid)) {
              fs.unlinkSync(lockPath);
            }
          } catch {
            // Already gone, or unreadable: nothing to clean up.
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const owner = readPid(lockPath);
    if (owner === undefined) {
      // The file exists but has no readable pid yet — the owner is between
      // `open` and `write`. Give it a moment, then treat it as abandoned.
      if (attempt < retries) {
        sleepSync(retryDelayMs);
        continue;
      }
      safeUnlink(lockPath);
      continue;
    }
    if (isAlive(owner)) throw new BridgeLockedError(lockPath, owner);

    // Stale: the recorded process is gone. Remove it and try again. The unlink
    // is best-effort — losing the race to another waiter just means the next
    // loop iteration sees a live owner or takes the lock itself.
    safeUnlink(lockPath);
    if (attempt >= retries) throw new BridgeLockedError(lockPath, owner);
  }
}

/** The pid in the lock file, or undefined if it cannot be read or parsed. */
export function readPid(lockPath: string): number | undefined {
  try {
    const raw = fs.readFileSync(lockPath, "utf8").trim();
    if (!raw) return undefined;
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function safeUnlink(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // Someone else removed it first, which is a valid outcome.
  }
}

/** Synchronous by design: this runs during startup, before the event loop matters. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function defaultIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    // Signal 0 probes for existence without delivering anything. ESRCH means no
    // such process; EPERM means it exists but belongs to another user, which
    // still counts as alive.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
