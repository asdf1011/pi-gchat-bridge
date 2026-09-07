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
 *     posted notification carries the agent's full analysis as context, and
 *     the notification text itself is mirrored into the session). A NO stays
 *     invisible: just a conversation in the session store. An unparsable
 *     verdict posts anyway (fail-open: the subject query already passed, and
 *     a missed real invitation is worse than noise).
 *
 * POST idempotency: Google Chat offers NO idempotent create — probed
 * `clientAssignedMessageId`, which is accepted but ignored (a repeat create
 * returns a fresh message in a fresh thread). Delivery is therefore
 * at-least-once. Verdicts are recorded as custom `cron_notify` entries: the
 * intent is appended BEFORE the post and the confirmation right after, so a
 * re-run of the same candidate short-circuits, an explicitly failed post is
 * retried, and the narrow crash window between "Chat accepted" and
 * "confirmation recorded" is retried with a loud warning (a duplicate is the
 * better failure than a silently missed notification).
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

/** Verdict record shape persisted under VERDICT_CUSTOM_TYPE (last entry wins). */
interface VerdictRecord {
  verdict?: "YES" | "NO" | "UNCLEAR";
  reason?: string;
  /** True once the post has been confirmed. */
  notificationPosted?: boolean;
  /** True when the last post attempt ended in an explicit error (safe to retry). */
  postFailed?: boolean;
  error?: string;
  at?: string;
}

type NotifyResponse = { status: number; json: Record<string, unknown> };

/**
 * Split text into ≤max chunks. Paragraphs (blank-line separated) are kept whole
 * when they fit; a single paragraph longer than max (a long email body) is
 * hard-wrapped on word boundaries, falling back to a character cut, so no
 * chunk ever exceeds the Chat message limit.
 */
export function chunkText(text: string, max = MAX_MESSAGE_CHARS): string[] {
  const chunks: string[] = [];
  for (const para of text.split(/\n\n+/)) {
    const last = chunks[chunks.length - 1];
    if (last && last.length + para.length + 2 <= max) {
      chunks[chunks.length - 1] = `${last}\n\n${para}`;
      continue;
    }
    if (para.length <= max) {
      chunks.push(para);
      continue;
    }
    // Oversized single paragraph: hard-wrap on word boundaries, char-cut as a
    // last resort. Whitespace at the seams is trimmed.
    let rest = para;
    while (rest.length > max) {
      let cut = rest.lastIndexOf(" ", max);
      if (cut <= 0) cut = max;
      chunks.push(rest.slice(0, cut).trimEnd());
      rest = rest.slice(cut).trimStart();
    }
    if (rest) chunks.push(rest);
  }
  return chunks;
}

function unauthorized(): NotifyResponse {
  return { status: 401, json: { ok: false, error: "invalid notify token" } };
}

/** Post pre-chunked text; the first chunk creates/joins the keyed thread. */
async function postText(
  client: ChatClient,
  space: string,
  chunks: string[],
  threadKey?: string,
): Promise<{ messageName: string; threadName?: string }> {
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

  // --- Parse + validate common fields. ---
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

  // Chunk once; both paths post these exact chunks.
  const chunks = chunkText(text);

  if (validationPrompt) {
    // Guarded above: validation implies a threadKey. TS can't correlate the
    // two consts, so assert the assumption at this single crossing point.
    return handleValidatedNotify(
      deps,
      { space, text, threadKey: threadKey as string, title, prompt: validationPrompt },
      chunks,
    );
  }
  return handlePlainNotify(deps, { space, text, threadKey, hint, title }, chunks);
}

/** Plain notification: post, then seed the session for later replies. */
async function handlePlainNotify(
  deps: NotifyDeps,
  req: { space: string; text: string; threadKey?: string; hint: string; title: string },
  chunks: string[],
): Promise<NotifyResponse> {
  const { space, text, threadKey, hint, title } = req;
  const sessionKey = threadKey ? AgentRouter.keyFor(space, undefined, threadKey) : undefined;
  try {
    const { messageName, threadName } = await postText(deps.client, space, chunks, threadKey);
    let seeded = false;
    if (threadKey && sessionKey) {
      try {
        seeded = deps.router.seedNotificationSession(sessionKey, { text, hint, title });
      } catch (err) {
        logger.error(`[notify] ${sessionKey} seeding failed (message WAS posted):`, (err as Error).message);
      }
    }
    logger.info(`[notify] posted ${chunks.length} chunk(s) to ${space} thread=${threadName ?? "(top-level)"} seeded=${seeded}`);
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
        chunks: chunks.length,
      },
    };
  } catch (err) {
    logger.error("[notify] posting failed:", (err as Error).message);
    return { status: 502, json: { ok: false, status: "error", error: `posting failed: ${(err as Error).message}` } };
  }
}

/**
 * Validated notification: run the prompt in a hidden session keyed by the
 * threadKey the post will use, then post only on a YES verdict. See the module
 * doc for the at-least-once delivery semantics.
 */
async function handleValidatedNotify(
  deps: NotifyDeps,
  req: { space: string; text: string; threadKey: string; title: string; prompt: string },
  chunks: string[],
): Promise<NotifyResponse> {
  const { space, text, threadKey, title, prompt } = req;
  const sessionKey = AgentRouter.keyFor(space, undefined, threadKey);
  // Filled by a fresh validation run below; confirmation records reuse it so a
  // YES and an UNCLEAR verdict aren't conflated in the audit trail.
  let freshVerdict: VerdictRecord["verdict"];
  let freshReason = "";

  // --- 1. Already decided? The last verdict record drives the response. ---
  const stored = await deps.router.readLastCustomEntry(sessionKey, VERDICT_CUSTOM_TYPE);
  const rec = readVerdict(stored);
  if (rec) {
    if (rec.notificationPosted === true) {
      logger.info(`[notify] ${sessionKey} already validated + posted — skipping`);
      return { status: 200, json: { ok: true, status: "posted", already: true, sessionKey } };
    }
    if (rec.verdict === "NO") {
      logger.info(`[notify] ${sessionKey} already validated as not-an-invite — skipping`);
      return { status: 200, json: { ok: true, status: "rejected", already: true, reason: rec.reason ?? "", sessionKey } };
    }
    if (rec.postFailed !== true) {
      // Intent was recorded but no outcome: a crash between "Chat accepted"
      // and "confirmation recorded". Chat has no idempotent create (see module
      // doc), so we cannot know if the earlier post landed. Re-posting risks at
      // worst one duplicate; NOT posting risks silently missing the
      // notification — a duplicate is the better failure, and it is loud here.
      logger.warn(
        `[notify] ${sessionKey} earlier post (${rec.at ?? "?"}) was never confirmed — re-posting; ` +
          "check the Chat thread for a duplicate if one appears",
      );
    } else {
      logger.info(`[notify] ${sessionKey} previous post failed (${rec.error ?? "?"}) — retrying`);
    }
  } else {
    // --- 2. No verdict yet: run the validation prompt in the hidden session. ---
    logger.info(`[notify] ${sessionKey}: validating in hidden session`);
    let reply: string | null;
    try {
      reply = await deps.router.handleMessage(sessionKey, space, prompt);
    } catch (err) {
      logger.error(`[notify] ${sessionKey} validation run failed:`, (err as Error).message);
      return { status: 502, json: { ok: false, status: "error", error: (err as Error).message } };
    }
    if (reply === null) {
      logger.info(`[notify] ${sessionKey}: session busy — deferring`);
      return { status: 409, json: { ok: false, status: "busy", error: "session busy" } };
    }
    if (title) deps.router.setSessionName(sessionKey, title);
    freshVerdict = parseVerdict(reply) ?? "UNCLEAR";
    freshReason = reply.trim().slice(0, 300);
    // Record intent BEFORE posting: a later request can see that a post was
    // attempted (vs. never started) and behave accordingly.
    deps.router.appendCustomEntry(sessionKey, VERDICT_CUSTOM_TYPE, {
      verdict: freshVerdict,
      reason: freshReason,
      notificationPosted: false,
    });
    logger.info(`[notify] ${sessionKey}: validation verdict=${freshVerdict}`);
    if (freshVerdict === "NO") {
      // Not an invitation: keep the conversation hidden, post nothing.
      return { status: 200, json: { ok: true, status: "rejected", verdict: freshVerdict, reason: freshReason, sessionKey } };
    }
  }

  // --- 3. Verdict YES (or UNCLEAR — fail open) → post, confirm, mirror. ---
  const recordVerdict = freshVerdict ?? rec?.verdict ?? "YES";
  const recordReason = freshVerdict ? freshReason : (rec?.reason ?? "posted after validation");
  try {
    const { messageName, threadName } = await postText(deps.client, space, chunks, threadKey);
    // Confirmation FIRST (correctness), then the cosmetic mirror (best-effort).
    deps.router.appendCustomEntry(sessionKey, VERDICT_CUSTOM_TYPE, {
      verdict: recordVerdict,
      reason: recordReason,
      notificationPosted: true,
    });
    deps.router.appendNotificationNotice(sessionKey, text);
    logger.info(`[notify] ${sessionKey}: posted validated notification thread=${threadName ?? "(top-level)"}`);
    return {
      status: 200,
      json: {
        ok: true,
        status: "posted",
        messageName,
        threadName: threadName ?? null,
        threadKey: threadKey ?? null,
        sessionKey,
        seeded: false,
      },
    };
  } catch (err) {
    const message = (err as Error).message;
    // Record the explicit failure so a retry knows the message didn't land.
    deps.router.appendCustomEntry(sessionKey, VERDICT_CUSTOM_TYPE, {
      verdict: recordVerdict,
      reason: recordReason,
      notificationPosted: false,
      postFailed: true,
      error: message,
    });
    logger.error(`[notify] ${sessionKey}: posting validated notification failed:`, message);
    return { status: 502, json: { ok: false, status: "error", error: `posting failed: ${message}` } };
  }
}
