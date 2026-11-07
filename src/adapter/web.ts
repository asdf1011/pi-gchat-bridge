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
import { renderMarkdown, type RenderOptions } from "./markdown.js";
import type { ProjectedView } from "../session-host/projection.js";
import type { SessionHost, WhenBusy } from "../session-host/api.js";

/**
 * How this surface renders Markdown.
 *
 * Images on, because the pane is the one place a displayed picture is the point
 * — but only same-origin relative sources (`safeImageSrc`), and the page's CSP
 * names `img-src 'self'` as a second, independent barrier. Exported so the two
 * web route call sites pass the same thing as the submit echo; a picture must
 * not appear when the answer arrives and vanish on the next history read.
 */
export const WEB_RENDER_OPTIONS: RenderOptions = { images: true };

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

/**
 * The status line for a running tool, worded exactly as Chat words it.
 *
 * `toolStatusLine` in `stream.ts` renders "Running: `cmd`" as Chat markdown; this
 * is the same sentence as plain text, because the web pane shows it inside the
 * bubble rather than as a patched Chat message. Sharing the wording matters more
 * than sharing the function: the two surfaces should say the same thing about the
 * same tool.
 */
function toolLine(name: string, args: unknown): string {
  const detail = toolSummary(args);
  const label = detail && typeof (args as { command?: unknown })?.command === "string" ? "Running" : `Running ${name}`;
  return detail ? `${label}: ${detail}` : `${label}…`;
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
      const text = tool ? toolLine(tool.name, tool.arguments) : "";
      if (text !== lastTool) {
        lastTool = text;
        client.send(
          "tool",
          tool ? { name: tool.name, status: tool.status, output: tool.output, line: text } : null,
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
/**
 * One image attached to a web message: base64 as the browser read it, plus its
 * type. Whether it arrived by paste, file picker or drop is the browser's
 * business — by the time it is here it is just bytes to send.
 */
export interface PastedImage {
  data: string;
  mimeType: string;
}

/** Largest single image accepted from the web, in bytes after base64 decoding. */
export const MAX_WEB_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * Most images one message may carry.
 *
 * Exists to keep the body cap meaningful: ten images at 8 MB is already ~107 MB
 * of base64, more than the route's 24 MB body limit allows, so the realistic
 * ceiling is smaller than this. The cap is still worth stating, because a folder
 * dropped on the pane should be refused with a sentence about how many images a
 * message holds rather than a bare 413 from the body reader.
 */
export const MAX_WEB_IMAGES = 10;

export async function webSubmit(
  options: WebOptions,
  conversationId: number,
  text: string,
  whenBusy: WhenBusy = "steer",
  images: readonly PastedImage[] = [],
): Promise<{ ok: true; submissionId: number; html: string } | { ok: false; error: string }> {
  // Content parts, as Chat sends them: the model sees an image, the transcript
  // stores one, and the pane can render it from the entry.
  const content =
    images.length === 0
      ? text
      : [
          ...(text ? [{ type: "text" as const, text }] : []),
          ...images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
        ];
  // Stamped so a surface painting this conversation can tell a web message from one
  // its own transport already holds.
  const result = await options.seam.submit(conversationId, { content, whenBusy, origin: "webui" });
  return "error" in result
    ? { ok: false, error: result.error }
    : // Rendered here so the pane can show your message the moment it is sent,
      // in the same markup the transcript will use when it comes back.
      { ok: true, submissionId: result.submissionId, html: renderMarkdown(text, WEB_RENDER_OPTIONS) };
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
/**
 * Where a static asset beside the page lives, for both layouts.
 *
 * Same two-candidate trick as the page itself: from `src/` (tsx) the asset is
 * beside this module, from `dist/` the repository is one directory up. Named as
 * a function rather than a table because there are now two assets and hard-coding
 * a second array would invite them to drift apart.
 */
function assetCandidates(name: string): URL[] {
  return [
    new URL(`./web/${name}`, import.meta.url),
    new URL(`../../src/adapter/web/${name}`, import.meta.url),
  ];
}

function readAsset(name: string): string {
  const failures: string[] = [];
  for (const candidate of assetCandidates(name)) {
    try {
      return fs.readFileSync(candidate, "utf8");
    } catch (error) {
      failures.push(`${candidate.pathname}: ${(error as Error).message}`);
    }
  }
  throw new Error(`web asset ${name} not found — tried ${failures.join(", ")}`);
}

function readPage(): string {
  return readAsset("page.html");
}

/** The page as of process start. */
export const WEB_PAGE = readPage();

/**
 * The favicon, read once at startup like the page.
 *
 * Kept a string rather than bytes: it is UTF-8 SVG and served with an explicit
 * charset, so the browser never has to sniff. Left out of the version hash on
 * purpose — a new icon is not a reason to reload every open pane.

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
export const WEB_ICON = readAsset("icon.svg");

export function webPageVersion(): string {
  return createHash("sha256").update(webPage()).digest("hex").slice(0, 12);
}
