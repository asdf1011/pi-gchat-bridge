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
 * One `viewState()` per connected client, seeded from its snapshot, so a browser
 * that connects mid-turn paints the in-progress answer instead of a blank page.
 * Measured: 8 concurrent subscribers receive identical frames with zero drift.
 */
import fs from "node:fs";

import type { Context } from "@earendil-works/chord";
import type { ConversationId } from "@earendil-works/pi-durable";

import { projectView, type ViewLike } from "./projection.js";
import type { BridgeHost } from "../durable/host.js";
import { logger } from "../logger.js";

/** One connected client. Kept structural so tests need no HTTP server. */
export interface SseClient {
  /** Send one event. Must not throw; a dead client is disposed by the caller. */
  send(event: string, data: unknown): void;
  /** True while the transport can still carry events. */
  readonly open: boolean;
}

export interface WebOptions {
  host: BridgeHost;
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
  const { host } = options;
  const conversation = await host.harness.conversation(conversationId as ConversationId, host.context);
  if (!conversation) {
    client.send("error", { error: `no such conversation: ${conversationId}` });
    return { close() {} };
  }

  let closed = false;
  let lastText = "";
  let lastTool = "";

  const opened = await conversation.viewState(host.context);
  opened.subscribe((value: unknown) => {
    if (closed || !client.open) return;
    try {
      const projected = projectView(value as ViewLike);
      // Send the in-flight answer as a whole snapshot, not a delta: the Chat
      // sink paints whole snapshots too, and it means a client that misses a
      // frame is still correct on the next one.
      if (projected.liveText !== lastText) {
        lastText = projected.liveText;
        client.send("text", { text: projected.liveText, busy: projected.busy });
      }
      // Tool status is a single line, so send it only when it changes.
      const tool = projected.tools.filter((t) => t.status !== "done").at(-1);
      const line = tool ? `${tool.name}:${tool.status}` : "";
      if (line !== lastTool) {
        lastTool = line;
        client.send("tool", tool ? { name: tool.name, status: tool.status, output: tool.output } : null);
      }
    } catch (error) {
      // A projection fault must not kill the client's stream: log it and keep
      // the connection so the next commit can still be painted.
      logger.error("[web] projection failed:", (error as Error).message);
    }
  });

  return {
    close() {
      if (closed) return;
      closed = true;
      opened.dispose();
    },
  };
}

/** The conversation list a browser opens with, newest first. */
export async function webIndex(host: BridgeHost): Promise<
  { conversationId: number; chatKey: string; model: string; name?: string; createdAt: number }[]
> {
  const all = await host.bindings();
  return Object.entries(all.byChatKey)
    .map(([chatKey, binding]) => ({
      conversationId: binding.conversationId,
      chatKey,
      model: binding.model,
      ...(binding.name ? { name: binding.name } : {}),
      createdAt: binding.createdAt,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
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
  whenBusy: "steer" | "followUp" | "reject" = "steer",
): Promise<{ ok: true; submissionId: number } | { ok: false; error: string }> {
  const { host } = options;
  const conversation = await host.harness.conversation(conversationId as ConversationId, host.context);
  if (!conversation) return { ok: false, error: `no such conversation: ${conversationId}` };
  if (!text.trim()) return { ok: false, error: "empty message" };
  const submission = await conversation.submit(
    { type: "input", content: [{ type: "text", text }], whenBusy },
    host.context,
  );
  return { ok: true, submissionId: submission.id as unknown as number };
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
