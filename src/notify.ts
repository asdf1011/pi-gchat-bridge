import { timingSafeEqual } from "node:crypto";
import { isAllowed } from "./access.js";
import { AgentRouter } from "./agent-sessions.js";
import { ChatClient, MAX_MESSAGE_CHARS } from "./chat-client.js";
import { logger } from "./logger.js";

/**
 * Bridge-owned notification endpoint (POST /notify) — the SINGLE writer for
 * app-posted Chat notifications, so cron never touches session files or the
 * Chat API directly:
 *
 *   1. Posts the text to Chat — into a threadKey'd thread when a key is given
 *      (the thread is created on first use, appended to on re-use).
 *   2. Seeds the pi session for that thread (space/threadKey) with the
 *      notification as context, so a later reply in the thread continues a
 *      session that knows what the notification was about.
 *
 * Returns the created message/thread names and whether the session was seeded.
 */

export interface NotifyDeps {
  client: ChatClient;
  router: AgentRouter;
  allowedSpaces: string[];
  /** When set, POST /notify must carry Authorization: Bearer <token>. */
  notifyToken?: string;
}

export interface NotifyBody {
  /** Chat space resource name, e.g. "spaces/XXXX". */
  space?: unknown;
  /** Notification text (chunked over the 4096-char message limit). */
  text?: unknown;
  /** App-chosen thread key. Without it the message is top-level and NOT session-backed. */
  threadKey?: unknown;
  /** Optional extra context appended to the seeded session (e.g. an email id). */
  hint?: unknown;
  /** Optional display name for the seeded session. */
  title?: unknown;
}

/** Split text into ≤max chunks on paragraph boundaries. */
export function chunkText(text: string, max = MAX_MESSAGE_CHARS): string[] {
  const chunks: string[] = [];
  for (const para of text.split(/\n\n+/)) {
    const last = chunks[chunks.length - 1];
    if (last && last.length + para.length + 2 <= max) chunks[chunks.length - 1] = `${last}\n\n${para}`;
    else chunks.push(para);
  }
  return chunks;
}

function unauthorized(): { status: number; json: { ok: boolean; error: string } } {
  return { status: 401, json: { ok: false, error: "invalid notify token" } };
}

/** Handle one POST /notify request body. Never throws — returns an HTTP response. */
export async function handleNotify(
  deps: NotifyDeps,
  rawBody: unknown,
  authHeader: string | undefined,
): Promise<{ status: number; json: Record<string, unknown> }> {
  // --- Shared-secret auth (optional; same container by default). ---
  if (deps.notifyToken) {
    const presented = (authHeader ?? "").match(/^Bearer\s+(.+)$/)?.[1] ?? "";
    const a = Buffer.from(presented);
    const b = Buffer.from(deps.notifyToken);
    const ok = a.length === b.length && timingSafeEqual(a, b);
    if (!ok) {
      logger.warn("[notify] rejected request: bad token");
      return unauthorized();
    }
  }

  // --- Validate. ---
  const body = (rawBody ?? {}) as NotifyBody;
  const space = typeof body.space === "string" ? body.space : "";
  const text = typeof body.text === "string" ? body.text : "";
  const threadKey =
    typeof body.threadKey === "string" && body.threadKey.trim() ? body.threadKey.trim() : undefined;
  const hint = typeof body.hint === "string" ? body.hint : "";
  const title = typeof body.title === "string" ? body.title : "";
  if (!/^spaces\/[^/]+$/.test(space)) {
    return { status: 400, json: { ok: false, error: "space must look like spaces/{space}" } };
  }
  if (!text.trim()) {
    return { status: 400, json: { ok: false, error: "text is required" } };
  }
  if (!isAllowed(space, deps.allowedSpaces)) {
    logger.info(`[notify] ${space}: space not in allow-list, dropping`);
    return { status: 403, json: { ok: false, error: "space not allowed" } };
  }
  if (threadKey && !/^[A-Za-z0-9_.~-]+$/.test(threadKey)) {
    return { status: 400, json: { ok: false, error: "threadKey has unsupported characters" } };
  }

  const sessionKey = threadKey ? AgentRouter.keyFor(space, undefined, threadKey) : undefined;

  // --- Post (first chunk creates/joins the keyed thread; the rest append). ---
  const chunks = chunkText(text);
  let messageName = "";
  let threadName: string | undefined;
  try {
    if (threadKey) {
      const first = await deps.client.createMessageWithThreadKey(space, chunks[0], threadKey);
      messageName = first.name;
      threadName = first.threadName;
    } else {
      messageName = await deps.client.createMessage(space, chunks[0]);
    }
    for (let i = 1; i < chunks.length; i++) {
      await deps.client.createMessage(space, chunks[i], threadName);
    }
  } catch (err) {
    logger.error("[notify] posting failed:", (err as Error).message);
    return { status: 502, json: { ok: false, error: `posting failed: ${(err as Error).message}` } };
  }

  // --- Seed the conversation for later replies (only for keyed threads). ---
  let seeded = false;
  if (threadKey && sessionKey) {
    try {
      seeded = deps.router.seedNotificationSession(sessionKey, { text, hint, title });
    } catch (err) {
      // Notification already delivered — don't fail the request, but surface
      // the missing context loudly so it can be remedied.
      logger.error(`[notify] ${sessionKey} seeding failed (message WAS posted):`, (err as Error).message);
    }
  }

  logger.info(`[notify] posted ${chunks.length} chunk(s) to ${space}${threadKey ? ` (threadKey=${threadKey})` : ""} thread=${threadName ?? "(top-level)"} seeded=${seeded}`);
  return {
    status: 200,
    json: { ok: true, messageName, threadName: threadName ?? null, threadKey: threadKey ?? null, sessionKey: sessionKey ?? null, seeded, chunks: chunks.length },
  };
}
