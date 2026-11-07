/**
 * The steer cap: a message must not be able to wait forever behind a tool.
 *
 * The rules under test are the ones that decide whether the cap helps or hurts:
 *
 *   - it cuts short the tools the steer is waiting behind, and only those;
 *   - a steer that got placed on its own is left alone — the cap bounds the wait,
 *     not the tool;
 *   - a wait that is not behind a tool is not its business at all;
 *   - one abort that fails does not abandon the others;
 *   - disabled means disabled: nothing is scheduled.
 *
 * The seam is injected, so none of this needs a harness, a conversation or ten
 * real seconds.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  armSteerWatch,
  runSteerWatch,
  type SteerWatchDeps,
  type SteerTarget,
} from "../src/durable/steer-watch.js";

const target: SteerTarget = { conversationId: 7, submissionId: 96 };

/** Deps with the behaviour each test cares about spelled out, and nothing else. */
function deps(overrides: Partial<SteerWatchDeps> = {}): SteerWatchDeps & { logs: string[] } {
  const logs: string[] = [];
  return {
    steerWaitMs: 10_000,
    isWaiting: async () => true,
    runningTools: async () => [],
    abortTask: async () => "marked",
    log: (message) => logs.push(message),
    ...overrides,
    logs,
  };
}

test("a steer still queued behind a running tool aborts that tool", async () => {
  const aborted: number[] = [];
  const watch = deps({
    runningTools: async (conversationId) => {
      assert.equal(conversationId, 7, "the conversation asked about is the one waiting");
      return [41];
    },
    abortTask: async (taskId) => {
      aborted.push(taskId);
      return "marked";
    },
  });

  assert.equal(await runSteerWatch(watch, target), "aborted");
  assert.deepEqual(aborted, [41]);
  assert.match(watch.logs.join("\n"), /aborting tool task 41/, "the cut is logged, not silent");
});

test("every tool the steer is behind is aborted, not just the first", async () => {
  const aborted: number[] = [];
  const watch = deps({
    runningTools: async () => [41, 42],
    abortTask: async (taskId) => {
      aborted.push(taskId);
      return "marked";
    },
  });

  await runSteerWatch(watch, target);
  assert.deepEqual(aborted, [41, 42]);
});

test("a steer the boundary already placed is left alone", async () => {
  const aborted: number[] = [];
  const watch = deps({
    isWaiting: async () => false,
    runningTools: async () => [41],
    abortTask: async (taskId) => {
      aborted.push(taskId);
      return "marked";
    },
  });

  assert.equal(await runSteerWatch(watch, target), "not-waiting");
  assert.deepEqual(aborted, [], "a tool that finished inside the cap is never cut short");
});

test("a wait that is not behind a tool is left to the model timeout", async () => {
  const aborted: number[] = [];
  const watch = deps({
    runningTools: async () => [],
    abortTask: async (taskId) => {
      aborted.push(taskId);
      return "marked";
    },
  });

  assert.equal(await runSteerWatch(watch, target), "no-tools");
  assert.deepEqual(aborted, [], "a slow model request is `stream.timeoutMs`'s business");
});

test("one abort that fails does not abandon the others", async () => {
  const aborted: number[] = [];
  const watch = deps({
    runningTools: async () => [41, 42],
    abortTask: async (taskId) => {
      aborted.push(taskId);
      if (taskId === 41) throw new Error("already terminal");
      return "marked";
    },
  });

  // A failed rescue is a log line, never a rejection: this runs from a timer.
  assert.equal(await runSteerWatch(watch, target), "aborted");
  assert.deepEqual(aborted, [41, 42]);
  assert.match(watch.logs.join("\n"), /abort of tool task 41 failed: already terminal/);
});

test("nothing is scheduled when the cap is disabled", () => {
  let scheduled = 0;
  const watch = deps({
    steerWaitMs: 0,
    schedule: () => {
      scheduled += 1;
      return () => {};
    },
  });

  const cancel = armSteerWatch(watch, target);
  assert.equal(scheduled, 0, "steerWaitMs 0 means the caller runs unbounded, deliberately");
  cancel();
});

test("arming checks once, when the cap expires", async () => {
  let fire: (() => void) | undefined;
  let cancelled = 0;
  const aborted: number[] = [];
  const watch = deps({
    runningTools: async () => [41],
    abortTask: async (taskId) => {
      aborted.push(taskId);
      return "marked";
    },
    schedule: (fn, ms) => {
      assert.equal(ms, 10_000);
      fire = fn;
      return () => {
        cancelled += 1;
      };
    },
  });

  const cancel = armSteerWatch(watch, target);
  assert.equal(fire !== undefined, true, "the expiry is scheduled");
  assert.deepEqual(aborted, [], "and does nothing before it expires");

  const done = new Promise<void>((resolve) => {
    const inner = watch.abortTask;
    watch.abortTask = async (taskId) => {
      const result = await inner(taskId);
      resolve();
      return result;
    };
  });
  fire?.();
  await done;
  assert.deepEqual(aborted, [41]);

  cancel();
  assert.equal(cancelled, 1, "the canceller reaches the timer");
});
