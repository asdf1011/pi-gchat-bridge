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
  /** Pub/Sub publish id — unique per event; used to dedupe card clicks. */
  messageId?: string;
  text?: string;
  senderName?: string;
  /** "HUMAN" or "BOT" */
  senderType?: "HUMAN" | "BOT" | string;
  createTime?: string;
  /** e.g. "spaces/AAAA/threads/CCCC" — replies go back into this thread */
  threadName?: string;
}

/** FormAction payload carried by CARD_CLICKED interaction events. */
export interface ChatAction {
  actionMethodName?: string;
  parameters?: { key: string; value: string }[];
  /** Widget input values keyed by the selectionInput `name` field. */
  formInputs?: Record<string, { input?: { stringInputs?: { value?: string[] } } }>;
}

/** A user message that the bridge should hand to pi. */
export interface IncomingMessage {
  space: ChatSpace;
  message: ChatMessage;
  /** Present for CARD_CLICKED interaction events. */
  action?: ChatAction;
  /** Raw Chat event type: "MESSAGE" | "CARD_CLICKED" | ... */
  eventType?: string;
}
