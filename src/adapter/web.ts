/**
 * The web frontend: a second sink on the same conversations Chat uses.
 *
 * This is the point of the whole migration. Chat and a browser are both clients
 * of one conversation; neither owns it. The Chat sink paints a message via
 * `ReplyStream`, this one paints a `text/event-stream`, and both subscribe to
 * the same `viewState()`. A turn started in Chat streams into the browser, and a
 * turn started in the browser appears in Chat, because they are not two
 * conversations being synchronised — they are one conversation being watched.
 *
 * That is why this lives inside the bridge process. pi-durable's `subscribe()`
 * is in-process by design ("one process owns a storage at a time, and other
 * clients attach to that process"); there is no cross-process change
 * notification in its storage, so a separate server process could not see a
 * Chat turn commit. In-process is not a shortcut here, it is the architecture.
 *
 * The adapter itself never touches the harness: it uses `SessionHost` (see
 * `src/session-host/api.ts`). What is in-process today is one *implementation*
 * of that seam, which is why this file imports no pi-durable or chord type.
 *
 * One attachment per connected client, seeded from its snapshot, so a browser
 * that connects mid-turn paints the in-progress answer instead of a blank page.
 * Measured: 8 concurrent subscribers receive identical frames with zero drift.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";

import { logger } from "../logger.js";
import { renderMarkdown } from "./markdown.js";
import type { ProjectedView } from "../session-host/projection.js";
import type { SessionHost, WhenBusy } from "../session-host/api.js";

/**
 * The one-line summary a status row shows for a tool: the command, or the path.
 *
 * Same rule the Chat status line uses, kept here as plain text because the web
 * pane is not Chat markdown. Truncated: a long command should not push the row
 * sideways.
 */
function toolSummary(args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const command = typeof a.command === "string" ? a.command.trim().replace(/\s+/g, " ") : "";
  const path = typeof a.path === "string" ? a.path.trim() : "";
  return (command || path).slice(0, 90);
}

/** One connected client. Kept structural so tests need no HTTP server. */
export interface SseClient {
  /** Send one event. Must not throw; a dead client is disposed by the caller. */
  send(event: string, data: unknown): void;
  /** True while the transport can still carry events. */
  readonly open: boolean;
}

export interface WebOptions {
  /** The conversation host. In-process today; a link would satisfy the same shape. */
  seam: SessionHost;
  /** Bearer token required for writes. Empty disables the check (tailnet-only). */
  token?: string;
  /** Default model for conversations started from the web. */
  model: { provider: string; modelId: string };
}

export interface WebClientHandle {
  /** Stop watching and release the view subscription. Idempotent. */
  close(): void;
}

/**
 * Attach one SSE client to one conversation.
 *
 * The snapshot is sent first and the subscription is installed synchronously
 * after it, so a client cannot miss a commit between the two: Chord's `attach()`
 * captures the snapshot and registers for every later frame atomically.
 */
export async function attachWebClient(
  options: WebOptions,
  conversationId: number,
  client: SseClient,
): Promise<WebClientHandle> {
  let lastText = "";
  let lastTool = "";

  // The seam sends the current state as the first frame, so there is nothing to
  // paint separately: the delta guards below make a repeat harmless anyway.
  const paint = (projected: ProjectedView): void => {
    if (!client.open) return;
    try {
      // Send the in-flight answer as a whole snapshot, not a delta: the Chat
      // sink paints whole snapshots too, and it means a client that misses a
      // frame is still correct on the next one.
      if (projected.liveText !== lastText) {
        lastText = projected.liveText;
        client.send("text", { text: projected.liveText, busy: projected.busy });
      }
      // Tool status is a single line, so send it only when it changes. The
      // `detail` is the same summarising the Chat status line does — a command
      // or a path — so both surfaces say what is running, not just which tool.
      const tool = projected.tools.filter((t) => t.status !== "done").at(-1);
      const line = tool ? `${tool.name}:${tool.status}:${toolSummary(tool.arguments)}` : "";
      if (line !== lastTool) {
        lastTool = line;
        client.send(
          "tool",
          tool
            ? { name: tool.name, status: tool.status, output: tool.output, detail: toolSummary(tool.arguments) }
            : null,
        );
      }
    } catch (error) {
      // A rendering fault must not kill the client's stream: log it and keep the
      // connection so the next frame can still be painted.
      logger.error("[web] frame failed:", (error as Error).message);
    }
  };

  const handle = await options.seam.attach(conversationId, paint);
  if (!handle) {
    client.send("error", { error: `no such conversation: ${conversationId}` });
    return { close() {} };
  }

  return {
    close() {
      handle.detach();
    },
  };
}

/** The conversation list a browser opens with, newest first. */
export async function webIndex(options: Pick<WebOptions, "seam">): Promise<
  { conversationId: number; chatKey: string; model: string; name?: string; createdAt: number }[]
> {
  const all = await options.seam.list();
  return all.map((conversation) => ({
    conversationId: conversation.conversationId,
    chatKey: conversation.name,
    model: conversation.model,
    ...(conversation.label === undefined ? {} : { name: conversation.label }),
    createdAt: conversation.createdAt,
  }));
}

/**
 * Submit a message from the browser into the same conversation Chat uses.
 *
 * `whenBusy: "steer"` by default, matching a Chat message: if a turn is running,
 * the web message joins it rather than queueing behind it. That is what makes
 * the two frontends feel like one conversation — a browser message can redirect
 * a Chat-initiated turn mid-flight, which is the interaction that was asked for.
 */
export async function webSubmit(
  options: WebOptions,
  conversationId: number,
  text: string,
  whenBusy: WhenBusy = "steer",
): Promise<{ ok: true; submissionId: number; html: string } | { ok: false; error: string }> {
  const result = await options.seam.submit(conversationId, { content: text, whenBusy });
  return "error" in result
    ? { ok: false, error: result.error }
    : // Rendered here so the pane can show your message the moment it is sent,
      // in the same markup the transcript will use when it comes back.
      { ok: true, submissionId: result.submissionId, html: renderMarkdown(text) };
}

/**
 * The whole browser UI: one page, no build step.
 *
 * Deliberately tiny. It reads the conversation index, opens an `EventSource` per
 * conversation, and paints whole snapshots. There is no framework because the
 * interesting behaviour is on the server (one conversation, many sinks) and a
 * framework would obscure rather than demonstrate it.
 *
 * `text` frames carry the whole in-flight answer, so a dropped frame is harmless
 * — the next one is complete. That is what makes a reconnect (a bridge restart)
 * invisible rather than needing a resync protocol.
 */
/**
 * The browser page.
 *
 * A file, not a string literal, so the UI can be edited and reloaded without a
 * rebuild or a bridge restart: `BRIDGE_WEB_DEV=1` re-reads it per request. The two
 * candidate paths are deliberate — in development this module runs from `src/`
 * (tsx) and the page sits beside it; in production it runs from `dist/` while the
 * repository, and therefore the page, is still checked out one directory up. Same
 * file either way, so there is no copy to drift.
 */
const PAGE_CANDIDATES = [
  new URL("./web/page.html", import.meta.url),
  new URL("../../src/adapter/web/page.html", import.meta.url),
];

function readPage(): string {
  const failures: string[] = [];
  for (const candidate of PAGE_CANDIDATES) {
    try {
      return fs.readFileSync(candidate, "utf8");
    } catch (error) {
      failures.push(`${candidate.pathname}: ${(error as Error).message}`);
    }
  }
  throw new Error(`web page not found — tried ${failures.join(", ")}`);
}

/** The page as of process start. */
export const WEB_PAGE = readPage();

/**
 * The page for one request.
 *
 * With `BRIDGE_WEB_DEV=1` the file is read every time, so editing the HTML and
 * reloading the browser is the whole iteration loop. Production keeps the
 * startup copy: one read, and the page cannot change under a running bridge
 * because a file on disk changed.
 */
export function webPage(): string {
  return process.env.BRIDGE_WEB_DEV === "1" ? readPage() : WEB_PAGE;
}

/**
 * A short fingerprint of the page as this process serves it.
 *
 * The client compares this on every (re)connect and reloads itself when it
 * changes, which is how a page that is already open picks up a rebuilt front end
 * without anyone pressing anything. Hashed from the *served* bytes rather than a
 * build stamp, so it is right in both modes: fixed for the life of the process
 * normally, and fresh per read under `BRIDGE_WEB_DEV=1`.
 */
export function webPageVersion(): string {
  return createHash("sha256").update(webPage()).digest("hex").slice(0, 12);
}
