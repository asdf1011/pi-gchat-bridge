import { ChatClient, MAX_MESSAGE_CHARS } from "./chat-client.js";
import { MARKER_DELAY_MS, PATCH_DEBOUNCE_MS, THINKING_TEXT, TOOL_STATUS_DELAY_MS } from "./constants.js";
import { toChatMarkdown } from "./chat-markdown.js";
import { logger } from "./logger.js";

/**
 * Live streaming markers per conversation: the running turn's ReplyStream
 * registers its placeholder here so a steering message (a separate handler
 * invocation) can relocate the placeholder BELOW the steering message. Google
 * Chat orders thread messages by creation time, so without relocation the
 * reply — which now covers the steer — would render above the steering text.
 * Entries are removed when the owning handler finishes.
 */
export const markers = new Map<string, { owner: object; relocate: () => Promise<void> }>();

/** One-line status shown under the stream while a tool is running (e.g. the command).
 *  The placeholder is PATCHed with `markupSyntax: MARKDOWN` (verified Oct 2026),
 *  so this renders as real Markdown: backtick monospace for the command, italic
 *  for the label. Inner backticks are stripped so the span can't break. */
export function toolStatusLine(toolName: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const command = typeof a.command === "string" ? a.command.trim().replace(/\s+/g, " ") : "";
  const path = typeof a.path === "string" ? a.path.trim() : "";
  const detail = (command || path).replace(/`/g, "").slice(0, 140);
  const label = command ? "Running" : `Running ${toolName}`;
  return detail ? `_${label}:_ \`${detail}\`` : `_${label}_…`;
}

/** Opening fence line (``` or ~~~), used to keep chunks inside valid code blocks. */
const FENCE_LINE_RE = /^\s{0,3}(`{3,}|~{3,})/;

/** The still-open fence run at the end of `text`, if any. */
function openFence(text: string): string | undefined {
  let open: string | undefined;
  for (const line of text.split("\n")) {
    const m = FENCE_LINE_RE.exec(line);
    if (!m) continue;
    if (!open) open = m[1];
    else if (m[1][0] === open[0] && m[1].length >= open.length) open = undefined;
  }
  return open;
}

/**
 * Split `text` into Chat's per-message character cap, without losing anything.
 *
 * Cuts at a line boundary where one is available (a hard slice mid-line is what
 * makes a split reply look like two unfinished sentences), and closes/reopens a
 * fenced code block across the cut so the second half isn't rendered as prose.
 */
export function splitMessage(text: string, max: number = MAX_MESSAGE_CHARS): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max - 1);
    if (cut <= 0) cut = max; // no usable newline — hard cut
    let chunk = rest.slice(0, cut);
    const fence = openFence(chunk);
    if (fence) chunk += `\n${fence}`;
    chunks.push(chunk);
    rest = rest.slice(cut);
    if (rest.startsWith("\n")) rest = rest.slice(1);
    if (fence) rest = `${fence}\n${rest}`;
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

/**
 * Per-message streaming state: posts a "Thinking…" placeholder, patches it in
 * place as the reply streams in, relocates it below a steering message, and
 * either keeps it as the final answer (default) or replaces it with a fresh
 * Markdown message when done (`replaceOnFinish`, the pre-Oct-2026 behaviour).
 *
 * Both modes send Markdown-syntax PATCHes now (`markupSyntax` in the body —
 * see ChatClient.updateMessage), so the streamed text renders properly.
 *
 * A new instance is created per incoming message. Register it with the
 * conversation key so the steering path can relocate the placeholder, and
 * unregister in a finally block.
 */
export class ReplyStream {
  private markerName: string | undefined;
  private markerTimer: NodeJS.Timeout | undefined;
  private patchTimer: NodeJS.Timeout | undefined;
  private toolTimer: NodeJS.Timeout | undefined;
  private statusText: string | undefined;
  private patchChain: Promise<void> = Promise.resolve();
  private relocateChain: Promise<void> = Promise.resolve();
  private readonly owner: object = {};
  private streamed = "";
  /** Post a fresh message with the final answer instead of keeping the patched placeholder. */
  private readonly replaceOnFinish: boolean;

  constructor(
    private client: ChatClient,
    private spaceName: string,
    private threadName: string | undefined,
    private display: string,
    opts: { replaceOnFinish?: boolean } = {},
  ) {
    this.replaceOnFinish = opts.replaceOnFinish ?? true;
  }

  /** Register in the shared markers map and start the placeholder delay timer. */
  register(sessionKey: string): void {
    markers.set(sessionKey, { owner: this.owner, relocate: () => this.relocate() });
    this.markerTimer = setTimeout(() => {
      void this.ensureMarker().catch((err) => logger.error("[chat] marker failed:", (err as Error).message));
    }, MARKER_DELAY_MS);
  }

  /** Remove this stream's marker registration (only if it still owns it). */
  unregister(sessionKey: string): void {
    if (markers.get(sessionKey)?.owner === this.owner) markers.delete(sessionKey);
  }

  /** Append a streamed text delta and schedule a debounced patch. */
  onDelta(delta: string): void {
    this.streamed += delta;
    if (this.streamed.length > MAX_MESSAGE_CHARS) return; // stop patching past the cap
    if (!this.patchTimer) this.patchTimer = setTimeout(() => void this.patchNow(), PATCH_DEBOUNCE_MS);
  }

  /** Show the tool status after a short delay (fast tools shouldn't flicker). */
  showTool(toolName: string, args: unknown): void {
    if (this.toolTimer) clearTimeout(this.toolTimer);
    const line = toolStatusLine(toolName, args);
    this.toolTimer = setTimeout(() => {
      this.toolTimer = undefined;
      this.statusText = line;
      void this.patchNow();
    }, TOOL_STATUS_DELAY_MS);
  }

  /** Clear the tool status line when the tool finishes. */
  clearTool(): void {
    if (this.toolTimer) clearTimeout(this.toolTimer);
    this.toolTimer = undefined;
    if (this.statusText) {
      this.statusText = undefined;
      void this.patchNow();
    }
  }

  /** Drop the placeholder (session became busy, or the reply was empty). */
  async abandon(): Promise<void> {
    this.clearTimers();
    if (this.markerName) await this.client.deleteMessage(this.markerName).catch(() => {});
  }

  /** Post the final answer: either keep the patched placeholder, or replace it. */
  async finish(final: string): Promise<void> {
    this.clearTimers();
    // Show the final text (in the placeholder if one exists), then post overflow.
    // Normalise for Chat's renderer *before* splitting so a table can't be cut
    // in half; the client normalises again on the way out (it's idempotent).
    this.streamed = final;
    const chunks = splitMessage(toChatMarkdown(final));

    if (chunks.length === 0) {
      if (this.markerName) await this.client.deleteMessage(this.markerName).catch(() => {});
      return;
    }

    if (this.replaceOnFinish) {
      // Notifications fire on create, not on PATCH, so an "answer is ready" ping
      // means the answer must be a new message — and the placeholder then has to
      // go, leaving a "Message deleted" stub. That stub is the price of the
      // completion ping (there is no other notify-on-update hook with app auth).
      //
      // Post first, delete second: if the create fails, the streamed text is
      // still on screen and we keep the placeholder as the answer instead of
      // losing the reply.
      let posted = false;
      try {
        await this.client.sendMessage(this.spaceName, chunks[0], this.threadName);
        posted = true;
      } catch (err) {
        logger.error("[chat] final post failed — keeping the streamed placeholder:", (err as Error).message);
      }
      if (posted) {
        await this.postChunks(chunks, 1, { firstNotifies: false });
        if (this.markerName) await this.client.deleteMessage(this.markerName).catch(() => {});
      } else if (this.markerName) {
        // Fallback: the placeholder becomes the answer (no ping, but no loss).
        await this.patchText(chunks[0]);
        await this.postChunks(chunks, 1, { firstNotifies: false }).catch((e) =>
          logger.error("[chat] overflow post failed:", (e as Error).message),
        );
      }
      this.markerName = undefined;
    } else {
      // In-place: the placeholder becomes the answer. Markdown survives the
      // PATCH now, so there's no delete+recreate and no "Message deleted" stub.
      let start = 0;
      if (this.markerName) {
        if (await this.patchText(chunks[0])) {
          start = 1;
        } else {
          // PATCH failed (or Markdown wasn't honoured) — fall back to replace
          // so the answer is still delivered.
          await this.client.deleteMessage(this.markerName).catch(() => {});
          this.markerName = undefined;
        }
      }
      await this.postChunks(chunks, start, { firstNotifies: start === 0 });
    }
    logger.info(`[chat] ${this.display}: replied (${final.length} chars)`);
  }

  /**
   * Post `chunks[start..]` as new messages. `firstNotifies` marks whether the
   * first posted chunk is the one that should notify (only true when nothing
   * was patched in place); later chunks are silent where the API allows it.
   */
  private async postChunks(chunks: string[], start: number, opts: { firstNotifies: boolean }): Promise<void> {
    for (let i = start; i < chunks.length; i++) {
      const silent = !this.threadName && !(opts.firstNotifies && i === start) ? { silent: true } : undefined;
      await this.client.sendMessage(this.spaceName, chunks[i], this.threadName, silent);
    }
  }

  /** Handle an interrupt/error; keep a partial reply visible for aborts. */
  async onError(aborted: boolean): Promise<void> {
    if (this.markerTimer) clearTimeout(this.markerTimer);
    if (this.toolTimer) clearTimeout(this.toolTimer);
    if (aborted && this.streamed.trim()) {
      if (this.markerName && !this.replaceOnFinish) {
        // The placeholder already holds the partial reply as Markdown — keep it.
        this.statusText = undefined;
        await this.patchNow();
        return;
      }
      // Implicit stop: keep the partial reply visible, but replace the
      // streamed placeholder with a fresh message so it renders as Markdown.
      const partial = this.streamed.trim().slice(0, MAX_MESSAGE_CHARS);
      if (this.markerName) {
        await this.client.deleteMessage(this.markerName).catch(() => {});
        this.markerName = undefined;
      }
      if (partial) {
        await this.client.sendMessage(this.spaceName, partial, this.threadName).catch((e) =>
          logger.error("[chat] final partial post failed:", (e as Error).message),
        );
      }
    } else if (this.markerName) {
      await this.client.deleteMessage(this.markerName).catch(() => {});
    }
  }

  /** Text to show in the placeholder: the stream plus any transient status line. */
  private displayText(): string {
    if (!this.statusText) return this.streamed.slice(0, MAX_MESSAGE_CHARS);
    const status = this.statusText.slice(0, 200);
    const base = this.streamed.slice(0, Math.max(0, MAX_MESSAGE_CHARS - status.length - 2));
    return base ? `${base}\n\n${status}` : status;
  }

  /**
   * Move the streaming placeholder below a steering message. Google Chat
   * orders thread messages by creation time, so a placeholder created before
   * the steer would render ABOVE the steering text once the reply covers it.
   * The old placeholder is kept where it is when it already carries real
   * text (a frozen record), and a fresh one is created below the steer. Only a
   * bare "Thinking…" placeholder (nothing streamed yet) is deleted.
   */
  private relocate(): Promise<void> {
    this.relocateChain = this.relocateChain.then(async () => {
      await this.patchChain; // settle queued patches before freezing the old marker
      const old = this.markerName;
      if (!old) return; // no placeholder yet — the one created later lands after the steer anyway
      this.markerName = undefined; // meanwhile patchNow() becomes a no-op
      if (this.streamed.trim()) {
        logger.info(`[chat] steer: kept ${this.streamed.length} chars of partial reply above the steer`);
      } else {
        await this.client.deleteMessage(old).catch(() => {});
      }
      // Reset the accumulator so the fresh marker only ever shows text
      // streamed AFTER the steer — the frozen message above already holds
      // the rest. The final answer posted at the end is the complete text.
      this.streamed = "";
      const silent = !this.threadName && this.replaceOnFinish ? { silent: true } : undefined;
      this.markerName = await this.client.createMessage(this.spaceName, THINKING_TEXT, this.threadName, silent);
      const capped = this.displayText();
      if (capped) {
        try {
          await this.client.updateMessage(this.markerName, capped);
        } catch (err) {
          logger.error("[chat] relocate carry-over failed:", (err as Error).message);
        }
      }
    });
    return this.relocateChain;
  }

  /** Create the placeholder on demand (called by the delay timer). */
  private async ensureMarker(): Promise<void> {
    if (this.markerName) return;
    // In replace mode the placeholder is silent where allowed and the final
    // create notifies. In in-place mode the placeholder IS the answer, so it
    // must be the thing that notifies (otherwise a slow top-level reply would
    // arrive with no ping at all).
    const silent = !this.threadName && this.replaceOnFinish ? { silent: true } : undefined;
    this.markerName = await this.client.createMessage(this.spaceName, THINKING_TEXT, this.threadName, silent);
    // A tool is already running — show its status right away.
    if (this.statusText) await this.patchNow();
  }

  /** PATCH the placeholder's text (Markdown); returns false when the call fails. */
  private async patchText(text: string): Promise<boolean> {
    if (!text || !this.markerName) return false;
    try {
      await this.client.updateMessage(this.markerName, text);
      return true;
    } catch (err) {
      logger.error("[chat] patch failed:", (err as Error).message);
      return false;
    }
  }

  /** Serialized placeholder update: only one PATCH in flight at a time. */
  private patchNow(): Promise<void> {
    this.patchChain = this.patchChain.then(async () => {
      this.patchTimer = undefined;
      const capped = this.displayText();
      if (capped && this.markerName) await this.patchText(capped);
    });
    return this.patchChain;
  }

  private clearTimers(): void {
    if (this.patchTimer) clearTimeout(this.patchTimer);
    if (this.markerTimer) clearTimeout(this.markerTimer);
    if (this.toolTimer) clearTimeout(this.toolTimer);
    this.statusText = undefined;
  }
}
