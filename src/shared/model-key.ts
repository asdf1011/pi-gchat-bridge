/**
 * How a model is named in one string: `provider/modelId`.
 *
 * One function because the string is a *key*, not prose: it is stored on the binding, put in a Chat
 * card's form value (`provider|modelId`, a different separator for a different purpose), compared
 * against a picker selection and printed in `/status`. Written out by hand it appeared in eight
 * places, which is eight chances for a card to show a model the store does not have.
 *
 * `modelKey()` is the canonical form; `modelValue()` is the card-form form, and they are here together
 * so the difference between them is stated once rather than remembered.
 */
export function modelKey(model: { provider: string; modelId: string }): string {
  return `${model.provider}/${model.modelId}`;
}

/**
 * The same pair as a card form value.
 *
 * Chat's selection inputs carry a string, and `/` is not available inside one without escaping, so a
 * picker sends `provider|modelId`. Parsing it back is `parseModelValue`, beside the formatter for the
 * same reason.
 */
export function modelValue(model: { provider: string; modelId: string }): string {
  return `${model.provider}|${model.modelId}`;
}

/** `"provider|modelId"` back into its parts. Missing halves come back empty, never undefined. */
export function parseModelValue(value: string): { provider: string; modelId: string } {
  const [provider = "", modelId = ""] = value.split("|");
  return { provider, modelId };
}
