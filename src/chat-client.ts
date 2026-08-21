import { ServiceAccountAuth } from "./auth.js";

import type { ChatAttachment, IncomingMessage } from "./types.js";

const CHAT_BOT_SCOPE = "https://www.googleapis.com/auth/chat.bot";
const CHAT_API_BASE = "https://chat.googleapis.com/v1";
/** Media download endpoint used when an attachment has no `contentUri`. */
const MEDIA_API_BASE = "https://chat.googleapis.com/v1/media";
/** Image extensions for attachments whose event payload lacks a contentType. */
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;
/** Hard cap for a single Chat text message (API limit is 4096). */
export const MAX_MESSAGE_CHARS = 4000;

/** Infer an image MIME type from a file name extension (last-resort fallback). */
function mimeFromName(name: string | undefined): string | undefined {
  const ext = (name ?? "").split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "bmp":
      return "image/bmp";
    default:
      return undefined;
  }
}
/**
 * Render message `text` as standard Markdown (CommonMark-based) instead of
 * legacy Chat `*bold*` syntax. GA since Aug 7, 2026; works with app auth.
 */
const MARKUP_SYNTAX_MARKDOWN = "MARKUP_SYNTAX_MARKDOWN";
/** Silent messages suppress push notifications and don't mark the space unread (app auth, GA since May 8, 2026). */
const NOTIFICATION_TYPE_SILENT = "NOTIFICATION_TYPE_SILENT";

/**
 * Thin wrapper around the Google Chat REST API, authenticated as the Chat
 * app's service account (bot identity).
 */
export class ChatClient {
  private auth: ServiceAccountAuth;
  /**
   * Cache of downloaded attachments keyed by attachment name, so a message
   * redelivered after a "busy" defer doesn't re-fetch the same bytes.
   */
  private attachmentCache = new Map<string, { data: string; mimeType: string; name?: string }>();
  private static readonly ATTACHMENT_CACHE_MAX = 64;
  /** Skip pasted images larger than this (raw bytes) — beyond typical
   *  screenshots, and the LLM API would reject them anyway. */
  private static readonly MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

  constructor(serviceAccountPath: string) {
    this.auth = new ServiceAccountAuth(serviceAccountPath, [CHAT_BOT_SCOPE]);
  }

  /**
   * Download an image attachment and return it as base64 + mimeType ready for
   * pi's `images` content blocks. Returns undefined when the attachment isn't
   * an image or can't be fetched (caller continues with text only).
   *
   * Follows Google's documented flow for app auth (chat.bot):
   *   1. Metadata — the MESSAGE event carries only partial attachment data, so
   *      when contentType or a download reference is missing, fetch the
   *      Attachment resource (`spaces.messages.attachments.get`).
   *   2. Download — prefer the event's `contentUri`; otherwise call
   *      `media.download` with `attachmentDataRef.resourceName`.
   */
  async downloadAttachment(
    attachment: ChatAttachment,
  ): Promise<{ data: string; mimeType: string; name?: string } | undefined> {
    const key = attachment.name ?? attachment.contentUri ?? attachment.contentName;
    if (key) {
      const cached = this.attachmentCache.get(key);
      if (cached) return cached;
    }

    // --- Resolve full metadata when the event gave us partial data. ---
    let meta: ChatAttachment = attachment;
    if (meta.name && (!meta.contentType || !(meta.contentUri || meta.attachmentDataRef?.resourceName))) {
      try {
        const full = (await this.auth.request("GET", `${CHAT_API_BASE}/${meta.name}`, undefined, 15_000)) as ChatAttachment;
        meta = { ...meta, ...full };
      } catch (err) {
        console.warn("[chat] attachment metadata fetch failed:", (err as Error).message);
      }
    }

    // --- Is it an image? contentType wins; fall back to the file extension. ---
    const mime = meta.contentType?.toLowerCase();
    const isImage = mime ? mime.startsWith("image/") : IMAGE_EXT_RE.test(meta.contentName ?? "");
    if (!isImage) {
      console.log(`[chat] attachment ${meta.contentName ?? key ?? "?"} (${mime ?? "unknown type"}) is not an image — skipping`);
      return undefined;
    }
    const finalMime = mime ?? mimeFromName(meta.contentName);
    if (!finalMime) return undefined;

    // --- Download the bytes. ---
    const mediaRef = meta.attachmentDataRef?.resourceName;
    const url = meta.contentUri
      ? meta.contentUri
      : mediaRef
        ? `${MEDIA_API_BASE}/${encodeURIComponent(mediaRef)}?alt=media`
        : undefined;
    if (!url) {
      console.warn("[chat] attachment has no contentUri or attachmentDataRef; skipping");
      return undefined;
    }
    let bytes: Buffer;
    try {
      bytes = await this.auth.requestBuffer(url, 30_000);
    } catch (err) {
      console.error("[chat] attachment download failed:", (err as Error).message);
      return undefined;
    }
    if (bytes.length > ChatClient.MAX_ATTACHMENT_BYTES) {
      console.warn(`[chat] attachment ${meta.contentName ?? key ?? ""} is ${bytes.length} bytes — skipping (cap ${ChatClient.MAX_ATTACHMENT_BYTES})`);
      return undefined;
    }
    const result = { data: bytes.toString("base64"), mimeType: finalMime, name: meta.contentName };
    if (key) {
      this.attachmentCache.set(key, result);
      if (this.attachmentCache.size > ChatClient.ATTACHMENT_CACHE_MAX) {
        const oldest = this.attachmentCache.keys().next().value;
        if (oldest) this.attachmentCache.delete(oldest);
      }
    }
    return result;
  }

  /**
   * Fallback when the event carried no usable attachment metadata: fetch the
   * Message resource (`messages.get`, app auth) and return its attachments.
   * Returns [] on any failure so the caller can proceed text-only.
   */
  async fetchMessageAttachments(messageName: string): Promise<ChatAttachment[]> {
    try {
      const data = (await this.auth.request("GET", `${CHAT_API_BASE}/${messageName}`, undefined, 15_000)) as {
        attachment?: ChatAttachment[];
        attachments?: ChatAttachment[];
      };
      // Google's Message resource uses `attachment` (SINGULAR) — handle both.
      return data.attachment ?? data.attachments ?? [];
    } catch (err) {
      console.warn("[chat] messages.get failed:", (err as Error).message);
      return [];
    }
  }

  /**
   * Post a new message; returns the created message's resource name.
   *
   * Messages are created with `markupSyntax: MARKUP_SYNTAX_MARKDOWN` (GA Aug 7,
   * 2026) so pi's Markdown output — bold, italic, code, bulleted/numbered
   * lists, block quotes, links — renders properly instead of being parsed as
   * legacy Chat `*bold*` syntax. Tables are NOT in the supported Markdown
   * subset.
   *
   * NOTE (verified Aug 2026): `markupSyntax` is create-only — any PATCH that
   * updates `text` resets the message to legacy CHAT syntax (and `markupSyntax`
   * is not a valid `updateMask` path). That's why the streaming placeholder is
   * replaced with a fresh MARKDOWN message when done.
   *
   * `opts.silent` sends the message without a push notification and without
   * marking the space unread (app auth, GA since May 8, 2026). NOTE (verified
   * Aug 2026): silent 403s when combined with the `messageReplyOption` query
   * param, and posting to a thread via the body alone is ignored (new thread)
   * — so silent is only usable for top-level (non-threaded) messages.
   */
  async createMessage(
    spaceName: string,
    text: string,
    threadName?: string,
    opts?: { silent?: boolean },
  ): Promise<string> {
    const body: Record<string, unknown> = {
      text,
      markupSyntax: MARKUP_SYNTAX_MARKDOWN,
    };
    if (threadName) body.thread = { name: threadName };
    const query = new URLSearchParams();
    if (threadName) query.set("messageReplyOption", "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD");
    if (opts?.silent) query.set("createMessageNotificationOptions.notificationType", NOTIFICATION_TYPE_SILENT);
    const qs = query.toString();
    const data = (await this.auth.request(
      "POST",
      `${CHAT_API_BASE}/${spaceName}/messages${qs ? `?${qs}` : ""}`,
      JSON.stringify(body),
    )) as { name?: string };
    if (!data.name) throw new Error("createMessage: response missing message name");
    return data.name;
  }

  /** Post a card message (cardsV2); returns the created message's resource name. */
  async createCardMessage(
    spaceName: string,
    cardsV2: unknown[],
    fallbackText: string,
    threadName?: string,
  ): Promise<string> {
    const body = threadName
      ? { cardsV2, fallbackText, thread: { name: threadName } }
      : { cardsV2, fallbackText };
    const url = threadName
      ? `${CHAT_API_BASE}/${spaceName}/messages?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`
      : `${CHAT_API_BASE}/${spaceName}/messages`;
    const data = (await this.auth.request("POST", url, JSON.stringify(body))) as { name?: string };
    if (!data.name) throw new Error("createCardMessage: response missing message name");
    return data.name;
  }

  /**
   * Replace the cards of an existing bot message (used to update pickers).
   * NOTE (verified Aug 2026): only `cardsV2` is a valid `updateMask` path —
   * including `fallbackText` makes the whole PATCH fail with 400
   * ("Unsupported path name in message field mask"). The body still carries
   * `fallbackText` (ignored).
   */
  async updateMessageCards(messageName: string, cardsV2: unknown[], fallbackText: string): Promise<void> {
    await this.auth.request(
      "PATCH",
      `${CHAT_API_BASE}/${messageName}?updateMask=cardsV2`,
      JSON.stringify({ cardsV2, fallbackText }),
    );
  }

  /** Replace the text of an existing bot message (used for streaming replies). */
  async updateMessage(messageName: string, text: string): Promise<void> {
    await this.auth.request(
      "PATCH",
      `${CHAT_API_BASE}/${messageName}?updateMask=text`,
      JSON.stringify({ text }),
    );
  }

  /** Delete a bot message (used to remove the streaming placeholder). */
  async deleteMessage(messageName: string): Promise<void> {
    await this.auth.request("DELETE", `${CHAT_API_BASE}/${messageName}`);
  }

  /** Convenience wrapper: create + forget the name. */
  async sendMessage(spaceName: string, text: string, threadName?: string, opts?: { silent?: boolean }): Promise<void> {
    await this.createMessage(spaceName, text, threadName, opts);
  }

  /**
   * Show/clear the typing indicator for a space (bot identity).
   *
   * POST https://chat.googleapis.com/v1/{parent=users/app/spaces/*}:setTypingIndicator
   *
   * - "TYPING" starts the standard typing animation
   * - "THINKING" starts the AI thinking animation (good for agent work)
   * - "NONE" / "ACTIVITY_STOPPED" terminates the indicator immediately
   *
   * `threadName` scopes the indicator to a thread when given; `text` shows a
   * custom status label next to the indicator.
   *
   * NOTE (verified Aug 2026): Google's backend is NOT serving this method yet.
   * The endpoint accepts the schema (unknown fields -> 400) but every valid
   * request returns 404 "Method not found" on both `users/app/spaces/*` and
   * `spaces/*` paths. Kept here, ready to wire up, for when Google ships it.
   */
  async setTypingIndicator(
    spaceName: string,
    setting: "TYPING" | "THINKING" | "ACTIVITY" | "NONE" | "ACTIVITY_STOPPED",
    threadName?: string,
    text?: string,
  ): Promise<void> {
    const body: Record<string, unknown> = { typingIndicatorSetting: setting };
    if (threadName) body.thread = { name: threadName };
    if (text) body.typingIndicatorText = text;
    await this.auth.request(
      "POST",
      `${CHAT_API_BASE}/${spaceName}:setTypingIndicator`,
      JSON.stringify(body),
    );
  }
}
