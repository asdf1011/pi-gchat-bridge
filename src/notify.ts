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
 *   Without `validation` (plain notifications, e.g. DeepSeek alerts):
 *     1. posts the text into a threadKey'd thread (created on first use),
 *     2. seeds the pi session for that thread (space/threadKey) with the text
 *        as context, so a later reply continues a session with context.
 *
 *   With `validation.prompt` (e.g. gold-card candidates that matched a broad
 *     subject query): run the prompt in a HIDDEN conversation first — nothing
 *     is posted to Chat yet. The agent inspects the email and must end its
 *     reply with `VERDICT: YES`/`VERDICT: NO`. Only a YES gets posted (into
 *     the keyed thread, which then keys back to the same session — so the
 *     posted notification carries the agent's full analysis as context). A NO
 *     stays invisible: just a conversation in the session store, with the
 *     verdict recorded as a custom entry for idempotency. An unparsable
 *     verdict posts anyway (fail-open: the subject query already passed, and
 *     a missed real invitation is worse than noise).
 *
 * Verdicts are persisted as custom `cron_notify` entries, so a re-run of the
 * same candidate short-circuits instead of re-prompting or double-posting.
 */

export interface NotifyDeps {
  client: ChatClient;
  router: AgentRouter;
  allowedSpaces: string[];
  /** When set, POST /notify must carry Authorization: Bearer <token>. */
  notifyToken?: string;
}

export interface NotifyBody {
  space?: unknown;
  text?: unknown;
  threadKey?: unknown;
  hint?: unknown;
  title?: unknown;
  validation?: { prompt?: unknown };
}

/** Custom-entry type under which validation verdicts are recorded. */
export const VERDICT_CUSTOM_TYPE = "cron_notify";

type NotifyResponse = { status: number; json: Record<string, unknown> };

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

function unauthorized(): NotifyResponse {
  return { status: 401, json: { ok: false, error: "invalid notify token" } };
}

/** Post (chunked) text to a space; first chunk creates/joins the keyed thread. */
async function postText(
  client: ChatClient,
  space: string,
  text: string,
  threadKey?: string,
): Promise<{ messageName: string; threadName?: string }> {
  const chunks = chunkText(text);
  let messageName: string;
  let threadName: string | undefined;
  if (threadKey) {
    const first = await client.createMessageWithThreadKey(space, chunks[0], threadKey);
    messageName = first.name;
    threadName = first.threadName;
  } else {
    messageName = await client.createMessage(space, chunks[0]);
  }
  for (let i = 1; i < chunks.length; i++) {
    await client.createMessage(space, chunks[i], threadName);
  }
  return { messageName, threadName };
}

/** Extract the strict VERDICT: YES/NO line a validation reply must end with. */
export function parseVerdict(reply: string): "YES" | "NO" | undefined {
  const m = reply.toUpperCase().match(/(?:^|\n)\s*VERDICT:\s*(YES|NO)\b/);
  return m ? (m[1] as "YES" | "NO") : undefined;
}

interface VerdictRecord {
  verdict?: unknown;
  reason?: unknown;
  notificationPosted?: unknown;
}

function readVerdict(rec: { data?: Record<string, unknown> } | undefined): VerdictRecord | undefined {
  return rec?.data as VerdictRecord | undefined;
}

/** Handle one POST /notify request body. Never throws — returns an HTTP response. */
export async function handleNotify(
  deps: NotifyDeps,
  rawBody: unknown,
  authHeader: string | undefined,
): Promise<NotifyResponse> {
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
  const validationPrompt =
    typeof body.validation?.prompt === "string" && body.validation.prompt.trim()
      ? body.validation.prompt.trim()
      : "";
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
  if (validationPrompt && !threadKey) {
    return { status: 400, json: { ok: false, error: "validation requires a threadKey" } };
  }

  const sessionKey = threadKey ? AgentRouter.keyFor(space, undefined, threadKey) : undefined;

  // ================= Plain notification: post + seed =================
  if (!validationPrompt) {
    try {
      const { messageName, threadName } = await postText(deps.client, space, text, threadKey);
      let seeded = false;
      if (threadKey && sessionKey) {
        try {
          seeded = deps.router.seedNotificationSession(sessionKey, { text, hint, title });
        } catch (err) {
          logger.error(`[notify] ${sessionKey} seeding failed (message WAS posted):`, (err as Error).message);
        }
      }
      logger.info(`[notify] posted ${chunkText(text).length} chunk(s) to ${space} thread=${threadName ?? "(top-level)"} seeded=${seeded}`);
      return {
        status: 200,
        json: {
          ok: true,
          status: "posted",
          messageName,
          threadName: threadName ?? null,
          threadKey: threadKey ?? null,
          sessionKey: sessionKey ?? null,
          seeded,
          chunks: chunkText(text).length,
        },
      };
    } catch (err) {
      logger.error("[notify] posting failed:", (err as Error).message);
      return { status: 502, json: { ok: false, status: "error", error: `posting failed: ${(err as Error).message}` } };
    }
  }

  // ================= Validated notification =================
  // Hidden conversation keyed by the same threadKey the post will use, so a
  // YES post and any later Chat replies all land on this one session.
  const sessionKeyReq = sessionKey as string;

  // 1. Already decided? A verdict record short-circuits (no re-prompt, no dup).
  const stored = await deps.router.readLastCustomEntry(sessionKeyReq, VERDICT_CUSTOM_TYPE);
  const rec = readVerdict(stored);
  if (rec) {
    if (rec.notificationPosted === true) {
      logger.info(`[notify] ${sessionKeyReq} already validated + posted — skipping`);
      return { status: 200, json: { ok: true, status: "posted", already: true, sessionKey: sessionKeyReq } };
    }
    if (rec.verdict === "NO") {
      logger.info(`[notify] ${sessionKeyReq} already validated as not-an-invite — skipping`);
      return {
        status: 200,
        json: { ok: true, status: "rejected", already: true, reason: String(rec.reason ?? ""), sessionKey: sessionKeyReq },
      };
    }
    // Verdict YES/UNCLEAR recorded but the post never landed (crash window):
    // re-post without re-running the agent.
    logger.info(`[notify] ${sessionKeyReq} verdict recorded but not posted — retrying post`);
  } else {
    // 2. No verdict yet: run the validation prompt in the hidden session.
    logger.info(`[notify] ${sessionKeyReq}: validating in hidden session`);
    let reply: string | null;
    try {
      reply = await deps.router.handleMessage(sessionKeyReq, space, validationPrompt);
    } catch (err) {
      logger.error(`[notify] ${sessionKeyReq} validation run failed:`, (err as Error).message);
      return { status: 502, json: { ok: false, status: "error", error: (err as Error).message } };
    }
    if (reply === null) {
      logger.info(`[notify] ${sessionKeyReq}: session busy — deferring`);
      return { status: 409, json: { ok: false, status: "busy", error: "session busy" } };
    }
    if (title) deps.router.setSessionName(sessionKeyReq, title);
    const verdict = parseVerdict(reply) ?? "UNCLEAR";
    const reason = reply.trim().slice(0, 300);
    deps.router.appendCustomEntry(sessionKeyReq, VERDICT_CUSTOM_TYPE, { verdict, reason, notificationPosted: false });
    logger.info(`[notify] ${sessionKeyReq}: validation verdict=${verdict}`);
    if (verdict === "NO") {
      // Not an invitation: keep the conversation hidden, post nothing.
      return { status: 200, json: { ok: true, status: "rejected", verdict, reason, sessionKey: sessionKeyReq } };
    }
  }

  // 3. Verdict YES (or UNCLEAR — fail open) → post, then record the post and
  //    mirror the posted notification into the session (it's open — the
  //    validation just ran in it) so the thread's context shows what the user
  //    actually sees in Chat.
  try {
    const { messageName, threadName } = await postText(deps.client, space, text, threadKey);
    deps.router.appendNotificationNotice(sessionKeyReq, text);
    deps.router.appendCustomEntry(sessionKeyReq, VERDICT_CUSTOM_TYPE, {
      verdict: rec?.verdict ?? "YES",
      reason: String(rec?.reason ?? "posted after validation"),
      notificationPosted: true,
    });
    logger.info(`[notify] ${sessionKeyReq}: posted validated notification thread=${threadName ?? "(top-level)"}`);
    return {
      status: 200,
      json: {
        ok: true,
        status: "posted",
        messageName,
        threadName: threadName ?? null,
        threadKey: threadKey ?? null,
        sessionKey: sessionKeyReq,
        seeded: false,
      },
    };
  } catch (err) {
    logger.error(`[notify] ${sessionKeyReq}: posting validated notification failed:`, (err as Error).message);
    return { status: 502, json: { ok: false, status: "error", error: `posting failed: ${(err as Error).message}` } };
  }
}
