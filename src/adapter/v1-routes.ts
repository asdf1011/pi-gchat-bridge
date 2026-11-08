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
  /**
   * Cadence of the view stream's heartbeat, in ms.
   *
   * Fixed, and independent of activity, on purpose (§18): the *absence* of frames is the
   * signal that a stream has died, so a heartbeat that only fires when things are quiet
   * cannot be told apart from a busy conversation on a dead connection.
   */
  heartbeatMs?: number;
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

  // --- Activity: what the server is doing, to whoever is listening ----------------
  //
  // `?conversation=<id>` is optional on purpose, because the two consumers want opposite
  // things: the chat bridge serves every thread it is bound to and wants all of them, while a
  // browser showing one conversation should not be woken for the rest. An unfiltered stream is
  // also the cheap one to serve — one fan-out, no per-conversation bookkeeping.
  //
  // Events are hints, never data: losing one costs latency, because the transcript and the
  // reader's own cursor are the record. That is what keeps this compatible with "the server has
  // no memory of its readers" — a subscriber is a connection, not a position.
  const activity = url.pathname === "/v1/activity";
  if (activity && req.method === "GET") {
    if (!deps.activity) {
      json(res, 404, { ok: false, error: "activity is not served here" });
      return true;
    }
    if (url.searchParams.has("conversation")) {
      // A filtered activity stream would be a *per-conversation* stream, and that one should also
      // carry the live view — one subscription for a surface watching a single conversation
      // instead of two. Pointing at it is better than quietly ignoring the filter.
      json(res, 400, {
        ok: false,
        error: "use /v1/conversations/{id}/events for one conversation (activity and view together)",
      });
      return true;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (event: string, data: unknown): void => {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const unsubscribe = deps.activity.subscribe((event) => send("activity", event));
    const beat = setInterval(() => send("heartbeat", { at: Date.now() }), deps.heartbeatMs ?? 15_000);
    beat.unref?.();
    const stop = (): void => {
      clearInterval(beat);
      unsubscribe();
    };
    req.on("close", stop);
    res.on("close", stop);
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
    if (entries.length === 0 && waitMs > 0) {
      // Something to wait for: the activity feed, because a turn boundary is the only moment entries
      // appear. Blind without it — a deployment with no feed still honours `wait`, it just sleeps.
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = (): void => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          unsubscribe();
          resolve();
        };
        const timer = setTimeout(finish, waitMs);
        timer.unref?.();
        const unsubscribe = deps.activity
          ? deps.activity.subscribe((event) => {
              if (target.includes(event.conversationId)) finish();
            })
          : () => {};
      });
      if (batchMs > 0) await new Promise((resolve) => setTimeout(resolve, batchMs));
      entries = await read();
    }

    const cursor = entries.length > 0 ? (entries[entries.length - 1] as EntryView).entryId : since;
    const view = observe && only !== undefined ? await deps.seam.snapshot(only) : undefined;
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

  // --- The log as a stream: replay from a cursor, then follow --------------------
  //
  // The shape the API was converging on (§2.9): one monotonic entry id is the cursor for
  // *everything*, so a client sends the last id it saw and gets every entry after it — filtered to
  // one conversation or not at all — and then keeps receiving new ones. A reconnection is the same
  // request with the last id received, and the log is the buffer, so nothing can be missed and the
  // server remembers nothing about the reader.
  //
  // Differences from the verbs beside it, all deliberate:
  //   - `activity` events are included, but they are a convenience: a *user* entry means a turn
  //     started and a stamped *assistant* entry means one settled, so a client could derive both.
  //   - live text is NOT here. `view` frames are ephemeral — not facts, not replayable — and belong
  //     on the per-conversation stream (`/events` with a conversation, or `/view`), where a surface
  //     is actually painting.
  //   - replay is bounded, and "you are too far behind" is said out loud (`resync`) rather than
  //     heuristically guessed by the client.
  if (url.pathname === "/v1/events" && req.method === "GET") {
    const sinceRaw = Number(url.searchParams.get("since") ?? 0);
    const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? Math.floor(sinceRaw) : 0;
    const onlyParam = url.searchParams.get("conversation");
    const only = onlyParam === null ? undefined : Number(onlyParam);
    if (only !== undefined && !Number.isFinite(only)) {
      json(res, 400, { ok: false, error: "conversation must be a number" });
      return true;
    }

    // Scope is a *right to read*, not a client-supplied filter: without this an unfiltered stream
    // would hand a bridge the content of conversations it does not serve.
    const allowed = (await deps.conversations()).map((conversation) => conversation.conversationId);
    if (only !== undefined && !allowed.includes(only)) {
      json(res, 404, { ok: false, error: `no such conversation: ${only}` });
      return true;
    }
    const target = only === undefined ? allowed : [only];

    // Live text is opt-in and needs a conversation. `view` frames are ephemeral — not facts, not
    // replayable — and per-token text for every running turn is the most expensive thing this
    // server could push, so an unfiltered subscription to it is refused rather than served badly.
    const live = url.searchParams.get("live") === "1";
    if (live && only === undefined) {
      json(res, 400, { ok: false, error: "live=1 needs conversation=<id>: live text is per turn" });
      return true;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (event: string, data: unknown): void => {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // One cursor per conversation, because a page read is per conversation; the client sees one
    // monotonic id, which is what makes the stream addressable at all.
    const cursors = new Map<number, number>(target.map((conversationId) => [conversationId, since]));
    let newestSent = since;
    let stopped = false;
    const MAX_REPLAY = 500;

    const readForward = async (conversationId: number, maxEntries: number): Promise<boolean> => {
      const from = cursors.get(conversationId) ?? since;
      const window = await entriesAfter(
        { history: (id, limit, offset) => deps.seam.history(id, { limit, offset }) },
        conversationId,
        from,
        { pageSize: Math.min(200, Math.max(1, maxEntries)), maxPages: 1 },
      );
      for (const entry of window.entries) {
        if (stopped) return true;
        send("entry", {
          conversationId: entry.conversationId,
          entryId: entry.entryId,
          role: entry.role,
          text: entry.text,
          ...(entry.at === undefined ? {} : { at: entry.at }),
          ...(entry.origin === undefined ? {} : { origin: entry.origin }),
        });
        cursors.set(conversationId, entry.entryId);
        newestSent = Math.max(newestSent, entry.entryId);
      }
      // `reachedCursor` is the honest signal: the reader stops as soon as it sees an entry at or
      // before the cursor, so `false` means there is more history past the window — not merely that
      // this page was shorter than the budget.
      return window.reachedCursor;
    };

    // Say where the stream starts before anything arrives, so a client that receives no entries
    // knows its position rather than assuming.
    send("ready", { cursor: since, conversations: target.length });

    // --- Replay: bounded, and honest when the cursor is out of window. ---
    let budget = MAX_REPLAY;
    // Tracked from the reads themselves: a budget that reaches zero by subtraction is not the same
    // as history that ran out, and reporting the first as "you are too far behind" is a lie.
    let truncated = false;
    for (let round = 0; round < 10 && budget > 0 && !stopped; round += 1) {
      let drained = true;
      for (const conversationId of target) {
        if (budget <= 0) break;
        const share = Math.max(1, Math.floor(budget / Math.max(1, target.length)));
        const done = await readForward(conversationId, share);
        budget = Math.max(0, budget - share);
        if (!done) {
          drained = false;
          truncated = true;
        }
      }
      if (drained) break;
    }
    if (truncated && !stopped) {
      // More history than the window allows. Say so, and continue from the newest thing seen —
      // the reader decides whether to accept that, rather than being handed a flood.
      send("resync", { cursor: newestSent, dropped: true });
    }

    // Entries only ever arrive alongside a turn boundary, so activity is the trigger to read
    // forward again: one page read per boundary instead of a poll.
    const unsubscribe = deps.activity
      ? deps.activity.subscribe((event) => {
          if (!target.includes(event.conversationId)) return;
          send("activity", event);
          void readForward(event.conversationId, 50).catch(() => {});
        })
      : () => {};

    // The turn being written, if asked for: the snapshot first so a joiner paints immediately,
    // then a frame per update. This is the same projection the per-conversation streams serve, on
    // the same connection as the content — one subscription for a surface painting one conversation.
    let view: { detach(): void } | undefined;
    if (live && only !== undefined) {
      const attached = await deps.seam.attach(only, (projected) => send("view", projected));
      if (attached) {
        view = attached;
        send("view", attached.snapshot);
      }
    }

    const beat = setInterval(
      () => send("heartbeat", { at: Date.now(), cursor: newestSent }),
      deps.heartbeatMs ?? 15_000,
    );
    beat.unref?.();
    const stop = (): void => {
      stopped = true;
      clearInterval(beat);
      unsubscribe();
      view?.detach();
    };
    req.on("close", stop);
    res.on("close", stop);
    return true;
  }

  // --- One conversation's whole stream: boundaries and live state ----------------
  //
  // Everything a surface watching *one* conversation wants, over one connection: `activity` when a
  // turn starts or settles, `view` while it runs. Two streams with the same lifetime and the same
  // reader is a subscription nobody needs to hold twice — and the alternative, rolling them into
  // the unfiltered activity stream, would make that stream's contents depend on a query parameter
  // (cheap boundaries for everything, or expensive live state for one thing).
  const events = /^\/v1\/conversations\/(\d+)\/events$/.exec(url.pathname);
  if (events && req.method === "GET") {
    const conversationId = Number(events[1]);
    if ((await deps.seam.history(conversationId, { limit: 1, offset: 0 })) === undefined) {
      json(res, 404, { ok: false, error: `no such conversation: ${conversationId}` });
      return true;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (event: string, data: unknown): void => {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const view = await deps.seam.attach(conversationId, (projected) => send("view", projected));
    if (!view) {
      json(res, 404, { ok: false, error: `no such conversation: ${conversationId}` });
      return true;
    }
    send("view", view.snapshot); // a joiner paints immediately, as on the view stream

    const unsubscribe = deps.activity
      ? deps.activity.subscribe((event) => {
          if (event.conversationId === conversationId) send("activity", event);
        })
      : () => {};
    const beat = setInterval(() => send("heartbeat", { at: Date.now() }), deps.heartbeatMs ?? 15_000);
    beat.unref?.();
    const stop = (): void => {
      clearInterval(beat);
      unsubscribe();
      view.detach();
    };
    req.on("close", stop);
    res.on("close", stop);
    return true;
  }

  // --- The live view: what a running turn looks like, pushed --------------------
  //
  // Server-Sent Events rather than a socket: the pane already speaks it, a bridge needs
  // nothing more, and the whole state of a subscription is one HTTP response.
  //
  // Two event kinds and no more. `view` is the whole projection (a dropped frame is
  // harmless because the next one is complete). `heartbeat` is the fixed-cadence proof of
  // life — a client that stops seeing *either* should assume the stream is gone, which is
  // why the client's silence timer resets on any frame rather than only on heartbeats.
  const view = /^\/v1\/conversations\/(\d+)\/view$/.exec(url.pathname);
  if (view && req.method === "GET") {
    const conversationId = Number(view[1]);
    const probe = await deps.seam.history(conversationId, { limit: 1, offset: 0 });
    if (probe === undefined) {
      json(res, 404, { ok: false, error: `no such conversation: ${conversationId}` });
      return true;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Proxies that buffer would turn "live" into "at the end of the turn".
      "X-Accel-Buffering": "no",
    });
    const send = (event: string, data: unknown): void => {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // The snapshot first, so a client that attaches mid-turn paints immediately rather
    // than waiting for the next change.
    const handle = await deps.seam.attach(conversationId, (projected) => send("view", projected));
    if (!handle) {
      send("error", { error: `no such conversation: ${conversationId}` });
      res.end();
      return true;
    }
    send("view", handle.snapshot);

    const beat = setInterval(() => send("heartbeat", { at: Date.now() }), deps.heartbeatMs ?? 15_000);
    beat.unref?.();
    const stop = (): void => {
      clearInterval(beat);
      handle.detach();
    };
    req.on("close", stop);
    res.on("close", stop);
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
