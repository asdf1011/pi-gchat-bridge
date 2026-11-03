/** Text/timing/action constants shared across the bridge's command + streaming logic. */

/** Placeholder text shown while pi is generating a reply. */
export const THINKING_TEXT = "Thinking…";
/** Debounce for coalescing streamed-text PATCHes to the placeholder (ms). */
export const PATCH_DEBOUNCE_MS = 250;
/** Delay before posting the "Thinking…" placeholder (quick replies never show one). */
export const MARKER_DELAY_MS = 3000;
/** Delay before showing the running tool's status line (ms). */
export const TOOL_STATUS_DELAY_MS = 2000;

/** Card action method for the session picker dropdown. */
export const RESUME_ACTION = "resume_session";
/** Card action method for the model + thinking-level picker. */
export const MODEL_ACTION = "switch_model";
/** Card action method for the /settings (global defaults) card. */
export const SETTINGS_ACTION = "set_defaults";
/** Card action method for a model dropdown's onChangeAction: rebuilds the
 *  thinking-level choices for the model that was just selected. Chat submits
 *  the whole form on a selection change, so the picked model arrives in
 *  formInputs and the card can be re-rendered server-side with the right
 *  levels (a static card can't know them — they depend on the model). */
export const THINKING_LEVELS_ACTION = "thinking_levels_for_model";
/** Legacy action id of the pre-/settings default-model card — still handled so
 *  cards posted before an upgrade keep working. */
export const SET_DEFAULT_MODEL_ACTION = "set_default_model";

/** pi's thinking levels, in pi's own order (off → max). Which of them are
 *  actually available depends on the model — see `supportedThinkingLevels()`
 *  in agent-sessions.ts (pi's own rule: `reasoning` + `thinkingLevelMap`). */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];
/** Dropdown value meaning "don't change the thinking level". */
export const THINKING_KEEP = "keep";

/** How long to wait for a session abort to clear before force-resetting (ms). */
export const SESSION_ABORT_TIMEOUT_MS = 15_000;

/** `SwitchModelResult.error` value meaning the conversation is busy (redeliver later). */
export const BUSY = "busy";

/** Card action: `/secret` panel's "add" button — asks for a name first. */
export const SECRET_ACTION = "secret_prompt";

/** Card action: store the value submitted by a `secretValueCard`. */
export const SET_SECRET_ACTION = "secret_set";

/** Card action: remove a stored secret, named by a `parameters` entry. */
export const REMOVE_SECRET_ACTION = "secret_remove";
