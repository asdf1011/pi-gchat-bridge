/**
 * What a running tool is doing, in one sentence, for every surface that shows it.
 *
 * Two surfaces render it — Chat's placeholder (Markdown) and the web pane's status row (plain text) —
 * and they had it written twice: 140 characters and backtick-stripping in one, 90 characters and none
 * in the other. The wording had already drifted in the part that matters least and would eventually
 * drift in the part that matters most (which argument is worth showing).
 *
 * So: one function for the *choice* — the command, else the path, else nothing — and the two renderers
 * keep only their own syntax. The cap is shared because "how much of a command is worth showing" is one
 * question; a narrow bubble and a patched message are not that different a width.
 */

/** Longest detail worth showing. Past this the reader learns nothing and the row wraps. */
const MAX_DETAIL = 120;

export interface ToolSummary {
  /** `Running`, or `Running <tool>` when there is no command to name. */
  label: string;
  /** The command or path, whitespace-collapsed and capped. Empty when the tool gave neither. */
  detail: string;
}

/** The command a tool call ran, or the path it touched, as one short line. */
export function toolSummary(toolName: string, args: unknown): ToolSummary {
  const a = (args ?? {}) as Record<string, unknown>;
  const command = typeof a.command === "string" ? a.command.trim().replace(/\s+/g, " ") : "";
  const path = typeof a.path === "string" ? a.path.trim() : "";
  // Backticks are stripped here rather than by each renderer: Chat wraps the detail in a code span, and
  // a stray backtick closes it early and turns the rest of the message into garbage.
  const detail = (command || path).replace(/`/g, "").slice(0, MAX_DETAIL);
  return { label: command ? "Running" : `Running ${toolName}`, detail };
}
