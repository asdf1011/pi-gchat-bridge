/**
 * Watching a turn that started somewhere else, so Chat still shows the whole
 * conversation.
 *
 * Chat and the web pane are two clients of one conversation, and a conversation
 * that only half-appears in one of them is not much use: type in the browser and
 * the thread used to show the agent answering nothing (or, after the first
 * attempt at this, showed the question and no answer). The rule now is that the
 * Chat side of a conversation sees *every* turn, whichever surface started it.
 *
 * The default is *not* to give the web-typed prompt a message of its own, for two
 * reasons that agree:
 *
 *   1. A message about your own words, a second after you typed them, is a
 *      notification you did not want. That was the original complaint.
 *   2. A silent message cannot be posted into an existing thread — verified
 *      against the live API on Nov 6, 2026, and the finding in `issues.txt` #1
 *      has said the same since Aug 14: silent + `messageReplyOption` is a 403 for
 *      either reply option, and without `messageReplyOption` the API ignores
 *      `thread.name` and opens a *new* thread. In a DM the thread is the
 *      conversation key, so a new thread would capture the person's next message
 *      and silently start a new conversation. There is no silent option that is
 *      also in the right place.
 *
 * So the prompt rides with the answer: one message per turn, threaded where the
 * conversation lives, quoting the prompt above the reply. A web turn then costs
 * exactly what a Chat turn costs — one notification, for the answer — instead of
 * two, and nothing is missing from either surface.
 *
 * That is the shape for a prompt whose answer this module posts. Two cases are
 * different, and in both the prompt is posted as a message of its own, paying its
 * own notification: completeness is worth a ping here, which is the call the
 * owner made — a conversation with a message missing on one surface is a worse
 * failure than a notification you did not need.
 *
 *   - **A steer onto a turn Chat is already painting.** Those words are the
 *     person's, the running answer will not quote them, so they go in now — and
 *     the stream's placeholder is relocated below them, exactly as the Chat steer
 *     path does, or the answer would render above the steer.
 *   - **A steer onto a turn another surface started.** Both submissions settle on
 *     the same answer and `claimAnswer` picks one poster; the loser posts its
 *     prompt alone. It lands just after the answer rather than before it, which
 *     is the one thing lost by not knowing at submit time whether a turn was
 *     already running — the message is present, its position is approximate.
 *
 * Dedupe is `claimAnswer`: a turn can be watched from several submissions at
 * once, and only one of them may post the answer. `isPainting` asks the same
 * question earlier and more cheaply — if the Chat handler is already streaming
 * this thread, it owns the answer, so the prompt is the only thing left to post.
 */
import { failureNotice } from "./failure-notice.js";
import { MAX_MESSAGE_CHARS } from "../chat-client.js";
import { splitMessage } from "../stream.js";
import { logger } from "../logger.js";

/** The slice of `ChatClient` this needs. Structural, so a test needs no Chat. */
export interface MirrorTarget {
  sendMessage(spaceName: string, text: string, threadName?: string, opts?: { silent?: boolean }): Promise<void>;
  createMessageWithThreadKey(
    spaceName: string,
    text: string,
    threadKey: string,
  ): Promise<{ threadName: string } | unknown>;
}

/**
 * A settled submission, as the host reports it. Structural duplicate of the
 * seam's `Settled` rather than an import: this module is the host's business,
 * and the union is two cases.
 */
export type SettledTurn =
  | { status: "done"; answerId: number; text: string }
  | { status: "unanswered"; reason?: string; detail?: unknown };

export interface MirrorDeps {
  client: MirrorTarget;
  /** The chat key bound to a conversation, when it has one. */
  chatKeyFor(conversationId: number): Promise<string | undefined>;
  /** Wait for the turn this submission belongs to. */
  awaitSubmission(submissionId: number): Promise<SettledTurn>;
  /** Claim the right to post one answer; false means someone else already did. */
  claimAnswer(chatKey: string, answerId: number): Promise<boolean>;
  /** Hand a claim back after a post failed, so another surface can still make it. */
  releaseAnswer(chatKey: string, answerId: number): Promise<void>;
  /** True when a Chat stream already owns this thread and will post the answer. */
  isPainting?(chatKey: string): boolean;
  /** Move a running stream's placeholder below a message just posted to its thread. */
  relocate?(chatKey: string): Promise<void>;
  /** Elapsed-time source, for the failure notice. */
  now?(): number;
}

/** A chat key taken apart: the space to post into, and the thread when it names one. */
export interface ChatTarget {
  space: string;
  /** `spaces/{space}/threads/{thread}` — a reply belongs here. */
  threadName?: string;
  /** The app-chosen key of a thread this conversation was started under. */
  threadKey?: string;
}

/**
 * Split a chat key into the space to post into and, if it names one, the thread.
 *
 * Keys are built by `session-key.ts` and come in three shapes: a bare space (a
 * non-threaded conversation), `spaces/{s}/threads/{t}` (a reply in a thread), or
 * `spaces/{s}/{key}` (a thread the app opened by key, e.g. one `/notify` began).
 * Order matters: `/threads/` has to be tested before the generic keyed form, or
 * every thread would be read as a thread key literally named "threads".
 */
export function chatTarget(chatKey: string | undefined): ChatTarget | undefined {
  if (!chatKey || !chatKey.startsWith("spaces/")) return undefined;
  const thread = /^(spaces\/[^/]+)\/threads\/[^/]+$/.exec(chatKey);
  if (thread) return { space: thread[1] as string, threadName: chatKey };
  const keyed = /^(spaces\/[^/]+)\/(.+)$/.exec(chatKey);
  if (keyed) return { space: keyed[1] as string, threadKey: keyed[2] as string };
  return { space: chatKey };
}

/**
 * The prompt as a Chat block quote, so the answer reads as a reply to it.
 *
 * Quote markers on every line, because Chat's Markdown ends a block quote at the
 * first unmarked line — a two-paragraph paste would otherwise have its second
 * paragraph look like the start of the answer.
 */
export function quotePrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) return "";
  return trimmed
    .split("\n")
    .map((line) => (line.trim() === "" ? ">" : `> ${line}`))
    .join("\n");
}

/**
 * Paint one turn into the Chat side of its conversation. Returns false when
 * there is nothing to mirror — no Chat side, or a stream already painting it.
 * Never throws for a post that was not attempted; a post that *was* attempted
 * and failed throws, and the caller logs it.
 *
 * Intended to be called detached (the HTTP submit answers before this settles).
 */
export async function mirrorTurn(
  deps: MirrorDeps,
  conversationId: number,
  submissionId: number,
  prompt: string,
): Promise<boolean> {
  const chatKey = await deps.chatKeyFor(conversationId);
  const target = chatTarget(chatKey);
  if (!chatKey || !target) return false;

  if (deps.isPainting?.(chatKey) ?? false) {
    // A steer onto a turn Chat is painting: the stream owns the answer, so these
    // words cannot ride with it. Post them now, in order, and move the running
    // reply below them — otherwise the answer renders above the steer.
    await post(deps.client, target, prompt);
    await deps.relocate?.(chatKey).catch(() => {});
    logger.info(`[mirror] ${target.threadName ?? target.space}: posted a steering prompt`);
    return true;
  }

  const started = deps.now?.() ?? Date.now();
  const settled = await deps.awaitSubmission(submissionId);
  const answer = settled.status === "done" ? settled.text.trim() : "";

  if (settled.status === "done" && !(await deps.claimAnswer(chatKey, settled.answerId))) {
    // Both surfaces watched the same turn and the other one is posting the
    // answer. The prompt still has to land somewhere: it is the person's words,
    // and they are not in the thread yet.
    logger.info(`[mirror] ${chatKey}: answer ${settled.answerId} posted elsewhere — posting the prompt alone`);
    await post(deps.client, target, prompt);
    return true;
  }

  const body =
    answer ||
    failureNotice(
      settled.status,
      settled.status === "unanswered" ? settled.reason : undefined,
      (deps.now?.() ?? Date.now()) - started,
    );
  const quote = quotePrompt(prompt);
  const text = quote ? `${quote}\n\n${body}` : body;

  try {
    await post(deps.client, target, text);
  } catch (error) {
    // The answer is still in the conversation; only the Chat copy failed. Give
    // the claim back, or a later delivery for this answer would skip posting it
    // and Chat would be missing the turn for good.
    if (settled.status === "done") await deps.releaseAnswer(chatKey, settled.answerId).catch(() => {});
    throw error;
  }
  logger.info(
    `[mirror] ${target.threadName ?? target.space}: posted the turn (${answer ? `${body.length} chars` : settled.status})` +
      (quote ? ", quoting the prompt" : ""),
  );
  return true;
}

/**
 * Post `text`, chunked to the per-message cap.
 *
 * The first chunk is the one that notifies — that is the answer arriving, and a
 * Chat-started turn pings for exactly the same reason. Overflow chunks ask to be
 * silent where the API allows it, which mirrors what `ReplyStream` does: in a
 * thread nothing can be silent, and that is the platform's answer, not ours.
 */
async function post(client: MirrorTarget, target: ChatTarget, text: string): Promise<void> {
  const chunks = splitMessage(text, MAX_MESSAGE_CHARS);
  let threadName = target.threadName;
  let i = 0;
  if (target.threadKey) {
    const first = (await client.createMessageWithThreadKey(target.space, chunks[0] as string, target.threadKey)) as
      | { threadName?: string }
      | undefined;
    threadName = first?.threadName ?? threadName;
    i = 1;
  }
  for (; i < chunks.length; i++) {
    const silent = !threadName && i > 0 ? { silent: true } : undefined;
    await client.sendMessage(target.space, chunks[i] as string, threadName, silent);
  }
}
