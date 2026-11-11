/**
 * Conversation keys, and the address a Chat message goes to.
 *
 * Shared by the bridge and any tool that computes the same key (e.g. the cron notifiers), so the two
 * cannot drift — a mismatch would silently split one conversation in two.
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
