/**
 * Outbound redaction: the pure half.
 *
 * `secret-redactor.ts` is the pi-durable extension; this file is the part worth
 * testing without a harness, a model, or a keychain. Two jobs:
 *
 *   1. `SecretRegistry` — the set of literal values that must never reach the
 *      model, plus the marker each one is replaced with.
 *   2. `redactValue` / `redactMessage` — apply the registry to a pi-ai message
 *      or a tool result, returning new objects rather than mutating.
 *
 * Why the variants matter: a secret that is copy-pasted into JSON, a URL, or a
 * base64 blob is the same secret. Exact matching alone misses all three, which
 * is the most common way a "redacted" transcript still hands the key to the
 * provider. The variant list is deliberately the same shape prjct.app's package
 * describes (as-typed, JSON-escaped, URL-encoded, base64 standard/unpadded/
 * URL-safe) so the two agree when both are in play.
 *
 * What is deliberately NOT here:
 *   - shape-based regexes for tokens pi-secrets already knows (Anthropic,
 *     OpenAI, Stripe, GitHub, AWS, PEM). Duplicating a pattern set that someone
 *     else maintains is how the two drift apart. If `@prjct.app/pi-secrets` is
 *     installed, its `protectOutboundData()` runs in the same hook and covers
 *     them; this adapter only supplies the part pi-durable was missing: the
 *     per-request transcript and tool-output hooks.
 *   - a generic high-entropy heuristic. It false-positives on hashes, bundle
 *     names, and base64 images, and a redaction layer that cries wolf gets
 *     turned off. Add it only against real output, if ever.
 */

/** One registered secret: the name the model sees, and the literal value. */
export interface RegisteredSecret {
  /** Environment-variable-style name; also the marker's payload. */
  readonly name: string;
  /** The real value, as typed. Never logged, never returned to the model. */
  readonly value: string;
}

/** Marker format. Distinctive enough not to collide with prose. */
export const marker = (name: string): string => `[secret:${name}]`;

/**
 * Values shorter than this are refused: a 3-character "secret" would redact
 * every occurrence of those characters in normal text, which corrupts output
 * without protecting anything. Same threshold pi-secrets uses.
 */
export const MIN_SECRET_LENGTH = 4;

/** base64 of a string, in the three alphabets a copy-paste might produce. */
function base64Variants(value: string): string[] {
  const std = Buffer.from(value, "utf8").toString("base64");
  return [
    std,
    std.replace(/=+$/, ""),
    std.replace(/\+/g, "-").replace(/\//g, "_"),
    std.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  ];
}

/**
 * Every textual form a value can take in the places secrets actually leak.
 *
 * Ordered longest-first by the caller, not here: replacing `abc` before
 * `abcdef` would leave `[secret:X]def`, so the registry sorts its patterns.
 */
export function variantsOf(value: string): string[] {
  const variants = new Set<string>([value]);

  // JSON string escaping: quotes, backslashes, and control characters.
  try {
    const quoted = JSON.stringify(value);
    if (quoted.length >= 2) variants.add(quoted.slice(1, -1));
  } catch {
    // A string with a lone surrogate cannot be JSON-escaped; the raw form stands.
  }

  // URL encoding: every character encoded, which is what a `curl --data-urlencode`
  // or a query string produces.
  try {
    variants.add(encodeURIComponent(value));
  } catch {
    // Lone surrogates again; nothing to add.
  }

  for (const encoded of base64Variants(value)) variants.add(encoded);

  // The short variants are noise: a 4-char secret encodes to 8 base64 chars,
  // which is unlikely to appear by accident, but a repeated character (`aaaa`)
  // encodes to a run of `YWFh` that would match inside unrelated base64. Keep
  // them anyway — over-redaction is safe, under-redaction is not.
  return [...variants].filter((variant) => variant.length >= MIN_SECRET_LENGTH);
}

/**
 * The set of literals to scrub, and what to scrub them to.
 *
 * Construct once per conversation lifetime and reuse: building it per request
 * would re-sort on every turn for no gain, and the pi-durable `beforeRequest`
 * hook runs on every retry too.
 */
export class SecretRegistry {
  /** Longest first, so a value that contains another is replaced whole. */
  private readonly patterns: readonly { readonly needle: string; readonly replacement: string }[];

  constructor(secrets: readonly RegisteredSecret[]) {
    const entries: { needle: string; replacement: string }[] = [];
    for (const secret of secrets) {
      if (secret.value.length < MIN_SECRET_LENGTH) continue;
      for (const variant of variantsOf(secret.value)) {
        entries.push({ needle: variant, replacement: marker(secret.name) });
      }
    }
    // A later duplicate literal (two names registered with the same value) keeps
    // the first name, deterministically: the sort is stable and input order is
    // the caller's.
    entries.sort((a, b) => b.needle.length - a.needle.length);
    this.patterns = entries;
  }

  /** Names currently registered, for `/secret list` and diagnostics. Never values. */
  get size(): number {
    return this.patterns.length;
  }

  /** Replace every registered literal in `text`. */
  redact(text: string): string {
    let out = text;
    for (const { needle, replacement } of this.patterns) {
      if (out.includes(needle)) out = out.split(needle).join(replacement);
    }
    return out;
  }

  /** True when `text` contains any registered literal — for a hit counter, never for logging the value. */
  matches(text: string): boolean {
    return this.patterns.some(({ needle }) => text.includes(needle));
  }
}

/** A pi-ai content block we can redact. Images and thinking are passed through. */
type Block = { readonly type?: string; readonly text?: string; readonly [key: string]: unknown };
/**
 * Redact one content block or block array.
 *
 * Only `text` is touched. An image block's `data` is base64 by definition, so
 * running the base64 variants against it would either miss (the image is not
 * the secret) or, worse, corrupt it. Thinking blocks carry provider-replay
 * signatures and must round-trip byte-exact.
 */
export function redactContent<T>(content: T, registry: SecretRegistry): T {
  if (typeof content === "string") return registry.redact(content) as unknown as T;
  if (!Array.isArray(content)) return content;

  let changed = false;
  const next = content.map((block: Block) => {
    if (!block || typeof block !== "object" || block.type !== "text" || typeof block.text !== "string") {
      return block;
    }
    const redacted = registry.redact(block.text);
    if (redacted === block.text) return block;
    changed = true;
    return { ...block, text: redacted };
  });
  return (changed ? next : content) as unknown as T;
}

/** The shape of the pi-ai messages `beforeRequest` hands us. Structural on purpose. */
export interface RedactableMessage {
  readonly role?: string;
  readonly content?: unknown;
  readonly [key: string]: unknown;
}

/**
 * Redact a whole message list, returning the original array when nothing matched.
 *
 * Generic over the caller's own message type rather than the structural
 * `RedactableMessage`, because pi-ai's `Message` union has no string index
 * signature and would not satisfy it. The constraint is applied through a cast
 * at the single point where we rebuild a message, so the caller keeps its exact
 * type (`Message[]` in, `Message[]` out).
 *
 * Returning the input unchanged when clean is not an optimisation: pi-durable
 * compares the `beforeRequest` result and a new array on every turn would look
 * like a change worth re-serialising, which is exactly the sort of thing that
 * quietly invalidates a provider's prompt cache.
 */
export function redactMessages<T>(messages: readonly T[], registry: SecretRegistry): readonly T[] {
  let changed = false;
  const next = messages.map((message) => {
    if (!message || typeof message !== "object") return message;
    const candidate = message as RedactableMessage;
    const redacted = redactContent(candidate.content, registry);
    if (redacted === candidate.content) return message;
    changed = true;
    return { ...candidate, content: redacted } as T;
  });
  return changed ? next : messages;
}

/**
 * Redact a tool result's model-facing output.
 *
 * pi-durable models this as `ToolExecutionResult.output` (pi-ai content); the
 * `structuredOutput` field is program-facing and is deliberately left alone,
 * because rewriting a JSON value's strings would break a tool's declared schema.
 * That is a real (documented) gap: a secret returned *through* structuredOutput
 * to a codemode script is not scrubbed here. It never reaches the transcript
 * that way, but it does reach the script.
 */
export function redactToolOutput<T>(output: T, registry: SecretRegistry): T {
  return redactContent(output, registry);
}
