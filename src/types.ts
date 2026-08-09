/**
 * Shared types for the Google Chat <-> pi bridge.
 */

export type ChatSpaceType = "ROOM" | "DIRECT_MESSAGE" | "GROUP_CHAT";

export interface ChatSpace {
  /** e.g. "spaces/AAAA..." */
  name: string;
  displayName?: string;
  type?: ChatSpaceType;
}

export interface ChatMessage {
  /** e.g. "spaces/AAAA/messages/BBBB" */
  name: string;
  text?: string;
  senderName?: string;
  /** "HUMAN" or "BOT" */
  senderType?: "HUMAN" | "BOT" | string;
  createTime?: string;
  /** e.g. "spaces/AAAA/threads/CCCC" — replies go back into this thread */
  threadName?: string;
}

/** A user message that the bridge should hand to pi. */
export interface IncomingMessage {
  space: ChatSpace;
  message: ChatMessage;
}
