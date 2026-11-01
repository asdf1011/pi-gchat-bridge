/**
 * Harness settings, mapped from the bridge's environment.
 *
 * pi-durable reads `settings` at every use and never stores it, so these can
 * change without touching storage. Most of the old bridge's tuning knobs have no
 * equivalent because the harness owns that behaviour now:
 *
 *   BRIDGE_STALL_TIMEOUT_MS   → gone: runs checkpoint and resume instead of
 *                               being force-reset. The remaining need is a bound
 *                               on a single model request, which is `stream.timeoutMs`.
 *   BRIDGE_SESSION_IDLE_MS    → gone: `contextRetentionMs` / `documentRetentionMs`
 *                               drop idle working sets; sessions are not objects
 *                               the host has to evict.
 *   BRIDGE_WATCHDOG_INTERVAL  → gone with the watchdog.
 *
 * What is left here is genuinely bridge-specific policy.
 */
import type { Settings } from "@earendil-works/pi-durable";

export interface HarnessSettingsOptions {
  /** Bound on one model request, ms. 0 disables. Replaces the stall watchdog's role. */
  modelTimeoutMs?: number;
  /** How often a streaming partial is committed, ms. This is the Chat typing cadence. */
  partialIntervalMs?: number;
  /** Model retries before a generation fails. */
  maxRetries?: number;
  /** Optional getter, so settings.json edits apply without a restart. */
  thinkingLevel?: () => string | undefined;
}

export function harnessSettings(
  options: HarnessSettingsOptions = {},
): Settings {
  const {
    modelTimeoutMs = Number(process.env.BRIDGE_MODEL_TIMEOUT_MS ?? 0),
    partialIntervalMs = Number(process.env.BRIDGE_PARTIAL_INTERVAL_MS ?? 100),
    maxRetries = Number(process.env.BRIDGE_MODEL_MAX_RETRIES ?? 3),
  } = options;

  return {
    // A hung provider request is the one failure the harness cannot checkpoint
    // its way out of. 0 leaves pi-durable's own default in place.
    stream: modelTimeoutMs > 0 ? { timeoutMs: modelTimeoutMs } : {},
    retry: { enabled: maxRetries > 0, maxRetries, baseDelayMs: 1_000 },
    // Automatic compaction, with a background summary started well before the
    // blocking threshold so a long turn rarely waits for one. Defaults follow
    // pi-durable's; the numbers are spelled out because they decide when a
    // conversation's context is rewritten, which is worth reading before tuning.
    compaction: {
      enabled: true,
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
      backgroundTokens: 32_768,
    },
    // Steers land after the current tool round; follow-ups wait for the answer.
    // "all" matches what the old bridge did when several messages arrived during
    // one run (`pendingSteers` were all delivered together).
    steeringMode: "all",
    followUpMode: "all",
    // A failed run leaves queued messages pending in the inbox rather than
    // silently dropping or auto-continuing them: the user can see what happened
    // and decide. The old bridge behaved the same way (replies stayed queued).
    afterFailedRun: "continue",
    // After this many crashes in a row the task is parked instead of looping.
    restartLimit: 5,
    // Partials are committed at this cadence and become the text the Chat sink
    // paints. Committing faster costs storage writes and buys nothing: Google
    // Chat tolerates roughly one PATCH per second per message anyway (see
    // stream.ts), so the sink throttles independently.
    progress: { partialIntervalMs, outputIntervalMs: partialIntervalMs },
    // Tool calls in one assistant message are independent reads/writes by
    // construction (the old bridge ran pi's default, which is parallel).
    toolExecution: "parallel",
    // The bridge is long-lived and its conversations are long-lived too; keep
    // context and documents warm rather than paying a reload per message.
    contextRetentionMs: 24 * 60 * 60 * 1000,
    documentRetentionMs: 24 * 60 * 60 * 1000,
  };
}
