/**
 * Shared types for the Google Chat <-> pi bridge.
 */

export type ChatSpaceType = "ROOM" | "DIRECT_MESSAGE" | "GROUP_CHAT";

/** Attachment metadata from a Chat event (images pasted/uploaded by the user). */
export interface ChatAttachment {
  /** e.g. "spaces/AAAA/messages/BBBB/attachments/CCCC" */
  name?: string;
  contentName?: string;
  /** e.g. "image/png" */
  contentType?: string;
  /** Authenticated download URL (requires the same auth scope as the message). */
  contentUri?: string;
  /** "DRIVE_FILE" | "UPLOADED_CONTENT" | ... */
  source?: string;
  /** Media-API download reference (fallback when `contentUri` is absent). */
  attachmentDataRef?: { resourceName?: string; attachmentUploadToken?: string };
}

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
  /** App-chosen thread identifier (set when the app creates the thread).
   *  Stable, stored by Google on the thread, and echoed back in events — used
   *  as the session key so the conversation identity is decoupled from the
   *  server-generated thread name. */
  threadKey?: string;
  /** Image attachments carried by the event (past/uploaded by the sender). */
  attachments?: ChatAttachment[];
  /**
   * Google's Message resource returns attachments under `attachment` (SINGULAR)
   * — a legacy quirk of the REST API — while some event payloads use
   * `attachments` (plural). Normalized to `attachments` by the receiver;
   * this field exists to model the raw API response.
   */
  attachment?: ChatAttachment[];
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
