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
/** Card action method for the model picker dropdown. */
export const MODEL_ACTION = "switch_model";
/** Card action method for the default-model picker button. */
export const SET_DEFAULT_MODEL_ACTION = "set_default_model";

/** How long to wait for a session abort to clear before force-resetting (ms). */
export const SESSION_ABORT_TIMEOUT_MS = 15_000;

/** `SwitchModelResult.error` value meaning the conversation is busy (redeliver later). */
export const BUSY = "busy";
