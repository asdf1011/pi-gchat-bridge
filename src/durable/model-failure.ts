/**
 * Classify a failed turn into something the bridge can act on.
 *
 * The durable engine settles a broken turn as `unanswered` with a `reason` and a
 * free-form `detail`, and that is where the story stopped: `chat-handler` logged
 * the pair and posted a notice, and nothing else in the bridge knew a turn had
 * failed. So a provider running out of credit looked exactly like a slow model —
 * the bridge kept accepting work, every turn failed in ~1.5s, and the only
 * evidence was a 402 buried in a log line. Diagnosing it took log archaeology.
 *
 * The distinction that matters operationally is not *which* error string arrived
 * but *whether doing anything about it would help*:
 *
 *   - `balance`   — the provider wants money. Retrying cannot fix it, and it will
 *                   not fix itself. The bridge should say so and stop pretending
 *                   the model is merely busy.
 *   - `auth`      — the key is wrong, revoked, or unset. Same: retrying is futile
 *                   and the fix is a human editing config.
 *   - `rate_limit`— transient but not instant. Retrying after a wait may work.
 *   - `context`   — the conversation outgrew the model. Needs `/compact`, not a retry.
 *   - `overloaded`— provider-side, transient, retry is the right answer.
 *   - `unknown`   — a real `model_error` we could not read. Assume retryable.
 *
 * This module is pure and dependency-free on purpose: it is the one piece of a
 * provider failure worth testing without opening a database or a socket.
 */

/** Why a provider refused a turn, in terms the bridge can act on. */
export type ModelFailureKind =
  | "balance"
  | "auth"
  | "rate_limit"
  | "context"
  | "overloaded"
  | "unknown";

/** What a caller should do about it. */
export type ModelFailureAction = "top_up" | "fix_config" | "retry_later" | "compact" | "retry";

export interface ModelFailure {
  kind: ModelFailureKind;
  action: ModelFailureAction;
  /**
   * The provider's own words, cleaned of the wrapping the bridge adds, and
   * truncated. Short enough for a log line, a card, or a Chat message.
   */
  summary: string;
  /** True when retrying the same turn unchanged is expected to fail the same way. */
  persistent: boolean;
}

/**
 * How much of the provider's message to keep. Long enough for the useful part of
 * a 402 (`Insufficient Balance (request_id: ...)`), short enough that a stack
 * trace or a dumped payload cannot take over a Chat message.
 */
const MAX_SUMMARY = 160;

/**
 * Pull the human-readable message out of a provider error string.
 *
 * The engine hands back things like:
 *
 *   402: {"message":"Insufficient Balance (request_id: ...)","type":"insufficient_balance_error",...}
 *   Model response ended with stop reason error
 *
 * The status prefix and the JSON envelope are noise to a reader; the `message`
 * field inside is the part worth showing. Anything unparseable is kept as-is.
 */
function summarise(detail: unknown): string {
  if (detail === undefined || detail === null) return "";
  const raw = typeof detail === "string" ? detail : JSON.stringify(detail);
  if (!raw) return "";

  // Drop a leading "402: " / "429: " style status prefix; the kind carries it.
  let text = raw.replace(/^\s*\d{3}\s*:\s*/, "").trim();

  // A JSON body: prefer its `message`, then `error.message`, then the `type`.
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as {
        message?: unknown;
        type?: unknown;
        error?: { message?: unknown; type?: unknown };
      };
      const message = parsed.message ?? parsed.error?.message;
      if (typeof message === "string" && message !== "") {
        text = message;
      } else {
        const type = parsed.type ?? parsed.error?.type;
        if (typeof type === "string" && type !== "") text = type;
      }
    } catch {
      // Not JSON after all — keep the raw text.
    }
  }

  text = text.replace(/\s+/g, " ").trim();
  // Trace ids are for support tickets, not for a person reading Chat or a log
  // line. Left in, they push the part that matters off the end of a truncated
  // message and make "Insufficient Balance" look like a different problem.
  text = text
    .replace(/\s*\(request_id:\s*[^)]*\)/gi, "")
    .replace(/\s*\[?request[ _]?id:\s*[^\]\s]*\]?/gi, "")
    .trim();
  return text.length > MAX_SUMMARY ? `${text.slice(0, MAX_SUMMARY - 1)}…` : text;
}

/**
 * Match on the message, not just the status code.
 *
 * Status codes are shared across providers and reused inconsistently; a 402 is
 * "[In]sufficient balance" at DeepSeek but can be a spending cap elsewhere, and
 * a 400 is as likely to be a context overflow as a malformed request. The
 * message is what the operator will recognise, so it leads — and the code is
 * only a fallback.
 */
function classifyText(lower: string, status: number | undefined): ModelFailureKind | undefined {
  if (lower.includes("insufficient balance") || lower.includes("insufficient_quota")) return "balance";
  if (lower.includes("exceeded your current quota")) return "balance";

  if (lower.includes("context length") || lower.includes("context_length")) return "context";
  if (lower.includes("maximum context") || lower.includes("too many tokens")) return "context";
  if (lower.includes("prompt is too long")) return "context";

  if (lower.includes("invalid api key") || lower.includes("invalid_api_key")) return "auth";
  if (lower.includes("unauthorized") || lower.includes("authentication")) return "auth";
  if (lower.includes("no such model") || lower.includes("model not found")) return "auth";

  if (lower.includes("rate limit") || lower.includes("rate_limit")) return "rate_limit";
  if (lower.includes("too many requests")) return "rate_limit";

  if (lower.includes("overloaded") || lower.includes("service unavailable")) return "overloaded";
  if (lower.includes("bad gateway") || lower.includes("gateway timeout")) return "overloaded";

  // Fall back to the HTTP status the engine prefixed onto the detail.
  if (status === 402) return "balance";
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status === 503 || status === 502 || status === 504) return "overloaded";
  return undefined;
}

/** The HTTP status the engine put in front of a detail string, if any. */
function statusOf(detail: unknown): number | undefined {
  if (typeof detail !== "string") return undefined;
  const match = /^\s*(\d{3})\s*:/.exec(detail);
  if (!match) return undefined;
  const code = Number(match[1]);
  return Number.isFinite(code) ? code : undefined;
}

const ACTIONS: Record<ModelFailureKind, { action: ModelFailureAction; persistent: boolean }> = {
  balance: { action: "top_up", persistent: true },
  auth: { action: "fix_config", persistent: true },
  rate_limit: { action: "retry_later", persistent: false },
  context: { action: "compact", persistent: true },
  overloaded: { action: "retry_later", persistent: false },
  unknown: { action: "retry", persistent: false },
};

/**
 * Decide what a failed turn means.
 *
 * Returns `undefined` when the turn did not fail in a way the bridge can
 * attribute to the provider — an abort, a reset, an empty-but-successful answer.
 * Those have their own explanations and must not be dressed up as quota trouble.
 *
 * `detail` is whatever the engine put in `settled.detail`: usually a string, but
 * typed as unknown because it crosses the seam as JSON.
 */
export function classifyModelFailure(
  reason: string | undefined,
  detail: unknown,
): ModelFailure | undefined {
  // Not a model failure. An aborted turn was stopped on purpose; an empty answer
  // is the empty-answer case that `failureNotice` already covers.
  if (reason !== "model_error") return undefined;

  const summary = summarise(detail);
  const status = statusOf(detail);
  const kind = classifyText(summary.toLowerCase(), status) ?? "unknown";
  const { action, persistent } = ACTIONS[kind];
  return {
    kind,
    action,
    summary: summary === "" ? "the provider returned an error" : summary,
    persistent,
  };
}

/** One line for a log, e.g. `balance (inspectable) — Insufficient Balance`. */
export function describeModelFailure(failure: ModelFailure): string {
  const verb = failure.persistent ? "needs attention" : "may be transient";
  return `${failure.kind} (${verb}) — ${failure.summary}`;
}
