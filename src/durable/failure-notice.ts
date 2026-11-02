/**
 * What to tell the user when a turn produced no text.
 *
 * Lives apart from `main.ts` because that module starts the bridge on import;
 * a pure formatting decision should be testable without opening a database.
 */

/**
 * The distinction that matters to a person reading Chat is not the status name
 * but whether retrying can help. An aborted turn was stopped on purpose (a
 * model switch, `/abort`); a failed one is worth retrying; a slow answer on a
 * local model is worth waiting for, not resending. Saying which, with the
 * elapsed time, is the difference between "send it again" and "wait".
 */
export function failureNotice(status: string, reason: string | undefined, turnMs: number): string {
  const secs = Math.round(turnMs / 100) / 10;
  if (reason === "aborted" || reason === "interrupted") {
    return `That turn was stopped (${reason}) after ${secs}s, so there is no answer. The conversation is intact — send it again when ready.`;
  }
  if (status === "done") {
    return "The model finished without producing any text. Try rephrasing, or switch models with **/model**.";
  }
  return `That turn did not finish (${status})${reason ? `: ${reason}` : ""} after ${secs}s. The conversation is intact — send it again.`;
}

