/**
 * Which conversation a legacy `sessions/*.jsonl` file belongs to.
 *
 * Worth pinning because the mapping is lossy and one-shot: the file name is the
 * sanitized Chat key, and `/`, `-` and `_` all sanitize to `_`. Every test here
 * is a shape that actually exists in `sessions/`, and each one failed at least
 * once — the DM shapes were not handled at all, and the bound-key tie-break
 * matched every reading instead of one, so underscored keys silently won.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { deriveKey, readingsOf } from "../src/durable/import-all.js";

const sanitize = (key: string) => key.replace(/[^a-zA-Z0-9]/g, "_");
const knownFrom = (keys: string[]) => new Map(keys.map((key) => [sanitize(key), key] as const));

test("a direct message whose key is the space itself", () => {
  // A DM is a space of type DM. A non-threaded DM keys on the space, so the file
  // has no `_<tail>` at all — the pattern the first draft required.
  assert.equal(deriveKey("spaces_sPA7FKAAAAE.jsonl"), "spaces/sPA7FKAAAAE");
  assert.equal(deriveKey("spaces_AAQASvrFBA4.jsonl"), "spaces/AAQASvrFBA4");
});

test("a DM conversation keeps the hyphens of its real key", () => {
  // `conv-00b5b814`, not `conv_00b5b814`: the underscored key is one nothing
  // ever looks up, so the history would vanish into an unreachable conversation.
  assert.equal(
    deriveKey("spaces_sPA7FKAAAAE_conv_00b5b814.jsonl"),
    "spaces/sPA7FKAAAAE/conv-00b5b814",
  );
});

test("a hashed thread is settled by its hash, whatever the underscores say", () => {
  // `4-Xhvm-uLNc` sanitizes to `4_Xhvm_uLNc`, so the name cannot say where the
  // hyphens were; the hash appended by `sessionFileFor()` can.
  assert.equal(
    deriveKey("spaces_AAQASvrFBA4_threads_4_Xhvm_uLNc-276f3731.jsonl"),
    "spaces/AAQASvrFBA4/threads/4-Xhvm-uLNc",
  );
});

test("an ambiguous thread name is refused rather than guessed", () => {
  // `MKi-3_kJVwQ` mixes both characters. Without a hash and without a binding
  // there is no way to tell, and importing one thread's history into another's
  // conversation is worse than leaving it out.
  assert.equal(deriveKey("spaces_sPA7FKAAAAE_threads_MKi_3_kJVwQ.jsonl"), undefined);
});

test("a bound key settles the ambiguity the name cannot", () => {
  const known = knownFrom(["spaces/sPA7FKAAAAE/threads/MKi-3_kJVwQ"]);
  assert.equal(
    deriveKey("spaces_sPA7FKAAAAE_threads_MKi_3_kJVwQ.jsonl", known),
    "spaces/sPA7FKAAAAE/threads/MKi-3_kJVwQ",
  );
});

test("a bound key outranks the hyphenate-cron convention", () => {
  // The convention reads every underscore as a hyphen. That is right for these
  // names and wrong in general, so the binding — evidence — has to win.
  const known = knownFrom(["spaces/sPA7FKAAAAE/chat-api-release-notes-2026-08-15"]);
  assert.equal(
    deriveKey("spaces_sPA7FKAAAAE_chat_api_release_notes_2026_08_15.jsonl", known),
    "spaces/sPA7FKAAAAE/chat-api-release-notes-2026-08-15",
  );
});

test("an unbound cron name still follows the hyphen convention", () => {
  assert.equal(
    deriveKey("spaces_sPA7FKAAAAE_chat_api_release_notes_2026_08_15.jsonl"),
    "spaces/sPA7FKAAAAE/chat-api-release-notes-2026-08-15",
  );
});

test("readings span mixed hyphens and underscores, not just the two pure forms", () => {
  assert.deepEqual(readingsOf("a_b").sort(), ["a-b", "a_b"].sort());
  assert.equal(readingsOf("MKiv_3_kJVwQ").includes("MKiv-3_kJVwQ"), true);
  // 3 underscores is 8 readings; both pure forms are present, plus the mixes.
  assert.equal(readingsOf("a_b_c_d").length, 8);
});

test("a long cron name does not enumerate 2^n readings", () => {
  // `weekly_email_summary_2026_09_11` has 6 underscores, `chat_api_release_notes`
  // style names reach 20. Unbounded, that is a million strings per file — so past
  // the cap only the hyphenated and as-written readings are offered, which is
  // all any caller uses.
  const long = "weekly_email_summary_2026_09_11_and_more_words_here_to_be_long";
  const started = Date.now();
  const readings = readingsOf(long);
  assert.deepEqual(readings, [long.replace(/_/g, "-"), long]);
  assert.ok(Date.now() - started < 1000);
});
