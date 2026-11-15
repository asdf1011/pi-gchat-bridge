import type { IncomingMessage } from "./types.js";

/**
 * Result of handling one incoming message.
 *
 * One value, because there is one outcome that means "this message is accounted for". A `"busy"`
 * return used to say "leave it unacked and let Pub/Sub redeliver", from a time when the bridge owned
 * the turn and could be too busy to take it: the durable engine always accepts (a message joins the
 * running turn rather than queueing behind it), so nothing produced it and the branch that handled it
 * was unreachable. A handler that instead *throws* still means "not accounted for", and the receiver
 * leaves that one unacked — which is the one case that is real.
 */
export type HandleResult = "ok";

/**
 * A source of incoming Chat messages. The bridge is agnostic to HOW messages
 * arrive: the Pub/Sub pull receiver is the only implementation.
 */
export interface MessageReceiver {
  readonly name: string;
  /** Start delivering messages to `handler`. Resolves once started. */
  start(handler: (message: IncomingMessage) => Promise<HandleResult>): Promise<void>;
  stop(): Promise<void>;
}

