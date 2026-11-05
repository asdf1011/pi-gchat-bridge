/**
 * POST /notify on the durable harness.
 *
 * Same contract as `notify.ts` (the SDK-host version), so the cron service does
 * not have to know which engine is running. Two paths:
 *
 *   plain       post the text into the keyed thread, then record it in the
 *               conversation as a pi-durable *write*, so a later reply has it as
 *               context without the model answering it now.
 *   validation  run the prompt in a conversation that is never bound to a Chat
 *               thread, post only on VERDICT: YES (or unclear), and record the
 *               verdict so a re-run of the same candidate short-circuits.
 *
 * Where the old implementation appended `cron_notify` custom entries to a JSONL
 * session, verdicts here are a session-scoped document: one entry per threadKey,
 * committed atomically with the notification that produced it, and readable
 * without opening the conversation.
 */
import { timingSafeEqual } from "node:crypto";

import { parseVerdict, postText, unauthorized, chunkText } from "../notify.js";
import type { ChatClient } from "../chat-client.js";
import { defineDoc, type ConversationId } from "@earendil-works/pi-durable";
import { logger } from "../logger.js";
import type { SessionHost } from "../session-host/api.js";
import type { DurableRouter } from "../adapter/router.js";
import type { ConversationBinding } from "./bindings-doc.js";

/**
 * One recorded verdict. A type alias rather than `VerdictRecord` from
 * `notify.ts`: pi-durable's `JsonObject` needs an implicit index signature, which
 * interfaces never get.
 */
export type VerdictEntry = {
  verdict?: string;
  reason?: string;
  notificationPosted?: boolean;
  postFailed?: boolean;
  messageName?: string;
  error?: string;
  at: number;
};

/** Verdict per Chat conversation key. */
export type VerdictsValue = {
  byThreadKey: Record<string, VerdictEntry>;
};

export const VerdictsDoc = defineDoc<VerdictsValue>({
  kind: "gchat.verdicts",
  version: 1,
  scope: "session",
  initial: () => ({ byThreadKey: {} }),
  checkpointWhen: () => true,
});

export interface DurableNotifyDeps {
  client: ChatClient;
  seam: SessionHost;
  router: DurableRouter;
  notifyToken?: string;
  /** Default agent for conversations this endpoint creates. */
  defaultAgent: { model: { provider: string; modelId: string }; thinkingLevel?: never };
}

export interface NotifyResponse {
  status: number;
  json: Record<string, unknown>;
}

interface NotifyBody {
  space?: unknown;
  text?: unknown;
  threadKey?: unknown;
  hint?: unknown;
  title?: unknown;
  validation?: { prompt?: unknown };
}

/** `keyFor(space, undefined, threadKey)` — the same key `/notify` posts into. */
function threadChatKey(space: string, threadKey: string): string {
  return `${space}/${threadKey}`;
}

async function recordVerdict(seam: SessionHost, chatKey: string, record: VerdictEntry): Promise<void> {
  // The seam's verdict is the claim the validator makes; a POST failure is
  // recorded alongside it rather than as a verdict of its own.
  await seam.recordVerdict(chatKey, {
    verdict: record.verdict === "YES" ? "YES" : "NO",
    reason: record.reason ?? "",
    ...(record.notificationPosted === undefined ? {} : { notificationPosted: record.notificationPosted }),
    ...(record.postFailed === undefined ? {} : { postFailed: record.postFailed }),
    ...(record.error === undefined ? {} : { error: record.error }),
    at: record.at,
  });
}

async function lastVerdict(seam: SessionHost, chatKey: string): Promise<VerdictEntry | undefined> {
  return (await seam.verdict(chatKey)) as VerdictEntry | undefined;
}

/** Handle one POST /notify body. Never throws. */
export async function handleDurableNotify(
  deps: DurableNotifyDeps,
  rawBody: unknown,
  authHeader: string | undefined,
): Promise<NotifyResponse> {
  if (deps.notifyToken) {
    const presented = (authHeader ?? "").match(/^Bearer\s+(.+)$/)?.[1] ?? "";
    const a = Buffer.from(presented);
    const b = Buffer.from(deps.notifyToken);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      logger.warn("[notify] rejected request: bad token");
      return unauthorized();
    }
  }

  const body = (rawBody ?? {}) as NotifyBody;
  const space = typeof body.space === "string" ? body.space : "";
  const text = typeof body.text === "string" ? body.text : "";
  const threadKey = typeof body.threadKey === "string" && body.threadKey.trim() ? body.threadKey.trim() : undefined;
  const title = typeof body.title === "string" ? body.title : "";
  const validationPrompt = typeof body.validation === "object" && body.validation !== null
    ? (body.validation as { prompt?: unknown }).prompt
    : undefined;

  if (!space) return { status: 400, json: { ok: false, error: "space is required" } };
  if (!text) return { status: 400, json: { ok: false, error: "text is required" } };
  if (validationPrompt !== undefined) {
    if (typeof validationPrompt !== "string" || !validationPrompt.trim()) {
      return { status: 400, json: { ok: false, error: "validation.prompt must be a non-empty string" } };
    }
    if (!threadKey) return { status: 400, json: { ok: false, error: "validation requires a threadKey" } };
  }

  const chunks = chunkText(text);
  if (validationPrompt === undefined) {
    return plainNotify(deps, { space, text, threadKey, title }, chunks);
  }
  return validatedNotify(deps, {
    space,
    text,
    threadKey: threadKey as string,
    title,
    prompt: validationPrompt as string,
  }, chunks);
}

async function plainNotify(
  deps: DurableNotifyDeps,
  req: { space: string; text: string; threadKey?: string; title: string },
  chunks: string[],
): Promise<NotifyResponse> {
  const { space, text, threadKey, title } = req;
  const chatKey = threadKey ? threadChatKey(space, threadKey) : undefined;
  try {
    const { messageName, threadName } = await postText(deps.client, space, chunks, threadKey);
    let seeded = false;
    if (chatKey) {
      try {
        // A write, not an input: the notice becomes context for a later reply and
        // never triggers a run of its own.
        await deps.router.notify(chatKey, title ? `${title}\n\n${text}` : text);
        seeded = true;
      } catch (error) {
        logger.error(`[notify] ${chatKey} seeding failed (message WAS posted):`, (error as Error).message);
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
        sessionKey: chatKey ?? null,
        seeded,
        chunks: chunks.length,
      },
    };
  } catch (error) {
    logger.error("[notify] posting failed:", (error as Error).message);
    return { status: 502, json: { ok: false, status: "error", error: `posting failed: ${(error as Error).message}` } };
  }
}

async function validatedNotify(
  deps: DurableNotifyDeps,
  req: { space: string; text: string; threadKey: string; title: string; prompt: string },
  chunks: string[],
): Promise<NotifyResponse> {
  const { space, text, threadKey, title, prompt } = req;
  const chatKey = threadChatKey(space, threadKey);

  // 1. Already decided? The stored verdict drives the response, so a re-run of the
  //    same candidate neither re-runs the prompt nor re-posts.
  const stored = await lastVerdict(deps.seam, chatKey);
  if (stored) {
    if (stored.verdict === "NO") {
      logger.info(`[notify] ${chatKey}: already rejected (${stored.reason})`);
      return { status: 200, json: { ok: true, status: "skipped", reason: stored.reason, verdict: "NO" } };
    }
    if (stored.notificationPosted) {
      logger.info(`[notify] ${chatKey}: already posted, not posting twice`);
      return {
        status: 200,
        json: { ok: true, status: "already_posted", verdict: stored.verdict, messageName: stored.messageName ?? null },
      };
    }
  }

  // 2. Run the prompt in a conversation that is never bound to the thread, so the
  //    analysis never appears in Chat.
  let verdict: "YES" | "NO" | "UNCLEAR" = "UNCLEAR";
  let reason = "";
  try {
    const conversation = await deps.seam.getOrCreate(`validation:${chatKey}`, deps.defaultAgent);
    const submitted = await deps.seam.submit(conversation.conversationId, {
      content: prompt,
      requestId: `notify:${chatKey}:${Date.now()}`,
    });
    if ("error" in submitted) throw new Error(submitted.error);
    const settled = await deps.seam.awaitSubmission(submitted.submissionId);
    // The host hands back the answer's text, so the validator does not parse a
    // transcript to find one string.
    const reply = settled.status === "done" ? settled.text : "";
    const parsed = parseVerdict(reply);
    verdict = parsed ?? "UNCLEAR";
    reason = settled.status === "done" ? "" : `run ${settled.status}`;
    if (parsed === "NO") {
      await recordVerdict(deps.seam, chatKey, { verdict: "NO", reason: `model: ${reply.slice(0, 200)}`, at: Date.now() });
      logger.info(`[notify] ${chatKey}: verdict NO — not posting`);
      return { status: 200, json: { ok: true, status: "skipped", reason: "verdict NO", verdict: "NO" } };
    }
  } catch (error) {
    reason = `validation failed: ${(error as Error).message}`;
    logger.error(`[notify] ${chatKey}: validation failed — posting anyway (fail-open):`, reason);
  }

  // 3. Post (YES or fail-open UNCLEAR), then record the confirmation so a retry
  //    does not post twice.
  try {
    const { messageName, threadName } = await postText(deps.client, space, chunks, threadKey);
    await deps.router.notify(chatKey, title ? `${title}\n\n${text}` : text);
    await recordVerdict(deps.seam, chatKey, {
      verdict,
      reason,
      notificationPosted: true,
      messageName,
      at: Date.now(),
    });
    logger.info(`[notify] ${chatKey}: verdict ${verdict} — posted (${chunks.length} chunk(s))`);
    return {
      status: 200,
      json: {
        ok: true,
        status: "posted",
        verdict,
        messageName,
        threadName: threadName ?? null,
        threadKey,
        sessionKey: chatKey,
        seeded: true,
        chunks: chunks.length,
      },
    };
  } catch (error) {
    const message = (error as Error).message;
    await recordVerdict(deps.seam, chatKey, {
      verdict,
      reason: reason || message,
      notificationPosted: false,
      postFailed: true,
      error: message,
      at: Date.now(),
    });
    logger.error(`[notify] ${chatKey}: posting validated notification failed:`, message);
    return { status: 502, json: { ok: false, status: "error", error: `posting failed: ${message}` } };
  }
}

/** The conversation id behind a validation key, for tests and diagnostics. */
export async function validationConversationId(seam: SessionHost, chatKey: string): Promise<number | undefined> {
  const binding = await seam.resolve(`validation:${chatKey}`);
  return binding?.conversationId;
}

export type { ConversationId };
