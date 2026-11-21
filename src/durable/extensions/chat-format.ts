/**
 * Chat Format — the bridge's own output rules, as a pi-durable extension.
 *
 * Port of `~/.pi/agent/extensions/chat-format`, which contributes the same rules
 * through pi's `systemPromptOptions.promptGuidelines`. pi-durable has no
 * guidelines section to append to; it rebuilds the system prompt from its
 * extensions' sections before every request, so the rules become a section.
 *
 * The table rule inverted in Nov 2026. Google Chat's Markdown had no tables, and
 * its fallback was destructive — the rows were concatenated with no separator,
 * so a comparison table collapsed into `… 258.1 ± 34.03.58 t/s…` and swallowed
 * the line after it — which is why the model was told never to write one. On
 * Nov 16 2026 tables became GA in `MARKUP_SYNTAX_MARKDOWN`, the syntax the
 * bridge already sends on create and on every streamed PATCH, and
 * `chat-markdown.ts` stopped rewriting them into bullets. So the rule now says
 * when a table is the right shape rather than forbidding it.
 *
 * Registered by the host for every conversation, like the old extension applied
 * to every session in the container.
 */
import { defineExtension, section } from "@earendil-works/pi-durable";

/** Rules contributed to the model's system prompt. */
export const CHAT_FORMAT_GUIDELINES: readonly string[] = [
  "Replies are rendered in Google Chat, whose Markdown renders pipe tables: use one when a comparison has three or more things in it and every cell is short, keep it to three or four columns, and use a bullet list when it would be one column and a sentence.",
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
