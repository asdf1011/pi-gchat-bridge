/**
 * The delivery cursor and its one mouth: the painter, and the loops that feed it.
 *
 * Moved out of the bridge's main file unchanged. Everything here is the Chat adapter's own business —
 * its position, its threads, its posting — and none of it is the conversation store's. Keeping it in
 * `main.ts` meant adapter and host shared a file, so the line between them was a convention; the next
 * boundary is a process, and this is the code that has to be on the far side of it.
 */
import path from "node:path";

import { logger } from "../logger.js";
import { chatTarget } from "../session-key.js";
import { splitMessage } from "../stream.js";
import type { ProjectedView } from "../session-host/projection.js";
import { entriesAfter } from "./entries.js";
import { Ledger } from "./ledger.js";
import { observeTurn } from "./observe.js";
import { Painter, type PaintSummary } from "./painter.js";
import { httpPoll } from "../adapter/poll-client.js";
import { ReplyStream } from "../stream.js";
import { attachViewSink, viewFramePainter } from "../adapter/view-sink.js";
import type { SessionHost } from "../session-host/api.js";
import type { Config } from "../config.js";
import type { ChatClient } from "../chat-client.js";

export interface ChatPainterOptions {
  /** The adapter's seam: a link, once the adapter is a separate process. */
  seam: SessionHost;
  config: Config;
  client: ChatClient;
  /** Where the store lives, for the ledger's default home beside it. */
  dbPath: string;
}

/** The painter, started and stoppable: two things `main.ts` used to hold as loose variables. */
export interface ChatPainter {
  /** Read the log now, for one conversation's turn — what the settle edge calls. */
  poke(): Promise<unknown>;
  /** The last tick's summary, for diagnostics. */
  last(): PaintSummary | undefined;
  /** Stop the timer and any held poll. */
  stop(): void;
}

export async function startChatPainter(options: ChatPainterOptions): Promise<ChatPainter> {
  let paintTimer: NodeJS.Timeout | undefined;
  let painter: Painter | undefined;
  let pollAbort: AbortController | undefined;

  const ledgerFile =
    options.config.ledgerPath === ""
      ? path.join(path.dirname(options.dbPath), "bridge-ledger.json")
      : options.config.ledgerPath;
  const ledger = await Ledger.load(ledgerFile);
  // The shadow pass is gone. It existed to prove a cursor against real transcripts while the
  // legacy path still posted; the painter posts now, so the pass was left observing a mouth that
  // was already the same object — and worse, *confirming* entries the painter had not painted
  // yet, which is how an answer gets stolen. The cursor is simply the painter's memory.
  logger.info(`[ledger] positions in ${ledgerFile}${ledger.recovered ? " (unreadable: adopting afresh)" : ""}`);

  // --- The painter: the one mouth for the conversations it owns -----------------
  //
  // Rolled out per *conversation*, not per bridge: there is one Chat bridge, so
  // "one bridge at a time" is all or nothing, whereas a conversation is exactly the
  // unit whose cursor, thread and notification policy are already its own. Opted-in
  // threads get their turns posted here and the handler keeps its hands off them
  // (same predicate, same process, so the two cannot disagree).
  {
    logger.info(
      `[paint] posting for every Chat conversation — the handler will not; painting ${
        options.config.viewMode === "poll" ? "by polling the snapshot (the extracted shape)" : "in-process"
      }`,
    );
    // The address a conversation lives at. Read per use rather than cached: bindings
    // are rewritten on every message, and a stale key here would post into the wrong
    // thread — the failure this whole arrangement exists to make impossible.
    // Through the seam, not the host: this is adapter code, and the fork is the point at which
    // reaching into the host's own documents stops compiling.
    const addressOf = async (conversationId: number): Promise<string | undefined> => {
      const bound = await options.seam.list().catch(() => []);
      return bound.find((row) => row.conversationId === conversationId)?.name;
    };
    painter = new Painter({
      surface: "gchat",
      ledger,
      // Every conversation that lives in Chat, and nothing else: a web-only
      // conversation has no thread for this bridge to keep up.
      owns: () => true,
      conversations: async () => {
        const bound = await options.seam.list().catch(() => []);
        return bound
          .filter((row) => row.name.startsWith("spaces/"))
          .map((row) => ({
            conversationId: row.conversationId,
            ...(row.lastActivityAt === undefined ? {} : { lastActivityAt: row.lastActivityAt }),
          }));
      },
      // The painter walks forward from its cursor, so this asks the seam the same question the
      // protocol answers: entries after an id, bounded. The `entries` helper does the grouping
      // (one entry per surface message) that the wire format already assumes.
      entriesSince: async (conversationId, since, limit) => {
        const window = await entriesAfter(
          { history: (id, pageLimit, offset) => options.seam.history(id, { limit: pageLimit, offset }) },
          conversationId,
          since,
          { pageSize: limit, maxPages: 1 },
        );
        return window.entries;
      },
      busy: async (conversationId) => (await options.seam.snapshot(conversationId))?.busy === true,
      // The painting half, when the surface is not in-process: poll the snapshot while a turn
      // runs. Three updates a second is finer than the 250ms debounce the Chat placeholder already
      // applies to its own text, so a poll is not a compromise on how an answer appears — and it
      // needs no connection, no heartbeat and no reconnect.
      watch:
        options.config.viewMode !== "in-process"
          ? (conversationId: number, handlers: { frame(projected: unknown): void; settled(): void }) => {
              // One request in flight, held until the draft or the log moves. The entries it
              // carries go through the same delivery path as the poll beside it; the cursor is
              // what keeps the two from posting anything twice.
              const stop = new AbortController();
              observeTurn(
                {
                  baseUrl: options.config.selfUrl === "" ? `http://127.0.0.1:${options.config.healthPort}` : options.config.selfUrl,
                  conversationId,
                  ...(options.config.webToken ? { token: options.config.webToken } : {}),
                  since: () => ledger.cursor,
                  onEntries: (entries) => instance.ingest(entries),
                  onFrame: (view) => handlers.frame(view),
                  onSettled: () => handlers.settled(),
                  log: (line) => logger.info(line),
                },
                stop.signal,
              );
              return { detach: () => stop.abort() };
            }
          : undefined,
      surfaceClient: {
        // The stream and its subscription are one act: a Chat placeholder cannot be
        // patched before it exists, and creating it later would be a second message.
        // Opening a stream is all this does. Subscribing it is the *watcher's* job in
        // stream mode (one subscription held across turns), and the sink's in-process mode,
        // so a conversation never ends up with two.
        open: async (conversationId) => {
          const target = chatTarget(await addressOf(conversationId));
          if (!target) return undefined;
          const key = (await addressOf(conversationId)) ?? String(conversationId);
          const stream = new ReplyStream(options.client, target.space, target.threadName, "gchat", {
            replaceOnFinish: options.config.replaceOnFinish,
          });
          stream.register(key);
          const paint = viewFramePainter(stream);

          if (options.config.viewMode === "poll") {
            // The watcher paints; nothing to attach here.
            return {
              stream: {
                text: (full) => stream.onSnapshot(full),
                tool: (name, args) => stream.showTool(name, args),
                clearTool: () => stream.clearTool(),
                finish: async (text) => {
                  await stream.finish(text);
                  stream.unregister(key);
                },
                abandon: async () => {
                  await stream.abandon();
                  stream.unregister(key);
                },
              },
              paint: (projected) => paint(projected as ProjectedView),
              detach: () => stream.unregister(key),
            };
          }

          // In-process: the sink subscribes, paints and reports the settle edge itself.
          const sink = await attachViewSink({
            seam: options.seam,
            conversationId,
            stream,
            onSettle: () => void painter?.poke(),
          });
          return {
            stream: {
              text: (full) => stream.onSnapshot(full),
              tool: (name, args) => stream.showTool(name, args),
              clearTool: () => stream.clearTool(),
              finish: async (text) => {
                await stream.finish(text);
                stream.unregister(key);
              },
              abandon: async () => {
                await stream.abandon();
                stream.unregister(key);
              },
            },
            paint: () => {}, // the sink is already painting this stream
            detach: () => {
              sink.detach();
              stream.unregister(key);
            },
          };
        },
        post: async (conversationId, text) => {
          const target = chatTarget(await addressOf(conversationId));
          if (!target) return;
          for (const [index, chunk] of splitMessage(text).entries()) {
            await options.client.sendMessage(
              target.space,
              chunk,
              target.threadName,
              index > 0 && target.threadName === undefined ? { silent: true } : undefined,
            );
          }
        },
      },
    });
    // The interval is the fallback for a deployment with no activity stream: it catches a
    // turn nothing announced (a web message, a resume after a restart).
    const instance = painter;
    // Periodic work, and *what* it is depends on whether there is a push path:
    //
    //   - no activity stream (in-process): the sweep is the mechanism, so it walks every
    //     conversation, on the shorter interval it has always used;
    //   - activity stream: the mechanism is the event, and all that is left to check is turns
    //     that claimed to start and never finished — normally an empty set, so normally no
    //     reads. A blanket sweep here would be a second mechanism doing nothing until something
    //     broke, which is a fair thing to refuse.
    const polled = options.config.viewMode === "poll";
    paintTimer = setInterval(
      () => void instance.tick(),
      polled ? 60_000 : Math.min(options.config.ledgerIntervalMs, 15_000),
    );
    paintTimer.unref();

    // --- The delivery path: long-poll the log -------------------------------------
    //
    // The sweep above stays as the fallback; this is the mechanism. It is a loop of ordinary
    // requests, so there is no connection to lose, no heartbeat to miss and no reconnect ladder:
    // the cursor is the position, and a timeout is an ordinary answer. `wait` bounds how long a
    // request may be held, and `batch` lets a turn's burst arrive as one response.
    //
    // Deliberately *beside* the sweep for now — both go through `ingest`, which is serialised and
    // skips anything at or below the cursor, so whichever runs first consumes and the other finds
    // nothing. Proving the poll in parallel is cheaper than being wrong alone.
    const pollStop = new AbortController();
  pollAbort = pollStop;
    const poll = async (): Promise<void> => {
      let backoff = 1_000;
      while (!pollStop.signal.aborted) {
        try {
          const result = await httpPoll({
            baseUrl: options.config.selfUrl === "" ? `http://127.0.0.1:${options.config.healthPort}` : options.config.selfUrl,
            since: ledger.cursor,
            waitSeconds: 25,
            batchMs: 250,
            ...(options.config.webToken ? { token: options.config.webToken } : {}),
            signal: pollStop.signal,
          });
          if (result.entries.length > 0) await instance.ingest(result.entries);
          backoff = 1_000;
        } catch (error) {
          if (pollStop.signal.aborted) return;
          logger.warn(`[paint] poll failed (${(error as Error).message}) — retrying in ${backoff}ms`);
          await new Promise((resolve) => setTimeout(resolve, backoff));
          backoff = Math.min(30_000, backoff * 2);
        }
      }
    };
    void poll();
    void instance.tick();
  }

  return {
    poke: () => painter?.poke() ?? Promise.resolve(undefined),
    last: () => painter?.last(),
    stop: () => {
      pollAbort?.abort();
      if (paintTimer) clearInterval(paintTimer);
      painter?.close();
      paintTimer = undefined;
      pollAbort = undefined;
    },
  };
}
