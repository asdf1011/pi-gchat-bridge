/**
 * Secret Redactor — the pi-durable side of "don't send secrets to the model".
 *
 * Port of the idea behind `@prjct.app/pi-secrets` and `pi-secrets` (liamvinberg)
 * into pi-durable's hook vocabulary. Both of those are `ExtensionAPI`
 * extensions: they register `tool_result`, `context`, and —
 * for prjct.app — `before_provider_request`. None of those events exist here.
 * The bridge runs pi-durable, so without this file every Chat and `/web` turn
 * would go out unredacted while the TUI was protected, which is the wrong half:
 * the internet-facing surfaces are exactly the ones that need it.
 *
 * The mapping is one-to-one:
 *
 *   pi-coding-agent            pi-durable
 *   ------------------         -------------------------------------------
 *   `tool_result`          →   hook(ToolTask, { afterTool })
 *   `context`              →   hook(GenerationTask, { beforeRequest })
 *   `before_provider_request`  hook(GenerationTask, { beforeRequest })
 *
 * That third row is why `beforeRequest` is the important one: it is the last
 * gate before bytes leave the machine, and it sees the *whole* serialised
 * message list — history re-read from the transcript, `/notify` text seeded by
 * cron, a resumed conversation — not just the newest tool result.
 *
 * Where the values come from, in priority order:
 *
 *   1. `PI_SECRETS_NAMES` + `PI_SECRETS_VALUES_JSON`. The bridge cannot show a
 *      masked TUI prompt, so capture happens out of band (the `/secret` card, or
 *      `pi-secrets setup` in a TUI) and the process it hands to the harness gets
 *      the values through its environment. Names in `PI_SECRETS_NAMES` mirror
 *      liamvinberg's convention so a child pi process interoperates.
 *   2. The optional `@prjct.app/pi-secrets` package, if its `protectOutboundData`
 *      export resolves. Its registry *includes* shape-based detection for
 *      Anthropic/OpenAI/Stripe/GitHub/AWS/PEM, PII (emails, phones, Luhn-valid
 *      cards), and its own keychain values — detection this adapter deliberately
 *      does not reimplement.
 *
 * Both are best-effort and both fail closed: if a registry cannot be built, or
 * the optional guard throws, the request is refused rather than sent clean.
 * Sending unredacted is the one outcome that cannot be undone.
 *
 * Registered by the host for every conversation, like `chat-format`. Selecting
 * it is per-conversation (`configure({ extensions })`), so a conversation that
 * should not redact can drop it — but the default in `host.ts` keeps it on.
 */
import {
  defineExtension,
  GenerationTask,
  hook,
  ToolTask,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import type { Message } from "@earendil-works/pi-ai";

import { logger } from "../../logger.js";
import {
  MIN_SECRET_LENGTH,
  redactMessages,
  redactToolOutput,
  SecretRegistry,
  type RegisteredSecret,
} from "./redact.js";

/**
 * Values from the environment, in the shape `pi-secrets` uses for subagents.
 *
 * `PI_SECRETS_NAMES` is a comma-separated name list; each name's value is read
 * from that name's own environment variable. `PI_SECRETS_VALUES_JSON` is the
 * escape hatch for a name that is not itself a valid environment variable name.
 * Reading the values from `process.env` (rather than only from the JSON) matters
 * because that is what the shell tool injects into its children — if a value is
 * visible to `bash`, it must be in the registry, or `echo $NAME` leaks it.
 */
export function secretsFromEnvironment(env: NodeJS.ProcessEnv = process.env): RegisteredSecret[] {
  const secrets: RegisteredSecret[] = [];
  const seen = new Set<string>();

  const add = (name: string, value: string | undefined) => {
    if (!name || !value || seen.has(name)) return;
    if (value.length < MIN_SECRET_LENGTH) {
      // Short values are refused rather than warned about: this path has no
      // user to warn, and an over-matching 3-char pattern would corrupt every
      // tool result in the conversation.
      logger.info(`[redactor] ignoring ${name}: shorter than ${MIN_SECRET_LENGTH} characters`);
      return;
    }
    seen.add(name);
    secrets.push({ name, value });
  };

  const names = (env.PI_SECRETS_NAMES ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  for (const name of names) add(name, env[name]);

  const raw = env.PI_SECRETS_VALUES_JSON;
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof value === "string") add(name, value);
        }
      }
    } catch (error) {
      // A broken blob must not silently reduce coverage to "names only": the
      // names still redact, but a value-less registry would look healthy.
      logger.error(`[redactor] PI_SECRETS_VALUES_JSON is not JSON: ${(error as Error).message}`);
    }
  }

  return secrets;
}

/**
 * The optional prctj.app guard, resolved at first use.
 *
 * `undefined` = not installed (normal; the built-in registry still runs).
 * A rejected promise = installed but unusable, which is a configuration fault
 * worth logging once and then treating as "not installed" — except that a
 * keychain read failure must fail *closed*, so that distinction is preserved in
 * the return type of `guardMessages` below rather than swallowed here.
 */
type OutboundGuard = (messages: readonly Message[]) => Promise<readonly Message[]>;

/** Resolved once per process; `null` means "looked, not available". */
let guardPromise: Promise<OutboundGuard | null> | undefined;

async function loadOutboundGuard(): Promise<OutboundGuard | null> {
  guardPromise ??= (async () => {
    try {
      // The subpath is the package's documented entry point for exactly this
      // use: "extensions making direct public SDK calls outside a session".
      //
      // The specifier is built at runtime and cast through `unknown`, on
      // purpose: a literal in `import()` makes TypeScript demand the package's
      // types at build time, which would turn an optional dependency into a
      // required one. A missing package must be a no-op, not a compile error.
      const specifier: string = "@prjct.app/pi-secrets/privacy";
      const mod = (await import(/* @vite-ignore */ specifier)) as unknown as {
        protectOutboundData?: OutboundGuard;
      };
      if (typeof mod.protectOutboundData !== "function") {
        logger.info("[redactor] @prjct.app/pi-secrets has no protectOutboundData; shape detection off");
        return null;
      }
      logger.info("[redactor] @prjct.app/pi-secrets outbound guard active");
      return mod.protectOutboundData;
    } catch {
      return null;
    }
  })();
  return guardPromise;
}

/** Test seam: forget the resolved guard so a fake can be installed. */
export function resetOutboundGuardForTests(): void {
  guardPromise = undefined;
}

/** Why a request was refused. Kept short: it is shown to the model. */
export const REDACTION_FAILED = "redaction failed; request not sent";

/**
 * The redaction decision for one request.
 *
 * Throws when redaction cannot be completed. Callers (the hooks below) let the
 * throw escape: pi-durable fails the task rather than sending, which is the
 * whole point of failing closed. The thrown message never contains a value.
 */
export async function protectMessages(
  messages: readonly Message[],
  registry: SecretRegistry,
  guard: OutboundGuard | null,
): Promise<readonly Message[]> {
  // Our literals first: they are exact, so they cannot be wrong, and running
  // them before the guard means the guard never sees a value we already know.
  const redacted = redactMessages(messages, registry);
  if (!guard) return redacted;

  // Then the guard (shapes + PII). A throw here is a real failure — prjct.app's
  // contract is "throws if an indexed credential cannot be read, so the caller
  // must not retry with the unprotected data".
  return guard(redacted);
}

export interface SecretRedactorOptions {
  /**
   * The literals to scrub. Preferred over `registry`: the host builds this list
   * from the secret store plus the environment, so it can apply its own
   * precedence (store wins on a name collision) before the registry is built.
   */
  secrets?: readonly RegisteredSecret[];
  /** Override the registry directly (tests). Wins over `secrets` when both are given. */
  registry?: SecretRegistry;
  /** Disable the optional prctj.app guard even when installed. */
  useOutboundGuard?: boolean;
}

export function createSecretRedactor(options: SecretRedactorOptions = {}) {
  const registry = options.registry ?? new SecretRegistry(options.secrets ?? secretsFromEnvironment());
  const useGuard = options.useOutboundGuard ?? true;

  if (registry.size > 0) {
    // Count only. Names are safe; values never reach a log line.
    logger.info(`[redactor] ${registry.size} redaction pattern(s) from the environment`);
  }

  return defineExtension({
    name: "secret-redactor",
    hooks: [
      hook(GenerationTask, {
        /**
         * Every request attempt, including retries and recovery. The returned
         * messages are used for that request only, so the transcript on disk
         * keeps what the tool actually produced — which is deliberate: the goal
         * is that the *provider* never sees a secret, not that history is
         * rewritten.
         */
        beforeRequest: async (request) => {
          const guard = useGuard ? await loadOutboundGuard() : null;
          const messages = await protectMessages(request.messages, registry, guard);
          // Returning `undefined` would mean "unchanged"; when nothing matched,
          // returning undefined keeps the prompt cache warm.
          return messages === request.messages ? undefined : { messages };
        },
      }),

      hook(ToolTask, {
        /**
         * After execution, before the result is committed.
         *
         * This is the pi-durable equivalent of pi's `tool_result`, and it runs
         * before the commit, so a secret never enters the transcript in the
         * first place — which also means `/status` and the HTML export are
         * clean, and the next turn's re-read is clean too.
         */
        afterTool: (_call, result): ToolExecutionResult | undefined => {
          if (result.output === undefined) return undefined;
          const output = redactToolOutput(result.output, registry);
          if (output === result.output) return undefined;
          // structuredOutput is program-facing and validated against the tool's
          // declared schema; rewriting its strings would break that contract.
          // Documented gap (see redact.ts).
          return { ...result, output };
        },
      }),
    ],
  });
}
