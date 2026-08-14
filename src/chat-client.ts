import { ServiceAccountAuth } from "./auth.js";

import type { IncomingMessage } from "./types.js";

const CHAT_BOT_SCOPE = "https://www.googleapis.com/auth/chat.bot";
const CHAT_API_BASE = "https://chat.googleapis.com/v1";
/** Hard cap for a single Chat text message (API limit is 4096). */
export const MAX_MESSAGE_CHARS = 4000;
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

  constructor(serviceAccountPath: string) {
    this.auth = new ServiceAccountAuth(serviceAccountPath, [CHAT_BOT_SCOPE]);
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
   * marking the space unread (app auth, GA since May 8, 2026) — used only for
   * the overflow chunks of long replies so they don't re-notify.
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

  /** Replace the cards of an existing bot message (used to update pickers). */
  async updateMessageCards(messageName: string, cardsV2: unknown[], fallbackText: string): Promise<void> {
    await this.auth.request(
      "PATCH",
      `${CHAT_API_BASE}/${messageName}?updateMask=cardsV2,fallbackText`,
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
