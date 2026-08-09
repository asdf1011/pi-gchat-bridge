import type { IncomingMessage } from "./types.js";

/** Result of handling one incoming message. */
export type HandleResult = "ok" | "busy";

/**
 * A source of incoming Chat messages. The bridge is agnostic to HOW messages
 * arrive: the Pub/Sub pull receiver is the only implementation. Returning
 * "busy" from the handler leaves the message unacked so it is redelivered
 * (and retried) later.
 */
export interface MessageReceiver {
  readonly name: string;
  /** Start delivering messages to `handler`. Resolves once started. */
  start(handler: (message: IncomingMessage) => Promise<HandleResult>): Promise<void>;
  stop(): Promise<void>;
}
