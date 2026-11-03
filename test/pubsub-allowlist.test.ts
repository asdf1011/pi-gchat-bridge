/**
 * The receiver's allow-list — including card clicks.
 *
 * This file exists because of a specific bug: the user check was written as
 *
 *     if (incoming.eventType === "MESSAGE" && !isAllowed(sender, allowedUsers))
 *
 * with a comment reasoning that card events "confirm bot cards the bridge itself
 * posted and never run pi tools directly". That was true until `/secret` landed,
 * at which point a card click could open an input whose submission stores a
 * credential. The gate was one word too narrow and nothing tested it.
 *
 * So there are two things to prove here:
 *
 *   1. `mapEvent` now carries the clicking user's identity on CARD_CLICKED.
 *      Without it the check below has nothing to check, which is why the hole
 *      was invisible for so long.
 *   2. The shared gate rejects a card click from a disallowed user. The check
 *      lives in the pull loop, which needs Pub/Sub; the *decision* is
 *      `isAllowed(sender, allowedUsers)` applied to every event type, so that is
 *      what is asserted directly — plus a guard against the exact regression
 *      (`eventType === "MESSAGE"`) by checking the source has no such cast.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { isAllowed } from "../src/access.js";
import { PubSubReceiver } from "../src/pubsub-receiver.js";

/** Build a receiver without opening Pub/Sub: only the mapper is exercised. */
function receiver(): PubSubReceiver {
  return Object.create(PubSubReceiver.prototype) as PubSubReceiver;
}

/** A raw Chat event as Pub/Sub delivers it. */
function rawEvent(overrides: Record<string, unknown> = {}): unknown {
  return {
    type: "CARD_CLICKED",
    space: { name: "spaces/S", type: "ROOM" },
    message: {
      name: "spaces/S/messages/CARD",
      thread: { name: "spaces/S/threads/T" },
      sender: { name: "users/operator", type: "HUMAN" },
    },
    action: { actionMethodName: "secret_set", parameters: [{ key: "name", value: "NEW_KEY" }] },
    common: { formInputs: { secret_value: { stringInputs: { value: ["sk-live-abcdefghijklmnop"] } } } },
    ...overrides,
  };
}

/** Call the private mapper the way the pull loop does. */
function map(incoming: unknown) {
  return (receiver() as unknown as { mapEvent: (event: unknown) => unknown }).mapEvent(incoming);
}

// --- Identity survives the mapping ------------------------------------------

test("a CARD_CLICKED event carries the clicking user", () => {
  const mapped = map(rawEvent()) as { message: { senderName?: string; senderType?: string } };
  assert.equal(mapped.message.senderName, "users/operator");
  assert.equal(mapped.message.senderType, "HUMAN");
});

test("a card click with no sender maps to an undefined sender, not a crash", () => {
  const mapped = map(
    rawEvent({ message: { name: "spaces/S/messages/CARD", thread: { name: "spaces/S/threads/T" } } }),
  ) as { message: { senderName?: string } };
  assert.equal(mapped.message.senderName, undefined);
});

// --- The gate itself ---------------------------------------------------------

test("a disallowed user's card click is rejected by the shared gate", () => {
  const mapped = map(rawEvent()) as { message: { senderName?: string } };
  assert.equal(isAllowed(mapped.message.senderName, ["users/someone-else"]), false);
});

test("an allowed user's card click passes", () => {
  const mapped = map(rawEvent()) as { message: { senderName?: string } };
  assert.equal(isAllowed(mapped.message.senderName, ["users/operator"]), true);
});

test("an empty allow-list still permits card clicks (no configuration, no restriction)", () => {
  const mapped = map(rawEvent()) as { message: { senderName?: string } };
  assert.equal(isAllowed(mapped.message.senderName, []), true);
});

// --- Guard against the exact regression -------------------------------------

test("the receiver does not narrow the user check to MESSAGE events", () => {
  // The bug was a one-term condition. Testing it behaviourally needs a live
  // Pub/Sub loop, so the condition itself is asserted instead: if someone
  // reintroduces an event-type guard, this fails and points at the reason.
  const source = fs.readFileSync(path.join(import.meta.dirname, "../src/pubsub-receiver.ts"), "utf8");
  const guard = /eventType\s*===?\s*["']MESSAGE["']\s*&&\s*!isAllowed\(/.exec(source);
  assert.equal(
    guard,
    null,
    "the sender allow-list must apply to every event type, not just MESSAGE — see test/secret-auth.test.ts",
  );
  assert.match(source, /!isAllowed\(incoming\.message\.senderName/, "the sender check must still exist");
});
