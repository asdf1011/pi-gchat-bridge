/**
 * The last provider failure the bridge saw, per provider.
 *
 * Written for the same reason `origins-doc` exists: something has to be
 * answerable by a reader that was not there when it happened. A turn that dies
 * on a 402 is invisible from outside — the bridge stays up, `/healthz` says `ok`,
 * and the only trace is a log line nobody is watching at 4am. The restart gate
 * asks "is a turn running?", which is a different question from "is the model
 * working at all", and a bridge that keeps accepting work while every turn fails
 * in 1.5s is up by its own reckoning and useless by any other.
 *
 * So the failure is recorded the moment it is classified, and read by `/status`
 * (and by whatever a surface wants to show). Keyed by provider rather than by
 * conversation: the balance is an account fact, and the same 402 is why every
 * conversation on that provider is failing — reporting it per conversation would
 * list the same problem N times.
 *
 * Session-scoped and capped, like the origins doc. This is operational state, not
 * history: a failure older than the provider's most recent success is stale by
 * definition, and the success path clears it.
 */
import { defineDoc } from "@earendil-works/pi-durable";

/** One provider's most recent failure. */
export type ProviderFailure = {
  /** Provider that refused the call, as `models.json` names it. */
  provider: string;
  /** What kind of refusal it was. A plain string rather than the `ModelFailure`
   *  union so the document type stays JSON-shaped, which is what the doc store
   *  requires of its value. */
  kind: string;
  /** The action that resolves it (`top_up`, `fix_config`, `retry_later`, `compact`, `retry`). */
  action: string;
  /** The provider's own words, shortened. */
  summary: string;
  /** True when retrying unchanged is expected to fail the same way. */
  persistent: boolean;
  /** Epoch ms of the failure. */
  at: number;
  /** Conversation whose turn died, when it is known. */
  conversationId?: number;
  /** The raw engine reason (`model_error`), kept for log parity. */
  reason: string;
};

export type ModelFailuresValue = {
  /** Provider name → its most recent failure. */
  byProvider: Record<string, ProviderFailure>;
};

/**
 * How many providers to keep. This is bounded by the number of providers a
 * deployment configures (a handful), so the cap only exists to keep a
 * misconfigured `models.json` from growing the document without limit.
 */
export const MAX_PROVIDER_FAILURES = 32;

export const ModelFailuresDoc = defineDoc<ModelFailuresValue>({
  kind: "gchat.model-failures",
  version: 1,
  scope: "session",
  initial: () => ({ byProvider: {} }),
  checkpointWhen: () => true,
});

/**
 * Record one failure, keeping the document bounded.
 *
 * Returns a new value rather than mutating: this is written inside a
 * transaction, and a rejected write must leave nothing half-recorded behind.
 */
export function withProviderFailure(
  value: ModelFailuresValue | undefined,
  failure: ProviderFailure,
): ModelFailuresValue {
  const byProvider: Record<string, ProviderFailure> = { ...(value?.byProvider ?? {}) };
  byProvider[failure.provider] = failure;
  const keys = Object.keys(byProvider);
  if (keys.length > MAX_PROVIDER_FAILURES) {
    const oldest = keys
      .sort((a, b) => (byProvider[a]?.at ?? 0) - (byProvider[b]?.at ?? 0))
      .slice(0, keys.length - MAX_PROVIDER_FAILURES);
    for (const key of oldest) delete byProvider[key];
  }
  return { byProvider };
}

/**
 * Clear a provider's failure, because a turn on it succeeded.
 *
 * Without this the first 402 would linger as the provider's "current" state long
 * after the top-up, and `/status` would be a worse signal than the log line it
 * replaced. A successful turn is the only evidence that the failure is over.
 */
export function withoutProviderFailure(
  value: ModelFailuresValue | undefined,
  provider: string,
): ModelFailuresValue {
  const byProvider = { ...(value?.byProvider ?? {}) };
  delete byProvider[provider];
  return { byProvider };
}

/**
 * Split `provider/modelId` into a provider name.
 *
 * The engine's model label is the pair joined with a slash, and a model id may
 * itself contain a slash (an OpenRouter-style `vendor/model`), so this splits on
 * the first one — the same rule `parseModel` in the session host uses.
 */
export function providerOf(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : undefined;
}
