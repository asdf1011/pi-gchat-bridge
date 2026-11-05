/**
 * Restart backoff, and the supervisor that uses it.
 *
 * The interesting cases are the ones that are not "restart once": a child that
 * dies immediately must not refork in a tight loop, and a run that survives must
 * reset the delay so the next one-off restart is immediate rather than five
 * minutes away.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  backoffDelayMs,
  DEFAULT_RESTART_POLICY,
  supervise,
  type RestartPolicy,
  type Supervisable,
} from "../src/session-host/supervisor.js";

const policy: RestartPolicy = { baseMs: 1_000, maxMs: 300_000, resetAfterMs: 60_000 };

test("the delay doubles and then holds at the ceiling", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((attempt) => backoffDelayMs(attempt, policy)),
    [1_000, 2_000, 4_000, 8_000, 16_000],
  );
  // Five minutes is the cap: an outage overnight must not schedule the next try
  // for hours, and the exponent is clamped so it cannot overflow.
  assert.equal(backoffDelayMs(20, policy), 300_000);
  assert.equal(backoffDelayMs(1_000_000, policy), 300_000);
  assert.equal(backoffDelayMs(0, policy), 1_000, "a nonsensical attempt still starts at the base");
  assert.equal(backoffDelayMs(3), 4_000, "the default policy is the documented one");
  assert.equal(DEFAULT_RESTART_POLICY.maxMs, 300_000);
});

/** A child that records whether it was killed, and can be made to exit. */
function fakeChild(): Supervisable & { exit: () => void; killed: boolean } {
  let listener: ((code: number | null, signal: string | null) => void) | undefined;
  return {
    killed: false,
    on(_event, fn) {
      listener = fn;
      return undefined;
    },
    kill() {
      this.killed = true;
      return true;
    },
    exit() {
      listener?.(1, null);
    },
  };
}

/** Deterministic timers: the supervisor's schedule is recorded, not waited for. */
function fakeClock() {
  const scheduled: { fn: () => void; ms: number }[] = [];
  return {
    scheduled,
    setTimeout: (fn: () => void, ms: number) => {
      scheduled.push({ fn, ms });
      return scheduled.length;
    },
    clearTimeout: () => {},
    /** Run the oldest pending timer, as time passing would. */
    tick() {
      scheduled.shift()?.fn();
    },
  };
}

test("a child that exits immediately is respawned with a growing delay", () => {
  const clock = fakeClock();
  const children: ReturnType<typeof fakeChild>[] = [];
  const logs: string[] = [];

  const supervisor = supervise({
    start: () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
    policy,
    log: (message) => logs.push(message),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });

  assert.equal(children.length, 1, "the first child starts immediately");

  // Three crashes in quick succession: each retry waits twice as long as the
  // last — 1s, 2s, 4s — and the fourth would be 8s.
  const delays: number[] = [];
  for (let index = 0; index < 3; index += 1) {
    children.at(-1)!.exit();
    assert.equal(clock.scheduled.length, 1, "one retry scheduled at a time");
    delays.push(clock.scheduled[0]!.ms);
    clock.tick();
  }
  children.at(-1)!.exit();
  delays.push(clock.scheduled[0]!.ms);

  assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000]);
  assert.equal(children.length, 4);
  assert.ok(logs.every((line) => line.includes("respawning in")), logs.join("\n"));
  supervisor.stop();
});

test("a run that lasts resets the delay, so the next restart is immediate", () => {
  const clock = fakeClock();
  const children: ReturnType<typeof fakeChild>[] = [];
  let clockNow = 0;
  const realDateNow = Date.now;

  const supervisor = supervise({
    start: () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
    policy,
    log: () => {},
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });

  try {
    // Crash once quickly: the retry is scheduled at 1s.
    children.at(-1)!.exit();
    assert.equal(clock.scheduled[0]!.ms, 1_000);
    clock.tick();

    // Pretend the next child ran for two minutes, then died: backoff resets, so
    // the delay is the base again rather than 2s.
    clockNow = Date.now() + 120_000;
    Date.now = () => clockNow;
    children.at(-1)!.exit();
    assert.equal(clock.scheduled[0]!.ms, 1_000, "a healthy run resets the backoff");
    clock.tick();
  } finally {
    Date.now = realDateNow;
    supervisor.stop();
  }
});

test("stop() kills the child and schedules nothing further", () => {
  const clock = fakeClock();
  const children: ReturnType<typeof fakeChild>[] = [];
  const supervisor = supervise({
    start: () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
    policy,
    log: () => {},
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });

  supervisor.stop();
  assert.equal(children[0]!.killed, true);

  // A late exit (the child winding down) must not spawn a replacement.
  children[0]!.exit();
  assert.equal(clock.scheduled.length, 0);
  assert.equal(children.length, 1);
  supervisor.stop(); // idempotent
  assert.equal(children[0]!.killed, true);
});
