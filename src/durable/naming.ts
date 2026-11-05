/**
 * Naming every conversation that has no title yet.
 *
 * A conversation shows a title if it has one, its opening words if not, and its
 * thread key only when nobody has spoken in it. Titles are what make the index
 * readable, and this is the pass that supplies them — including for the hundred
 * threads that existed before titles were stored.
 *
 * Deliberately a slow background loop rather than a burst:
 *
 *   - one title at a time, so a titler on the same two cores as the conversations
 *     is never competing with a turn;
 *   - it stops when there is nothing left, and logs a line per title so the log
 *     shows progress rather than a mystery pause;
 *   - every failure is contained: a conversation that cannot be titled keeps its
 *     preview and is retried later, and a titler that is down costs one line every
 *     `intervalMs` rather than a crash.
 *
 * The prompt is built from the *first exchange* only (`firstTurn`), so it stays
 * short whatever the thread has become — which is what made this affordable on a
 * local model in the first place.
 */
import type { TopicSummaryConfig } from "../topic-summary.js";
import { summarizeConversationTopic } from "./topic.js";
import type { SessionHost } from "../session-host/api.js";
import { logger } from "../logger.js";

export interface NamingPassOptions {
  seam: SessionHost;
  config: TopicSummaryConfig;
  /** How long to wait between titles. Zero is fine for a hosted titler. */
  intervalMs: number;
  /** How long to wait after a failure, so a dead titler is not hammered. */
  retryAfterMs?: number;
  /** How many conversations may be attempted in one pass. */
  maxPerPass?: number;
  /** The titler itself, injectable so the loop can be tested without a server. */
  summarize?: (turn: { userText: string; assistantText: string }, config: TopicSummaryConfig) => Promise<string | undefined>;
}

/** Whether a conversation still needs a title. Pure, so it can be tested. */
export function needsTitle(conversation: { label?: string; preview?: string; name: string }): boolean {
  // A validation thread has a machine name and no human behind it.
  if (conversation.name.startsWith("validation:")) return false;
  return conversation.label === undefined;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Title conversations until none are left, then return.
 *
 * Resolves when the backlog is empty, so a caller can start it detached and forget
 * it; it does not keep the process alive on its own (the timers are awaited, not
 * scheduled forever).
 */
export async function nameUntitledConversations(options: NamingPassOptions): Promise<number> {
  const { seam, config } = options;
  const intervalMs = Math.max(0, options.intervalMs);
  const retryAfterMs = Math.max(intervalMs, options.retryAfterMs ?? 60_000);
  const summarize = options.summarize ?? summarizeConversationTopic;
  let named = 0;
  const maxPerPass = Math.max(1, options.maxPerPass ?? Number.POSITIVE_INFINITY);
  /**
   * Conversations this pass has already tried.
   *
   * Without it a conversation the titler cannot name — one that opens with an
   * empty message, say — is retried forever and blocks every conversation behind
   * it. Observed: one such thread stalled the whole backlog for minutes, printing
   * "no title came back" once a minute.
   */
  const attempted = new Set<string>();

  for (;;) {
    let candidates;
    try {
      candidates = (await seam.list()).filter((c) => needsTitle(c) && !attempted.has(c.name));
    } catch (error) {
      logger.warn(`[naming] could not list conversations: ${(error as Error).message}`);
      await sleep(retryAfterMs);
      continue;
    }
    if (candidates.length === 0) return named;

    const conversation = candidates[0]!;
    try {
      const turn = await seam.firstTurn(conversation.conversationId);
      if (!turn) {
        // Nothing said yet, or nothing nameable: skip it this pass. A later pass
        // (after someone speaks) will pick it up.
        logger.info(`[naming] conversation ${conversation.conversationId}: nothing to title yet`);
        attempted.add(conversation.name);
        continue;
      }
      const title = await summarize(turn, config);
      if (!title) {
        logger.info(`[naming] conversation ${conversation.conversationId}: no title came back — skipping`);
        attempted.add(conversation.name);
        continue;
      }
      const labelled = await seam.label(conversation.name, title);
      if (!labelled) {
        logger.warn(`[naming] conversation ${conversation.conversationId}: could not store "${title}"`);
        attempted.add(conversation.name);
        continue;
      }
      named += 1;
      if (named >= maxPerPass) return named;
      // Also marked attempted: a host that does not reflect the new label instantly
      // would otherwise hand this conversation back and be titled again and again.
      attempted.add(conversation.name);
      logger.info(`[naming] conversation ${conversation.conversationId} → "${title}"`);
      await sleep(intervalMs);
    } catch (error) {
      logger.warn(
        `[naming] conversation ${conversation.conversationId} failed: ${(error as Error).message} — skipping`,
      );
      attempted.add(conversation.name);
    }
  }
}
