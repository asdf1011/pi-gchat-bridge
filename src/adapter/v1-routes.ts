/**
 * The conversation protocol: what a *second* surface needs, and nothing else.
 *
 * This is the smallest thing that lets something other than the Chat bridge read a
 * conversation. It exists to be a test of the architecture as much as a feature: if a
 * new bridge needs server changes, the abstraction is wrong, and one CLI is a day's work
 * to find that out rather than a week's.
 *
 * Three verbs, chosen by what the caller cannot do without:
 *
 *   GET  /v1/conversations                    which conversations exist, and their addresses
 *   GET  /v1/conversations/{id}/entries       entries after a cursor
 *   POST /v1/conversations/{id}/submissions   put words into the conversation
 *
 * What is deliberately absent is more interesting than what is here:
 *
 *   - **no cursor on the server.** `since` is the caller's own position. A surface that
 *     stops for a week resumes by remembering where it was, not by asking the server what
 *     it missed, and the server is not asked to remember who is reading it (§17).
 *   - **no deliveries endpoint.** Confirming a delivery is for a surface that *posts
 *     somewhere*; a reader's confirmation is its own cursor advancing. Endpoints without a
 *     consumer are how a protocol grows a second, accidental architecture.
 *   - **no view subscription.** The live view is a Chat-shaped concern for now; a reader
 *     that wants it can poll, and when a second posting surface exists, the subscription
 *     and its heartbeat (§18) arrive together with that need.
 *
 * Reads are grouped by entry, because a surface shows *entries*: one answer is one
 * message even when the transcript holds several messages for it (a turn emits an entry
 * per message, and only the stamped one is the answer).
 */
import type http from "node:http";

import { entriesAfter } from "../durable/delivery-pass.js";
import type { SessionHost } from "../session-host/api.js";

export interface ConversationAddress {
  conversationId: number;
  /** Where it lives, e.g. `spaces/S/threads/T`. Opaque strings: the server does not parse them. */
  address: string;
  /** A human name, when one has been set. */
  name?: string;
  lastActivityAt?: number;
}

export interface V1Deps {
  seam: SessionHost;
  /** Every conversation a bridge may read, with its address. */
  conversations(): Promise<readonly ConversationAddress[]>;
  /** Bearer token required for writes. Empty disables the check (tailnet-only). */
  token?: string;
}

export interface EntryView {
  entryId: number;
  role: "user" | "assistant";
  text: string;
  at?: number;
  /** The surface that produced it, when stamped at submit time. Absent means unknown. */
  origin?: string;
}

const MAX_LIMIT = 200;

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function authorized(deps: V1Deps, header: string | undefined): boolean {
  if (!deps.token) return true;
  return header === `Bearer ${deps.token}`;
}

/**
 * Handle one `/v1` request. Returns false when the path is not ours, so the caller can
 * keep its own routing. Never throws for a bad request: a protocol that answers with a
 * stack trace is a protocol nobody can build a client against.
 */
export async function handleV1(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  deps: V1Deps,
): Promise<boolean> {
  if (!url.pathname.startsWith("/v1/")) return false;

  if (req.method === "GET" && url.pathname === "/v1/conversations") {
    const items = await deps.conversations();
    json(res, 200, {
      items: items.map((conversation) => ({
        conversationId: conversation.conversationId,
        address: conversation.address,
        ...(conversation.name === undefined ? {} : { name: conversation.name }),
        ...(conversation.lastActivityAt === undefined ? {} : { lastActivityAt: conversation.lastActivityAt }),
      })),
    });
    return true;
  }

  const entries = /^\/v1\/conversations\/(\d+)\/entries$/.exec(url.pathname);
  if (entries && req.method === "GET") {
    const conversationId = Number(entries[1]);
    const since = Math.max(0, Number(url.searchParams.get("since") ?? 0) || 0);
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));

    // `undefined` from the host means "no such conversation", which is a 404 rather than
    // an empty list: a reader must be able to tell "nothing new" from "gone".
    const probe = await deps.seam.history(conversationId, { limit: 1, offset: 0 });
    if (probe === undefined) {
      json(res, 404, { ok: false, error: `no such conversation: ${conversationId}` });
      return true;
    }

    const window = await entriesAfter({ history: (id, pageLimit, offset) => deps.seam.history(id, { limit: pageLimit, offset }) }, conversationId, since, {
      pageSize: limit,
    });
    const after = window.entries
      .filter((entry) => entry.entryId > since)
      .slice(0, limit)
      .map(
        (entry): EntryView => ({
          entryId: entry.entryId,
          role: entry.role,
          text: entry.text,
          ...(entry.at === undefined ? {} : { at: entry.at }),
          ...(entry.origin === undefined ? {} : { origin: entry.origin }),
        }),
      );
    json(res, 200, { conversationId, since, newest: window.newest, entries: after });
    return true;
  }

  const submissions = /^\/v1\/conversations\/(\d+)\/submissions$/.exec(url.pathname);
  if (submissions && req.method === "POST") {
    if (!authorized(deps, req.headers.authorization)) {
      json(res, 401, { ok: false, error: "unauthorized" });
      return true;
    }
    const body = await readJson(req, 64 * 1024);
    if (body === null) {
      json(res, 413, { ok: false, error: "request body too large" });
      return true;
    }
    const text = typeof (body as { text?: unknown }).text === "string" ? (body as { text: string }).text : "";
    if (text.trim() === "") {
      json(res, 400, { ok: false, error: "text is required" });
      return true;
    }
    const origin =
      typeof (body as { origin?: unknown }).origin === "string" ? (body as { origin: string }).origin : "unknown";
    const result = await deps.seam.submit(Number(submissions[1]), {
      content: text,
      whenBusy: "steer",
      origin,
      ...(typeof (body as { requestId?: unknown }).requestId === "string"
        ? { requestId: (body as { requestId: string }).requestId }
        : {}),
    });
    if ("error" in result) {
      json(res, 400, { ok: false, error: result.error });
      return true;
    }
    json(res, 202, { ok: true, submissionId: result.submissionId });
    return true;
  }

  json(res, 404, { ok: false, error: "not found" });
  return true;
}

/** Read a JSON body up to `maxBytes`; null when the cap is exceeded or it is not JSON. */
async function readJson(req: http.IncomingMessage, maxBytes: number): Promise<unknown | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > maxBytes) return null;
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return null;
  }
}
