/**
 * What to tell the user when a turn produced no text.
 *
 * Lives apart from `main.ts` because that module starts the bridge on import;
 * a pure formatting decision should be testable without opening a database.
 */

import { classifyModelFailure, type ModelFailure } from "./model-failure.js";

/**
 * The distinction that matters to a person reading Chat is not the status name
 * but whether retrying can help. An aborted turn was stopped on purpose (a
 * model switch, `/abort`); a failed one is worth retrying; a slow answer on a
 * local model is worth waiting for, not resending. Saying which, with the
 * elapsed time, is the difference between "send it again" and "wait".
 *
 * A provider failure is a third case, and the one that used to be wrong: "send
 * it again" is actively bad advice when the account is out of credit or the key
 * is bad, because every retry will fail the same way in a second or two. When
 * the failure classifies, the notice says what would actually fix it.
 */
export function failureNotice(
  status: string,
  reason: string | undefined,
  turnMs: number,
  detail?: unknown,
): string {
  const secs = Math.round(turnMs / 100) / 10;
  if (reason === "aborted" || reason === "interrupted") {
    return `That turn was stopped (${reason}) after ${secs}s, so there is no answer. The conversation is intact — send it again when ready.`;
  }
  if (status === "done") {
    return "The model finished without producing any text. Try rephrasing, or switch models with **/model**.";
  }

  const failure = classifyModelFailure(reason, detail);
  if (failure) return providerNotice(failure, secs);

  return `That turn did not finish (${status})${reason ? `: ${reason}` : ""} after ${secs}s. The conversation is intact — send it again.`;
}

/** A provider failure, phrased as the action that resolves it. */
function providerNotice(failure: ModelFailure, secs: number): string {
  switch (failure.action) {
    case "top_up":
      return (
        `The model provider refused the turn: **${failure.summary}**. ` +
        `That is a billing problem, not a rate limit — sending it again will fail the same way. ` +
        `Top up with **/quota** for the balance and the top-up link. (Failed after ${secs}s.)`
      );
    case "fix_config":
      return (
        `The model provider rejected the credentials: **${failure.summary}**. ` +
        `Retrying will not help — the API key or model name needs fixing. ` +
        `**/model** to check what is configured. (Failed after ${secs}s.)`
      );
    case "compact":
      return (
        `That turn did not fit in the model's context window: **${failure.summary}**. ` +
        `Try **/compact** to shorten the conversation, or **/new** to start fresh. (Failed after ${secs}s.)`
      );
    case "retry_later":
      return (
        `The provider is busy or throttling: **${failure.summary}**. ` +
        `This one is worth retrying after a short wait. (Failed after ${secs}s.)`
      );
    case "retry":
      return (
        `That turn did not finish (provider error: ${failure.summary}) after ${secs}s. ` +
        `The conversation is intact — send it again.`
      );
  }
}
