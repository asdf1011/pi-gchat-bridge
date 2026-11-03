/**
 * Delivery: getting a stored value into a child process without the model seeing it.
 *
 * The store and the card were two halves of a mechanism with nothing in the
 * middle: `/secret set` kept a value out of the conversation, but nothing could
 * *use* it — commands got their environment from `.env.durable`, so a captured
 * secret was only ever a redaction word. This is the middle.
 *
 * The mechanism is a bash `prepare` hook (`BashToolOptions.prepare`), which pi-durable
 * calls before every `bash` command with the pending `{ command, cwd, env }`. Two
 * rules make it safe:
 *
 *   1. **Mention-gated.** Only names the command actually mentions as whole words
 *      get injected. `curl -H "Authorization: Bearer $BRAVE_API_KEY"` gets the
 *      value; `env` or `printenv` gets nothing, so the agent cannot enumerate the
 *      store by dumping its environment. (This is prjct.app's "injection by
 *      mention", and it is the difference between a store and a leak.)
 *   2. **Values never enter a tool result.** The value is placed in the child's
 *      environment only. Whatever the command prints is then scrubbed by the
 *      redaction extension, which holds the same values — so `echo $NAME` still
 *      yields `[secret:NAME]`.
 *
 * What this is NOT: protection from `bash` itself. A command that mentions a
 * name can do anything with it, including `curl` it to an attacker. That is the
 * documented threat model (accident, not attacker) and the reason a real
 * boundary needs an egress proxy rather than a nicer store.
 */
import type { RegisteredSecret } from "./redact.js";
import { logger } from "../../logger.js";

/** A value the delivery layer may inject, and the project scopes allowed to use it. */
export interface DeliverableSecret {
  readonly name: string;
  readonly value: string;
  /**
   * Conversations this secret is scoped to. Absent or empty means every
   * conversation on this bridge; a non-empty list restricts it.
   *
   * Matched against the *conversation id*, not the Chat key: the bash `prepare`
   * hook receives `api.conversationId` and nothing about threads, and inventing
   * a lookup from one to the other inside a tool call would be a second source
   * of truth. `/secret set` records the conversation id it was captured in.
   */
  readonly scopes?: readonly string[];
}

/**
 * A name is mentioned when it appears as a whole word.
 *
 * `\b` is wrong at the edges: `$NAME` starts after `$`, which is a non-word
 * character, but a name embedded in `FOO_NAME_BAR` must not match `NAME`. JS
 * lookarounds give exactly that: not preceded or followed by an identifier
 * character. Underscores count as identifier characters on purpose — `$MY_KEY`
 * and `NAME_2` are different variables from `KEY` and `NAME`.
 */
export function mentions(command: string, name: string): boolean {
  if (!name) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`).test(command);
}

/**
 * Which secrets a command may receive.
 *
 * Fail-closed on scope: a secret scoped to another conversation is not injected,
 * and no error is raised — the command simply runs without it and the agent can
 * see the variable is unset. That is better than a message that enumerates what
 * exists elsewhere.
 */
export function selectForCommand(
  command: string,
  secrets: readonly DeliverableSecret[],
  conversationId: string | number | undefined,
): DeliverableSecret[] {
  const scope = conversationId === undefined ? undefined : String(conversationId);
  return secrets.filter((secret) => {
    if (!mentions(command, secret.name)) return false;
    if (!secret.scopes || secret.scopes.length === 0) return true;
    // Unscoped context cannot satisfy a scoped secret: fail closed.
    return scope !== undefined && secret.scopes.includes(scope);
  });
}

/**
 * The environment additions for one command.
 *
 * Exported separately from the hook so it can be tested without a harness, a
 * shell, or a real secret.
 */
export function envForCommand(
  command: string,
  secrets: readonly DeliverableSecret[],
  conversationId: string | number | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const secret of selectForCommand(command, secrets, conversationId)) {
    env[secret.name] = secret.value;
  }
  return env;
}

/**
 * True when the command mentions any stored name at all.
 *
 * Used only for the log line: "delivered 2 of 5 to this command" is the kind of
 * fact that explains a failing `curl` without printing a value.
 */
export function countMentions(command: string, secrets: readonly DeliverableSecret[]): number {
  return secrets.filter((secret) => mentions(command, secret.name)).length;
}

export interface DeliveryOptions {
  /** The values that may be delivered, resolved per call so a new capture applies. */
  secrets: () => readonly DeliverableSecret[];
}

/**
 * The `prepare` hook for the bash tool.
 *
 * Merges into the environment the tool already built rather than replacing it:
 * `execution.env` holds per-call additions and `inheritEnv` decides whether the
 * process environment is included, so overwriting either would break commands
 * that rely on `PATH` or on the session variables pi injects.
 */
export function makePrepare(options: DeliveryOptions) {
  return (
    execution: { command: string; env: Record<string, string> },
    // pi-durable's ToolExecutionApi. Structural, so this module stays testable
    // without a harness: only the conversation id is read.
    api?: { conversationId?: string | number },
  ): void => {
    const secrets = options.secrets();
    if (secrets.length === 0) return;

    const delivered = envForCommand(execution.command, secrets, api?.conversationId);
    const names = Object.keys(delivered);
    if (names.length === 0) return;

    Object.assign(execution.env, delivered);
    // Names and counts only. A value must never reach a log line, and that
    // includes the debug ones nobody reads until something breaks.
    logger.info(`[delivery] injected ${names.length} secret(s): ${names.join(", ")}`);
  };
}

/** Values for the redaction registry, from the same source delivery uses. */
export function toRegistered(secrets: readonly DeliverableSecret[]): RegisteredSecret[] {
  return secrets.map((secret) => ({ name: secret.name, value: secret.value }));
}
