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
 *   - **no streams at all.** Delivery is a poll with a cursor: there is no connection to lose, no
 *     heartbeat to miss and no reconnect ladder, and a timeout is an ordinary answer. Live state
 *     rides along on the same request (`observe=1`), which is enough because text is read, not
 *     watched at sixty frames a second.
 *
 * Reads are grouped by entry, because a surface shows *entries*: one answer is one
 * message even when the transcript holds several messages for it (a turn emits an entry
 * per message, and only the stamped one is the answer).
 */
import type http from "node:http";

import { entriesAfter } from "../durable/entries.js";
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
  /**
   * Where activity comes from, when the deployment has it.
   *
   * Absent means the route is not served, which is how a deployment (or a test) says "no
   * activity stream here" without a flag.
   */
  activity?: {
    subscribe(listener: (event: { conversationId: number; kind: string; at: number }) => void): () => void;
  };

}

export interface EntryView {
  /**
   * Which conversation the entry belongs to.
   *
   * The log is global, so a reader of `GET /v1/poll` gets entries from every conversation it
   * serves and cannot otherwise tell them apart. Without it the painter consumed each prompt as
   * `conversationId: undefined` and asked the host about a conversation that does not exist —
   * which failed the whole Session, not just that entry.
   */
  conversationId: number;
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

  // --- One conversation's current state, once ----------------------------------
  //
  // The busy flag and the live text without a subscription: what a bridge asks when it wants to
  // know "is a turn running here" — the painter's `busy` check, and the restart gate's quiet test.
  // A single snapshot rather than an SSE stream, because it is a question, not a watch.
  const one = /^\/v1\/conversations\/(\d+)$/.exec(url.pathname);
  if (one && req.method === "GET") {
    const conversationId = Number(one[1]);
    const view = await deps.seam.snapshot(conversationId);
    if (!view) {
      json(res, 404, { ok: false, error: `no such conversation: ${conversationId}` });
      return true;
    }
    json(res, 200, {
      conversationId,
      view: {
        liveText: view.liveText,
        busy: view.busy,
        lastAssistantText: view.lastAssistantText,
        tools: view.tools,
      },
    });
    return true;
  }

  // `GET /v1/submissions/{id}` was here, and it never had a consumer: a bridge learns what an
  // answer said from the entries, and the painter has never asked. The one thing it added over the
  // log was the failure *reason* (aborted vs a provider error), and the honest fix for that is to
  // put the reason where the rest of the facts live — in the log — rather than keeping an
  // unconsumed endpoint with a fiddly contract (long-poll, cap, 202) that nobody exercises.

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
      .slice(0, limit)
      .map(
        (entry): EntryView => ({
          conversationId,
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

  // --- The log as a long poll: the same cursor, without a connection -------------
  //
  // A poll states its position, gets what is after it, and comes back. There is no subscription to
  // lose, no heartbeat to miss, and no reconnect ladder — a dead client is simply a client that
  // stopped asking, and a timeout is an ordinary answer. The replay window of the stream has no
  // meaning here either: a reader that is far behind gets a page and asks again, so nothing has to be
  // declared "too far" at all.
  //
  // `wait` blocks until something happens or the time runs out, and `batch` delays the answer by a
  // few hundred milliseconds after the first sign of life so a turn's burst — prompt, commentary,
  // answer — arrives in one response rather than three. That is not a compromise on promptness: the
  // Chat bridge already coalesces its PATCHes at 250ms, so this is the cadence text has always been
  // rendered at.
  if (url.pathname === "/v1/poll" && req.method === "GET") {
    const since = Math.max(0, Math.floor(Number(url.searchParams.get("since") ?? 0) || 0));
    const onlyParam = url.searchParams.get("conversation");
    const only = onlyParam === null ? undefined : Number(onlyParam);
    if (only !== undefined && !Number.isFinite(only)) {
      json(res, 400, { ok: false, error: "conversation must be a number" });
      return true;
    }
    const observe = url.searchParams.get("observe") === "1";
    if (observe && only === undefined) {
      json(res, 400, { ok: false, error: "observe=1 needs conversation=<id>: a view is per turn" });
      return true;
    }

    const served = (await deps.conversations()).map((conversation) => conversation.conversationId);
    if (only !== undefined && !served.includes(only)) {
      json(res, 404, { ok: false, error: `no such conversation: ${only}` });
      return true;
    }
    const target = only === undefined ? served : [only];
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get("limit") ?? 200) || 200));
    const waitMs = Math.min(60_000, Math.max(0, Number(url.searchParams.get("wait") ?? 25) * 1000 || 0));
    const batchMs = Math.min(2_000, Math.max(0, Number(url.searchParams.get("batch") ?? 250) || 0));
    const startedAt = Date.now();

    const read = async (): Promise<EntryView[]> => {
      const merged: EntryView[] = [];
      for (const conversationId of target) {
        const window = await entriesAfter(
          { history: (id, pageLimit, offset) => deps.seam.history(id, { limit: pageLimit, offset }) },
          conversationId,
          since,
          { pageSize: Math.min(50, limit) },
        );
        merged.push(
          ...window.entries.map(
            (entry): EntryView => ({
              conversationId: entry.conversationId,
              entryId: entry.entryId,
              role: entry.role,
              text: entry.text,
              ...(entry.at === undefined ? {} : { at: entry.at }),
              ...(entry.origin === undefined ? {} : { origin: entry.origin }),
            }),
          ),
        );
      }
      // The same global-order rule as the sweep: one cursor, so the oldest first.
      merged.sort((a, b) => a.entryId - b.entryId);
      return merged.slice(0, limit);
    };

    let entries = await read();
    const observed = observe && only !== undefined;
    let view = observed ? await deps.seam.snapshot(only) : undefined;

    if (entries.length === 0 && waitMs > 0) {
      // What to wait for, when a client asks to observe: the *view* as well as the log.
      //
      // Entries only appear at a turn's boundaries, so waiting on them alone would hold a live-update
      // request for the full `wait` and then answer with a draft that is twenty-five seconds old.
      // The view is a plain snapshot, so the wait is "until it differs from the one I am about to
      // send" — a state change, not an event, which is exactly the shape of what is being watched.
      const baseline = view === undefined ? "" : JSON.stringify(view);
      // A frame function rather than a feed event: the activity feed announces turn boundaries and
      // deliberately carries no data, and this needs the data.
      await new Promise<void>((resolve) => {
        let done = false;
        let attached: { detach(): void } | undefined;
        const finish = (): void => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          unsubscribe();
          attached?.detach();
          resolve();
        };
        const timer = setTimeout(finish, waitMs);
        timer.unref?.();
        const unsubscribe = deps.activity
          ? deps.activity.subscribe((event) => {
              if (target.includes(event.conversationId)) finish();
            })
          : () => {};
        if (observed && only !== undefined) {
          void deps.seam
            .attach(only, (frame) => {
              // The first frame of an attach is the current state, which is what `baseline` already
              // is; only a different one is news.
              if (JSON.stringify(frame) !== baseline) finish();
            })
            .then((handle) => {
              attached = handle ?? undefined;
              if (done) attached?.detach();
            })
            .catch(() => {
              // No view to watch: the timeout is the answer, as it is for a deployment with no feed.
            });
        }
      });
      if (batchMs > 0) await new Promise((resolve) => setTimeout(resolve, batchMs));
      entries = await read();
      if (observed) view = await deps.seam.snapshot(only);
    }

    const cursor = entries.length > 0 ? (entries[entries.length - 1] as EntryView).entryId : since;
    const waitedMs = Date.now() - startedAt;

    // Caching turns on one property: **the answer to "everything after X" is a prefix of an
    // append-only log**, so a response that carried entries stays true for ever — a later reader gets
    // the same prefix plus more, walks to its cursor, and asks again. A cached chain therefore gives
    // catch-up without touching the origin, and the worst a stale short answer costs is one extra
    // hop per entry.
    //
    // What must never be cached is an answer without entries: "nothing new" is a *state*, and cached
    // it would hand every later poll an instant empty response while the tunnel looked busy. Same for
    // `observe`, which is live state by definition. So the response is cacheable exactly when it is a
    // fact — and `waitedMs` remains the client's detector for a cache that got this wrong: no news
    // after 8ms, when it asked to wait 25s, did not come from here.
    const cacheable = entries.length > 0 && !observe;
    res.writeHead(200, {
      "Content-Type": "application/json",
      ...(cacheable
        ? {
            // Immutable prefix: safe to hold, and `must-revalidate` is deliberately absent so a
            // reader does not pay a round trip to be told what it already has. The TTL bounds how
            // stale a *short* prefix can get, which costs hops rather than correctness.
            "Cache-Control": "public, max-age=3600, immutable",
            "CDN-Cache-Control": "public, max-age=3600",
            "Surrogate-Control": "max-age=3600",
          }
        : {
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "CDN-Cache-Control": "no-store",
            "Surrogate-Control": "no-store",
            Pragma: "no-cache",
          }),
      "X-Poll-Waited-Ms": String(waitedMs),
      // Scope is the *server's* notion of what this caller may read, not part of the URL, so a cache
      // keyed only by URL would be wrong the day scope becomes per-token. Varying on it costs nothing
      // and keeps that door honest.
      Vary: "Authorization",
    });
    res.end(
      JSON.stringify({
        cursor,
        entries,
        waitedMs,
        ...(observe
          ? {
              busy: view?.busy === true,
              view: view === undefined ? null : { liveText: view.liveText, busy: view.busy, tools: view.tools },
            }
          : {}),
      }),
    );
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
