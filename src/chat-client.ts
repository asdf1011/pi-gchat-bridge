import { ServiceAccountAuth } from "./auth.js";

import type { IncomingMessage } from "./types.js";

const CHAT_BOT_SCOPE = "https://www.googleapis.com/auth/chat.bot";
const CHAT_API_BASE = "https://chat.googleapis.com/v1";
/** Hard cap for a single Chat text message (API limit is 4096). */
export const MAX_MESSAGE_CHARS = 4000;

/**
 * Thin wrapper around the Google Chat REST API, authenticated as the Chat
 * app's service account (bot identity).
 */
export class ChatClient {
  private auth: ServiceAccountAuth;

  constructor(serviceAccountPath: string) {
    this.auth = new ServiceAccountAuth(serviceAccountPath, [CHAT_BOT_SCOPE]);
  }

  /** Post a new message; returns the created message's resource name. */
  async createMessage(spaceName: string, text: string, threadName?: string): Promise<string> {
    const body = threadName ? { text, thread: { name: threadName } } : { text };
    const url = threadName
      ? `${CHAT_API_BASE}/${spaceName}/messages?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`
      : `${CHAT_API_BASE}/${spaceName}/messages`;
    const data = (await this.auth.request("POST", url, JSON.stringify(body))) as { name?: string };
    if (!data.name) throw new Error("createMessage: response missing message name");
    return data.name;
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
  async sendMessage(spaceName: string, text: string, threadName?: string): Promise<void> {
    await this.createMessage(spaceName, text, threadName);
  }
}
