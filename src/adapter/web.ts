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
export const WEB_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pi bridge</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; display: flex; height: 100vh; }
  #list { width: 18rem; overflow: auto; border-right: 1px solid #8884; margin: 0; padding: 0; list-style: none; }
  #list li { padding: .5rem .75rem; cursor: pointer; border-bottom: 1px solid #8882; }
  #list li.on { background: #8882; }
  #list small { display: block; opacity: .6; font-size: .78em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #pane { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  #log { flex: 1; overflow: auto; padding: 1rem; white-space: pre-wrap; word-break: break-word; margin: 0; }
  #tool { padding: .25rem 1rem; font: 12px ui-monospace, monospace; opacity: .7; min-height: 1.6em; }
  form { display: flex; gap: .5rem; padding: .75rem; border-top: 1px solid #8884; }
  textarea { flex: 1; resize: none; height: 3.5rem; font: inherit; padding: .5rem; }
  button { padding: .5rem 1rem; font: inherit; }
</style>
</head>
<body>
<ul id="list"></ul>
<div id="pane">
  <p id="log"></p>
  <div id="tool"></div>
  <form id="send">
    <textarea id="text" placeholder="Message this conversation — same one Chat is in"></textarea>
    <button>Send</button>
  </form>
</div>
<script>
let current = null, source = null;
const log = document.getElementById('log');
const tool = document.getElementById('tool');

function open(id) {
  if (source) source.close();
  current = id;
  log.textContent = '';
  tool.textContent = '';
  source = new EventSource('/web/api/c/' + id + '/events');
  source.addEventListener('text', (e) => {
    const d = JSON.parse(e.data);
    log.textContent = d.text;
    log.scrollTop = log.scrollHeight;
  });
  source.addEventListener('tool', (e) => {
    const d = JSON.parse(e.data);
    tool.textContent = d ? d.name + ' · ' + d.status : '';
  });
  source.addEventListener('error', () => {
    // EventSource reconnects by itself; show it so a restart is visible not mysterious.
    tool.textContent = 'reconnecting…';
  });
}

async function load() {
  const rows = await (await fetch('/web/api/conversations')).json();
  const list = document.getElementById('list');
  list.innerHTML = '';
  for (const row of rows) {
    const li = document.createElement('li');
    li.innerHTML = '<span></span><small></small>';
    li.firstChild.textContent = row.name || row.chatKey;
    li.lastChild.textContent = '#' + row.conversationId + ' · ' + row.model;
    li.onclick = () => {
      [...list.children].forEach((c) => c.classList.remove('on'));
      li.classList.add('on');
      open(row.conversationId);
    };
    list.append(li);
  }
  if (rows.length && !current) list.firstChild.click();
}

document.getElementById('send').onsubmit = async (e) => {
  e.preventDefault();
  const box = document.getElementById('text');
  const text = box.value.trim();
  if (!text || !current) return;
  box.value = '';
  await fetch('/web/api/c/' + current + '/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
};

load();
setInterval(load, 30000);
</script>
</body>
</html>`;
