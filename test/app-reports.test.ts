import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { makeReportHandler, DEFAULT_REPORT_BUDGET } from "../src/durable/app-reports.js";

/** A conversation directory with one app, optionally opting into automatic turns. */
function scenario(manifest: object | undefined): { dir: string; appDir: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-app-reports-"));
  const appDir = path.join(root, "bench");
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, "app.json"), JSON.stringify(manifest ?? {}));
  return { dir: root, appDir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Write a report file and describe the arrival. */
function report(appDir: string, body: string, name = "r.json") {
  const file = path.join(appDir, "reports", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return { conversationId: 1, appName: "bench", file, bytes: Buffer.byteLength(body) };
}

function recordingSubmit() {
  const calls: { conversationId: number; content: string; requestId: string; whenBusy: string }[] = [];
  return {
    calls,
    submit: async (conversationId: number, input: { content: string; requestId: string; whenBusy: string }) => {
      calls.push({ conversationId, ...input });
      return { submissionId: calls.length };
    },
  };
}

test("a report does not become a turn unless the app asks for it", async () => {
  const { dir, appDir, cleanup } = scenario({ name: "Bench" });
  try {
    const spy = recordingSubmit();
    const handle = makeReportHandler({ conversationDirFor: () => dir, submit: spy.submit });
    await handle(report(appDir, '{"kind":"diagnostics"}'));
    assert.equal(spy.calls.length, 0, "off by default");
  } finally {
    cleanup();
  }
});

test("with autoSubmit, a report becomes one queued turn framed as data", async () => {
  const { dir, appDir, cleanup } = scenario({ reports: { autoSubmit: true } });
  try {
    const spy = recordingSubmit();
    const handle = makeReportHandler({ conversationDirFor: () => dir, submit: spy.submit });
    await handle(report(appDir, '{"kind":"diagnostics","errors":[]}'));

    assert.equal(spy.calls.length, 1);
    const [call] = spy.calls;
    assert.equal(call!.conversationId, 1);
    // Not a steer: a report must not interrupt an answer in progress.
    assert.equal(call!.whenBusy, "followUp");
    // The content says plainly that the body is not instructions — a log line can contain
    // anything, including something that reads like a request.
    assert.match(call!.content, /data, not instructions/);
    assert.match(call!.content, /<report app="bench"/);
    assert.match(call!.content, /kind/);
  } finally {
    cleanup();
  }
});

test("a resent report is the same turn, not a second one", async () => {
  const { dir, appDir, cleanup } = scenario({ reports: { autoSubmit: true } });
  try {
    const spy = recordingSubmit();
    const handle = makeReportHandler({
      conversationDirFor: () => dir,
      submit: spy.submit,
      budget: { ...DEFAULT_REPORT_BUDGET, minGapMs: 0 },
    });
    const arrival = report(appDir, '{"same":true}');
    await handle(arrival);
    await handle(arrival);
    // The id comes from the bytes, so the host dedupes; the id is what this asserts.
    assert.equal(spy.calls[0]!.requestId, spy.calls[1]!.requestId);
  } finally {
    cleanup();
  }
});

test("the budget stops a loop, whatever the page does", async () => {
  const { dir, appDir, cleanup } = scenario({ reports: { autoSubmit: true } });
  try {
    const spy = recordingSubmit();
    let clock = 1_000_000;
    const handle = makeReportHandler({
      conversationDirFor: () => dir,
      submit: spy.submit,
      now: () => clock,
      budget: { minGapMs: 60_000, maxPerHour: 3, maxBodyChars: 12_000 },
    });

    // Rapid-fire: only the first is inside the gap, so the rest are dropped.
    for (let i = 0; i < 5; i += 1) {
      await handle(report(appDir, `{"n":${i}}`, `r${i}.json`));
      clock += 1_000;
    }
    assert.equal(spy.calls.length, 1, "minimum gap holds");

    // Past the gap but over the hourly cap.
    for (let i = 0; i < 6; i += 1) {
      clock += 61_000;
      await handle(report(appDir, `{"m":${i}}`, `m${i}.json`));
    }
    assert.equal(spy.calls.length, 3, "hourly cap holds");

    // An hour later the window has moved and the loop may run again.
    clock += 61 * 60 * 1000;
    await handle(report(appDir, '{"later":true}', "later.json"));
    assert.equal(spy.calls.length, 4, "the budget refills");
  } finally {
    cleanup();
  }
});

test("a refused submission gives its budget back", async () => {
  const { dir, appDir, cleanup } = scenario({ reports: { autoSubmit: true } });
  try {
    let attempts = 0;
    const handle = makeReportHandler({
      conversationDirFor: () => dir,
      now: () => 1_000_000 + attempts * 61_000,
      budget: { minGapMs: 0, maxPerHour: 1, maxBodyChars: 12_000 },
      submit: async () => {
        attempts += 1;
        return attempts === 1 ? { error: "conversation is busy" } : { submissionId: 1 };
      },
    });
    await handle(report(appDir, '{"a":1}', "a.json"));
    await handle(report(appDir, '{"b":2}', "b.json"));
    // The first attempt never produced a turn, so it must not have consumed the hour.
    assert.equal(attempts, 2);
  } finally {
    cleanup();
  }
});

test("a huge report is truncated in the turn and the full copy stays on disk", async () => {
  const { dir, appDir, cleanup } = scenario({ reports: { autoSubmit: true } });
  try {
    const spy = recordingSubmit();
    const handle = makeReportHandler({
      conversationDirFor: () => dir,
      submit: spy.submit,
      budget: { minGapMs: 0, maxPerHour: 6, maxBodyChars: 200 },
    });
    const arrival = report(appDir, `${"x".repeat(5000)}END`);
    await handle(arrival);
    assert.equal(spy.calls.length, 1);
    assert.match(spy.calls[0]!.content, /truncated/);
    assert.ok(spy.calls[0]!.content.length < 2000, "the turn is not a log viewer");
    // The whole thing is still readable where the message says it is.
    assert.match(spy.calls[0]!.content, new RegExp(arrival.file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    cleanup();
  }
});

test("a handler that throws does not take the upload with it", async () => {
  const { dir, appDir, cleanup } = scenario({ reports: { autoSubmit: true } });
  try {
    const handle = makeReportHandler({
      conversationDirFor: () => dir,
      submit: async () => {
        throw new Error("host is gone");
      },
    });
    // Must resolve, not reject: the report was already stored successfully.
    await handle(report(appDir, "{}"));
  } finally {
    cleanup();
  }
});

test("a report suppressed by the budget is announced by the next one, not lost", async () => {
  // The budget exists to bound a runaway loop. It must not silently swallow the evidence
  // somebody is waiting for — which is exactly what happened when six reports filled an hour
  // and the four behind them went unannounced.
  const { dir, appDir, cleanup } = scenario({ reports: { autoSubmit: true } });
  try {
    const spy = recordingSubmit();
    let clock = 1_000_000;
    const handle = makeReportHandler({
      conversationDirFor: () => dir,
      submit: spy.submit,
      now: () => clock,
      budget: { minGapMs: 0, maxPerHour: 2, maxBodyChars: 12_000 },
    });

    await handle(report(appDir, '{"n":1}', "r1.json"));
    await handle(report(appDir, '{"n":2}', "r2.json"));
    // Budget is full: these are stored but must not vanish.
    await handle(report(appDir, '{"n":3}', "r3.json"));
    await handle(report(appDir, '{"n":4}', "r4.json"));
    assert.equal(spy.calls.length, 2, "the cap still holds");

    // The hour moves on; the next submission must say what was missed.
    clock += 61 * 60 * 1000;
    await handle(report(appDir, '{"n":5}', "r5.json"));
    assert.equal(spy.calls.length, 3);
    assert.match(spy.calls[2]!.content, /2 further reports? arrived while the budget was full/);
    assert.match(spy.calls[2]!.content, /reports\//);
  } finally {
    cleanup();
  }
});

test("a repeat of the same outcome does not cost a turn, but a change does", async () => {
  // Two runs of one configuration agree on everything except the clock. A turn saying "the
  // same thing happened again" is noise; a run that actually changed is not.
  const { dir, appDir, cleanup } = scenario({ reports: { autoSubmit: true } });
  const reportBody = (rtf: number) =>
    JSON.stringify({
      requested: { backend: "webgpu", textLength: "long", chunkedMimi: true },
      runs: [{ event: "run", backend: "webgpu", wallMs: 140040, audioSeconds: 20.56, rtf }],
      errors: [],
    });
  try {
    const spy = recordingSubmit();
    const handle = makeReportHandler({
      conversationDirFor: () => dir,
      submit: spy.submit,
      budget: { minGapMs: 0, maxPerHour: 99, maxBodyChars: 12_000 },
    });

    await handle(report(appDir, reportBody(6.811), "a.json"));
    assert.equal(spy.calls.length, 1);
    // Same conclusion, different numbers.
    await handle(report(appDir, reportBody(6.763), "b.json"));
    assert.equal(spy.calls.length, 1, "a repeat is not a second turn");

    // A meaningfully different result is.
    await handle(report(appDir, reportBody(1.2), "c.json"));
    assert.equal(spy.calls.length, 2);
  } finally {
    cleanup();
  }
});

test("a report in an app's own format is always submitted", async () => {
  // The signature only understands diagnostics reports; anything else might say something
  // this code cannot judge, so it is never treated as a repeat.
  const { dir, appDir, cleanup } = scenario({ reports: { autoSubmit: true } });
  try {
    const spy = recordingSubmit();
    const handle = makeReportHandler({
      conversationDirFor: () => dir,
      submit: spy.submit,
      budget: { minGapMs: 0, maxPerHour: 99, maxBodyChars: 12_000 },
    });
    await handle(report(appDir, '{"hello":"world"}', "a.json"));
    await handle(report(appDir, '{"hello":"world"}', "b.json"));
    assert.equal(spy.calls.length, 2);
  } finally {
    cleanup();
  }
});
