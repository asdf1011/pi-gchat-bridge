import { ChatClient, MAX_MESSAGE_CHARS } from "./chat-client.js";
import { MARKER_DELAY_MS, PATCH_DEBOUNCE_MS, THINKING_TEXT, TOOL_STATUS_DELAY_MS } from "./constants.js";
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
 *  The placeholder is PATCHed, so it renders legacy Chat syntax only — backtick
 *  monospace is the closest to a code block; the final answer renders real
 *  Markdown. Inner backticks are stripped so the wrap can't break. */
export function toolStatusLine(toolName: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const command = typeof a.command === "string" ? a.command.trim().replace(/\s+/g, " ") : "";
  const path = typeof a.path === "string" ? a.path.trim() : "";
  const detail = (command || path).replace(/`/g, "").slice(0, 140);
  // Legacy Chat syntax: "Running" is _italic_ (underscores), the command stays
  // in `monospace` backticks.
  const label = command ? "Running" : `Running ${toolName}`;
  return detail ? `_${label}:_ \`${detail}\`` : `_${label}_…`;
}

/**
 * Per-message streaming state: posts a "Thinking…" placeholder, patches it in
 * place as the reply streams in, relocates it below a steering message, and
 * replaces it with a fresh Markdown message when done (markupSyntax is
 * create-only, so a PATCH can't render Markdown).
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

  constructor(
    private client: ChatClient,
    private spaceName: string,
    private threadName: string | undefined,
    private display: string,
  ) {}

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

  /** Post the final answer: replace the placeholder (if any), then any overflow. */
  async finish(final: string): Promise<void> {
    this.clearTimers();
    // Show the final text (in the placeholder if one exists), then post overflow.
    this.streamed = final;
    // Replace the streamed placeholder with a fresh message: `markupSyntax`
    // is create-only (any text PATCH resets the message to legacy CHAT
    // syntax — verified Aug 2026), so the placeholder can't render Markdown.
    // The placeholder is silent where the API allows, so this final create
    // is the single notification that the answer is ready.
    if (this.markerName) {
      await this.patchNow();
      await this.client.deleteMessage(this.markerName).catch(() => {});
    }
    // The first chunk IS the answer (it notifies). Overflow chunks would
    // ideally be silent so long replies don't re-notify per 4000-char spill,
    // but NOTIFICATION_TYPE_SILENT 403s when combined with messageReplyOption
    // (threaded replies — verified Aug 2026); silent only works for top-level
    // creates, so threaded overflow posts normally.
    let rest = final;
    let first = true;
    while (rest.length > 0) {
      const silent = !first && !this.threadName ? { silent: true } : undefined;
      await this.client.sendMessage(this.spaceName, rest.slice(0, MAX_MESSAGE_CHARS), this.threadName, silent);
      rest = rest.slice(MAX_MESSAGE_CHARS);
      first = false;
    }
    logger.info(`[chat] ${this.display}: replied (${final.length} chars)`);
  }

  /** Handle an interrupt/error; keep a partial reply visible for aborts. */
  async onError(aborted: boolean): Promise<void> {
    if (this.markerTimer) clearTimeout(this.markerTimer);
    if (this.toolTimer) clearTimeout(this.toolTimer);
    if (aborted && this.streamed.trim()) {
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
      const silent = !this.threadName ? { silent: true } : undefined;
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
    const silent = !this.threadName ? { silent: true } : undefined;
    this.markerName = await this.client.createMessage(this.spaceName, THINKING_TEXT, this.threadName, silent);
    // A tool is already running — show its status right away.
    if (this.statusText) await this.patchNow();
  }

  /** Serialized placeholder update: only one PATCH in flight at a time. */
  private patchNow(): Promise<void> {
    this.patchChain = this.patchChain.then(async () => {
      this.patchTimer = undefined;
      const capped = this.displayText();
      if (capped && this.markerName) {
        try {
          await this.client.updateMessage(this.markerName, capped);
        } catch (err) {
          logger.error("[chat] patch failed:", (err as Error).message);
        }
      }
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
