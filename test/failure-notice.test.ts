/**
 * Failure notices must tell a person what to *do*, not just what happened.
 *
 * These exist because a real turn failed with "unanswered" and nothing else:
 * no reason, no duration, and a notice telling the user to "send it again" when
 * the turn had simply been too slow on a local model. The status string is a
 * pi-durable internal; the useful distinction is retry / wait / change models.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { failureNotice } from "../src/durable/failure-notice.js";

test("an aborted turn says it was stopped, not that it failed", () => {
  const notice = failureNotice("unanswered", "aborted", 9000);
  assert.match(notice, /was stopped/);
  assert.match(notice, /aborted/);
  // The elapsed time is the clue that it was not a slow model.
  assert.match(notice, /9s/);
});

test("an interrupted turn is treated as a stop too", () => {
  assert.match(failureNotice("unanswered", "interrupted", 2000), /was stopped/);
});

test("an unexplained failure keeps the status and reason visible", () => {
  const notice = failureNotice("unanswered", "provider_error", 154_000);
  assert.match(notice, /provider_error/);
  assert.match(notice, /154s/);
  // A failure is worth retrying; an abort is not necessarily.
  assert.match(notice, /send it again/);
});

test("a done turn with no text suggests switching models instead of retrying", () => {
  const notice = failureNotice("done", undefined, 1200);
  assert.match(notice, /finished without producing any text/);
  assert.match(notice, /switch models/);
  assert.doesNotMatch(notice, /send it again/);
});

test("a missing reason does not produce a dangling separator", () => {
  const notice = failureNotice("unanswered", undefined, 5000);
  assert.doesNotMatch(notice, /\(\w+\):/);
  assert.doesNotMatch(notice, /:\s*after/);
});

test("sub-second durations render without a bare .0", () => {
  assert.match(failureNotice("unanswered", undefined, 400), /0\.4s/);
});

// --- provider failures -------------------------------------------------------
//
// The case these were added for: every turn failed on a 402, and the notice said
// "send it again" — advice that could not work, repeated until the user asked
// whether the bot was still working at all.

/** The detail the durable engine produced for the real outage. */
const REAL_402 =
  '402: {"message":"Insufficient Balance (request_id: 6420546f)","type":"insufficient_balance_error"}';

test("a balance failure says to top up, and does not suggest retrying", () => {
  const notice = failureNotice("unanswered", "model_error", 1600, REAL_402);
  assert.match(notice, /Insufficient Balance/);
  assert.match(notice, /\/quota/);
  assert.match(notice, /top up/i);
  assert.doesNotMatch(notice, /send it again/);
});

test("an auth failure points at config rather than at retrying", () => {
  const notice = failureNotice("unanswered", "model_error", 900, '401: {"message":"Invalid API key"}');
  assert.match(notice, /Invalid API key/);
  assert.match(notice, /\/model/);
  assert.doesNotMatch(notice, /send it again/);
});

test("a context overflow suggests compacting", () => {
  const notice = failureNotice(
    "unanswered",
    "model_error",
    2000,
    "400: maximum context length is 16384 tokens",
  );
  assert.match(notice, /\/compact/);
});

test("a throttle is still offered as a retry", () => {
  const notice = failureNotice("unanswered", "model_error", 800, "429: Rate limit reached");
  assert.match(notice, /retrying/i);
  assert.doesNotMatch(notice, /top up/i);
});

test("an unclassified model error keeps the generic retry wording", () => {
  const notice = failureNotice("unanswered", "model_error", 1500, "something odd happened");
  assert.match(notice, /send it again/);
  assert.match(notice, /something odd happened/);
});

test("an abort is never described as a provider problem", () => {
  const notice = failureNotice("unanswered", "aborted", 9000, REAL_402);
  assert.match(notice, /was stopped/);
  assert.doesNotMatch(notice, /top up/i);
});
