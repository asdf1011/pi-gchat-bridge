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

/** A chat key taken apart: the space to post into, and the thread when it names one. */
export interface ChatTarget {
  /** `spaces/{space}` — where a message goes. */
  space: string;
  /** `spaces/{space}/threads/{thread}` — a reply belongs here. */
  threadName?: string;
  /** The app-chosen key of a thread this conversation was started under. */
  threadKey?: string;
}

/**
 * Split a chat key into the space to post into and, if it names one, the thread.
 *
 * Keys come in three shapes, all built by `keyFor` above: a bare space (a non-threaded
 * conversation), `spaces/{s}/threads/{t}` (a reply in a thread), or `spaces/{s}/{key}` (a
 * thread the app opened by key, e.g. one `/notify` began). Order matters: `/threads/` has
 * to be tested before the generic keyed form, or every thread would be read as a thread
 * key literally named "threads".
 *
 * Parsing lives beside formatting on purpose: an address that means two things to two
 * modules is how a message lands in the wrong thread.
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
