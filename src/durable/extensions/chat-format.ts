/**
 * Chat Format — the bridge's own output rules, as a pi-durable extension.
 *
 * Port of `~/.pi/agent/extensions/chat-format`, which contributes the same rules
 * through pi's `systemPromptOptions.promptGuidelines`. pi-durable has no
 * guidelines section to append to; it rebuilds the system prompt from its
 * extensions' sections before every request, so the rules become a section.
 *
 * The underlying problem is unchanged and worth restating: Google Chat's Markdown
 * subset has no tables at all, and its fallback concatenates the rows with no
 * separator, so a comparison table collapses into `… F16258.1 ± 34.03.58 t/s…`
 * and swallows the line after it. `chat-markdown.ts` still rewrites tables into
 * bullets on the way out, and `adapter/projection.ts` is not involved; but not
 * emitting them in the first place reads better, because the answer is then
 * worded for the reader instead of for the table.
 *
 * Registered by the host for every conversation, like the old extension applied
 * to every session in the container.
 */
import { defineExtension, section } from "@earendil-works/pi-durable";

/** Rules contributed to the model's system prompt. */
export const CHAT_FORMAT_GUIDELINES: readonly string[] = [
  "Replies are rendered in Google Chat, whose Markdown has no tables: never use pipe tables — write comparisons as bullet lines like `- **Q8_0** — PPL: 258.1 ± 34.0; speed: 3.58 t/s`.",
  "Chat is usually read on a phone: keep lines short, use `##` headings only for real sections (Chat renders them as plain bold lines), and put raw output in fenced code blocks instead of wide aligned columns.",
];

export const ChatFormat = defineExtension({
  name: "chat-format",
  sections: [
    // The rules only change when this file does, so a constant section keeps the
    // prompt cache warm; a section that returned something new each request
    // would defeat it (see pi-durable's "System Prompt" notes).
    section("chat_format", () => CHAT_FORMAT_GUIDELINES.join("\n")),
  ],
});
