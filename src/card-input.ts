/**
 * Reading values out of Google Chat card interactions.
 *
 * Extracted from `commands.ts` so the durable command layer and the SDK-host one
 * share exactly one implementation while both exist. Both are fiddly, and a
 * second copy that drifts would mean a dropdown that works on one path and not
 * the other.
 */
import type { IncomingMessage } from "./types.js";

/**
 * Read one widget's value from a CARD_CLICKED event's form inputs, by the
 * widget's `name`. Cards carry several dropdowns (model + thinking level), so
 * reading "the first value" would pick the wrong one. Selection values only
 * arrive when a BUTTON submits the form — a dropdown's `onChangeAction` fires an
 * event with no value. Widget values appear either under
 * `input.selectionInput.selectedValues[]` / `input.stringInputs.value[]`
 * (legacy `action.formInputs`) or flattened under `common.formInputs`.
 */
export function formValue(incoming: IncomingMessage, name: string): string | undefined {
  const formInputs = incoming.action?.formInputs;
  if (!formInputs) return undefined;
  const widget = formInputs[name];
  if (!widget) return undefined;
  const input = widget.input ?? widget;
  return input?.selectionInput?.selectedValues?.[0] ?? input?.stringInputs?.value?.[0];
}

/** Fallback for cards posted before multi-dropdown support: any single value. */
export function anyFormValue(incoming: IncomingMessage): string | undefined {
  const formInputs = incoming.action?.formInputs;
  if (!formInputs) return undefined;
  for (const key of Object.keys(formInputs)) {
    const widget = formInputs[key];
    const input = widget?.input ?? widget;
    const value = input?.selectionInput?.selectedValues?.[0] ?? input?.stringInputs?.value?.[0];
    if (value) return value;
  }
  return undefined;
}

/** Read one of a card action's static `parameters` (e.g. which selection's key). */
export function actionParam(incoming: IncomingMessage, key: string): string | undefined {
  return incoming.action?.parameters?.find((p) => p.key === key)?.value;
}
