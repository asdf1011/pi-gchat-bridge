import { createHash } from "node:crypto";
import path from "node:path";

/**
 * Conversation key + session-file naming. Shared by the bridge and any tool
 * that computes the same paths (e.g. the cron `start-session` CLI) so the two
 * can't drift — a mismatch would silently split one conversation across two
 * session files.
 */

/**
 * Stable per-conversation key, in priority order:
 *   1. threadKey — the app-chosen identifier stored on threads the app creates.
 *   2. thread name — for threads the app didn't create (no threadKey).
 *   3. space — fallback for non-threaded DMs.
 */
export function keyFor(spaceName: string, threadName?: string, threadKey?: string): string {
  return threadKey ? `${spaceName}/${threadKey}` : (threadName ?? spaceName);
}

/**
 * Pre-hash (unhashed) session file path for a conversation key. Older cron
 * notifiers/bridge builds wrote here; the bridge migrates such files to the
 * hashed name on first open.
 */
export function legacySessionFile(sessionsDir: string, sessionKey: string): string {
  return path.join(sessionsDir, `${sessionKey.replace(/[^a-zA-Z0-9]/g, "_")}.jsonl`);
}

/**
 * Collision-proof session file path: the sanitized key plus a short hash of the
 * full key (the sanitization alone is not injective).
 */
export function sessionFileFor(sessionsDir: string, sessionKey: string): string {
  const stem = path.basename(legacySessionFile(sessionsDir, sessionKey), ".jsonl");
  const hash = createHash("sha256").update(sessionKey).digest("hex").slice(0, 8);
  return path.join(sessionsDir, `${stem}-${hash}.jsonl`);
}
