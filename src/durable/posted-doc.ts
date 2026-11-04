/**
 * Which answer has already been delivered to which Chat thread.
 *
 * One durable run can answer *several* Chat messages. That is the point of
 * `whenBusy: "steer"`: a message that arrives while the conversation is busy
 * joins the run in progress instead of starting a second one, which is what the
 * old bridge's steer queue did by hand. pi-durable settles every submission
 * that a run answers with the **same** `EntryId`:
 *
 *     submission 8674 (06:59 "Add a hint for tests…")  → answer 8742
 *     submission 8709 (07:00 "Let's kill that process") → answer 8742
 *
 * The bridge then posted `settled.answer` once per submission, so one reply
 * appeared twice — or, after a four-hour tool hang queued four messages in one
 * thread, four times verbatim:
 *
 *     submission 8447 → answer 8789      (2533 chars)
 *     submission 8471 → answer 8789      (2533 chars)
 *     submission 8472 → answer 8789      (2533 chars)
 *     submission 8708 → answer 8789      (2533 chars)
 *
 * `requestId` dedupe did not help: those are four *different* Chat messages, so
 * four different requests, correctly admitted once each. The duplication is not
 * in the model — it is in the last inch, where a settled answer became a Chat
 * message. Hence a claim keyed by the answer entry rather than by the message.
 *
 * The claim also covers redelivery that survives a crash: a handler that posts
 * and then dies before acking leaves the message unacked, Pub/Sub redelivers it,
 * the done submission is found again by `requestId` — and without this record the
 * same answer would be posted a second time.
 *
 * Session-scoped because it indexes conversations (same reason as
 * `bindings-doc.ts`): a conversation document cannot name its own answer either.
 * Only the newest answer per Chat key is kept; answers within a conversation are
 * produced one run at a time, so a single slot is enough to make the last post
 * idempotent, and the document stays small.
 */
import { defineDoc } from "@earendil-works/pi-durable";

import type { BridgeHost } from "./host.js";

export type PostedAnswer = {
  /** pi-durable `EntryId` of the assistant entry that was posted. */
  answerId: number;
  /** Epoch ms of the claim, so a stuck claim is visible when debugging. */
  at: number;
};

// A type alias, not an interface: pi-durable's JsonObject needs an implicit
// index signature, which interfaces never get.
export type PostedAnswersValue = {
  /** Chat conversation key (`keyFor(space, thread, threadKey)`) → last posted answer. */
  byChatKey: Record<string, PostedAnswer>;
};

export const PostedAnswersDoc = defineDoc<PostedAnswersValue>({
  kind: "gchat.posted-answers",
  version: 1,
  scope: "session",
  initial: () => ({ byChatKey: {} }),
  checkpointWhen: () => true,
});

/**
 * Claim the right to post `answerId` into the Chat thread behind `chatKey`.
 *
 * Returns true for exactly one caller per (chatKey, answerId): the commit is
 * serialized by the harness, and the check and the write happen inside it, so
 * two handlers waking from the same settled answer cannot both win.
 *
 * A *later* answer takes the slot; an equal or older one is refused. Entry IDs
 * are drawn from one global sequence, so the comparison is meaningful, and it
 * also means a stale answer can never be posted again after a newer one — the
 * one ordering the guard has to survive.
 */
export async function claimAnswer(host: BridgeHost, chatKey: string, answerId: number): Promise<boolean> {
  if (!Number.isFinite(answerId)) return true; // nothing to key on: better two than none
  return host.harness.commit(async (tx) => {
    const doc = await tx.doc(PostedAnswersDoc);
    const last = doc.byChatKey[chatKey];
    if (last && answerId <= last.answerId) return false;
    doc.byChatKey[chatKey] = { answerId, at: Date.now() };
    return true;
  }, host.context);
}

/**
 * Give the claim back after a post that failed outright, so a concurrent handler
 * for the same answer (or a redelivery) still gets to deliver it. Only clears the
 * slot if it is still *this* answer's.
 */
export async function releaseAnswer(host: BridgeHost, chatKey: string, answerId: number): Promise<void> {
  if (!Number.isFinite(answerId)) return;
  await host.harness.commit(async (tx) => {
    const doc = await tx.doc(PostedAnswersDoc);
    if (doc.byChatKey[chatKey]?.answerId !== answerId) return;
    delete doc.byChatKey[chatKey];
  }, host.context);
}

/** The answer last delivered to a Chat thread, for tests and diagnostics. */
export async function lastPostedAnswer(host: BridgeHost, chatKey: string): Promise<PostedAnswer | undefined> {
  return (await host.harness.snapshot(PostedAnswersDoc, host.context))?.byChatKey[chatKey];
}
