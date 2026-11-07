/**
 * Review comments, as durable state.
 *
 * Comments are the one thing about artifacts the transcript cannot derive. A file
 * list comes from tool calls, a revision comes from jj — but *"this line is wrong,
 * and here is what I said about it"* is authored, so it has to be recorded.
 *
 * One session-scoped document rather than a conversation-scoped one, for two
 * reasons that both come down to size: a comment holds a few hundred bytes and a
 * conversation has tens of them, so the whole store is smaller than one turn of a
 * transcript, and a single document means a single atomic write with the rest of
 * the bridge's bookkeeping. It is deliberately *not* part of the bindings
 * document: that one is indexed by Chat key and rewritten whole on every message,
 * and comments are not worth rewriting on that path.
 *
 * Nothing here is a model turn. The text of a comment reaches the model as an
 * ordinary submission (see `adapter/web-routes.ts`), so the transcript stays the
 * transcript — and this document is only what a review pane needs in order to
 * draw a thread.
 */
import { defineDoc } from "@earendil-works/pi-durable";

/**
 * One stored anchor.
 *
 * A type alias, not an interface: pi-durable documents accept literals with an
 * implicit index signature, and interfaces do not get one. So are the rest.
 */
export type StoredAnchor = {
  changeId: string;
  originalLine: number;
  content: string;
};

/**
 * One thing the agent said *in a thread*, rather than as a turn.
 *
 * Deliberately not a transcript entry. A review reply is plumbing: the person
 * already sees the turn's answer, and an entry would put the agent's own words
 * back in front of it two turns later, reading like something the user said. So
 * it is stored here, where only the drawer reads it — no announce, no model
 * message, no transcript line.
 */
export type StoredReply = {
  text: string;
  at: number;
  /** Who said it: `agent` for the reply tool, otherwise the reviewer. */
  author?: string;
};

export type StoredComment = {
  id: string;
  file: string;
  anchors: StoredAnchor[];
  quote?: string;
  charStart?: number;
  charEnd?: number;
  occurrence?: number;
  text: string;
  at: number;
  author?: string;
  resolved?: boolean;
  submissions?: number[];
  replies?: StoredReply[];
  /**
   * The revision this comment was written against, as a change id.
   *
   * Recorded so a later edit can be *mapped* rather than guessed at: the successor
   * of a commented line is the diff between this revision and the one displayed
   * now (`successor.ts`). Absent on comments that predate the field, which is why
   * every reader treats it as optional.
   */
  atRevision?: string;
};

export type ConversationComments = {
  comments: StoredComment[];
};

export type CommentsValue = {
  /** Conversation id, as a string: JSON object keys are strings. */
  byConversation: Record<string, ConversationComments>;
};

/** Most comments one conversation keeps. Beyond this the oldest resolved ones go. */
export const MAX_COMMENTS_PER_CONVERSATION = 200;

export const CommentsDoc = defineDoc<CommentsValue>({
  kind: "gchat.comments",
  version: 1,
  scope: "session",
  initial: () => ({ byConversation: {} }),
  // Whole-value checkpoints, like the bindings document: the value is small and a
  // delta replayed against a list that other writers may have trimmed is not
  // worth the storage it saves.
  checkpointWhen: () => true,
});

/** Comments for one conversation, oldest first. Never `undefined`: absent is empty. */
export function commentsOf(value: CommentsValue | undefined, conversationId: number): StoredComment[] {
  return value?.byConversation[String(conversationId)]?.comments ?? [];
}

/**
 * Add one comment, trimming only what is safe to trim.
 *
 * Open comments are never dropped: an unresolved review note that quietly
 * disappears is worse than a long list. Resolved ones are dropped oldest-first
 * once the cap is reached, because they are history, not work.
 */
export function addComment(
  existing: readonly StoredComment[],
  comment: StoredComment,
  max = MAX_COMMENTS_PER_CONVERSATION,
): StoredComment[] {
  const next = [...existing, comment];
  if (next.length <= max) return next;
  const overflow = next.length - max;
  const droppable = next
    .map((candidate, index) => ({ candidate, index }))
    .filter((entry) => entry.candidate.resolved === true)
    .slice(0, overflow)
    .map((entry) => entry.index);
  if (droppable.length === 0) return next; // all open: keep them all, over the cap
  const drop = new Set(droppable);
  return next.filter((_, index) => !drop.has(index));
}

/** Mark one comment resolved (or open again). Unknown ids change nothing. */
export function setResolved(
  existing: readonly StoredComment[],
  id: string,
  resolved: boolean,
): { comments: StoredComment[]; changed: boolean } {
  let changed = false;
  const comments = existing.map((comment) => {
    if (comment.id !== id || Boolean(comment.resolved) === resolved) return comment;
    changed = true;
    // `resolved: false` is the same as absent, so drop the field rather than
    // storing a flag that means "not resolved".
    const { resolved: _dropped, ...rest } = comment;
    return resolved ? { ...rest, resolved: true } : rest;
  });
  return { comments, changed };
}

/** Remember a submission a comment started, so its answer can be joined later. */
export function appendSubmission(
  existing: readonly StoredComment[],
  id: string,
  submissionId: number,
): StoredComment[] {
  return existing.map((comment) => {
    if (comment.id !== id) return comment;
    const submissions = comment.submissions ?? [];
    if (submissions.includes(submissionId)) return comment;
    return { ...comment, submissions: [...submissions, submissionId] };
  });
}

/** Append one agent reply to a comment, oldest first. Unknown ids change nothing. */
export function appendReply(
  existing: readonly StoredComment[],
  id: string,
  reply: StoredReply,
  max = 50,
): { comments: StoredComment[]; changed: boolean } {
  let changed = false;
  const comments = existing.map((comment) => {
    if (comment.id !== id) return comment;
    changed = true;
    const replies = [...(comment.replies ?? []), reply];
    // A thread is a conversation, not a log: keep the newest exchanges and let
    // the oldest fall off, so one runaway agent cannot grow a document forever.
    return { ...comment, replies: replies.slice(Math.max(0, replies.length - max)) };
  });
  return { comments, changed };
}

/**
 * The comment a short id names.
 *
 * Ids are UUIDs because the viewer needs them opaque and unique, but a model
 * should not have to reproduce thirty-six characters — so the message carries the
 * first eight, and this resolves a prefix. Ambiguity is refused rather than
 * guessed: two comments sharing a prefix is a coincidence worth a retry, not a
 * silent write to the wrong thread.
 */
export function findByShortId<T extends { id: string }>(
  comments: readonly T[],
  shortId: string,
): T | { ambiguous: true } | undefined {
  const needle = shortId.trim().toLowerCase();
  if (needle === "") return undefined;
  const exact = comments.find((comment) => comment.id.toLowerCase() === needle);
  if (exact) return exact;
  const matches = comments.filter((comment) => comment.id.toLowerCase().startsWith(needle));
  if (matches.length === 1) return matches[0];
  return matches.length > 1 ? { ambiguous: true } : undefined;
}
