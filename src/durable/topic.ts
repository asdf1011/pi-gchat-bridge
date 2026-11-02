/**
 * Conversation-topic titles for the /model card, on the durable engine.
 *
 * The old path (`topic-summary.ts`) read the first turn out of a JSONL session
 * file. Durable conversations have no such file, so this reads the same
 * information out of the conversation's view instead — and reuses every piece
 * that is not about storage: the prompt contract, `cleanTitle`,
 * `postJson` (with its `fetch`-timeout workaround) and the card patch.
 *
 * Nothing is written back to the conversation. A title is a Chat-side label;
 * it must not enter the model's context or bust its prefix cache.
 */
import type { ConversationId } from "@earendil-works/pi-durable";

import { modelConfirmCard } from "../cards.js";
import type { ChatClient } from "../chat-client.js";
import { logger } from "../logger.js";
import type { StateStore } from "../state.js";
import {
  buildTopicPrompt,
  cleanTitle,
  MAX_TITLE_CHARS,
  postJson,
  TOPIC_SYSTEM_PROMPT,
  type TopicSummaryConfig,
} from "../topic-summary.js";
import { projectView, type ViewLike } from "../adapter/projection.js";
import type { BridgeHost } from "./host.js";

/** First user and assistant text in a conversation, for a title prompt. */
export function firstTurnFromView(view: ViewLike): { userText: string; assistantText: string } {
  let userText = "";
  let assistantText = "";
  for (const entry of view.entries ?? []) {
    const message = entry.model?.[0];
    if (!message || !Array.isArray(message.content)) continue;
    const text = message.content
      .flatMap((block) => (block?.type === "text" && block.text ? [block.text] : []))
      .join("")
      .trim();
    if (!text) continue;
    if (message.role === "user" && !userText) userText = text;
    else if (message.role === "assistant" && userText && !assistantText) {
      assistantText = text;
      break;
    }
  }
  return { userText, assistantText };
}

/**
 * Ask the (separate) titler server for a one-line topic.
 *
 * `cache_prompt: false` on purpose: a title is never resumed, so caching its
 * prompt is worthless, and asking the server not to cache keeps the titler's
 * own slot from accumulating state it will never reuse.
 */
export async function summarizeConversationTopic(
  view: ViewLike,
  config: TopicSummaryConfig,
  deps?: { post?: typeof postJson; maxChars?: number },
): Promise<string | undefined> {
  const post = deps?.post ?? postJson;
  const turn = firstTurnFromView(view);
  if (!turn.userText.trim() && !turn.assistantText.trim()) return undefined;

  const body = {
    model: config.model,
    messages: [
      { role: "system", content: TOPIC_SYSTEM_PROMPT },
      { role: "user", content: buildTopicPrompt({ ...turn, hasImage: false }) },
    ],
    max_tokens: 48,
    temperature: 0,
    // Never reuse a prefix: this request is one-shot, and the titler has its
    // own server precisely so it cannot touch a conversation's cache.
    cache_prompt: false,
    chat_template_kwargs: { enable_thinking: false },
  };

  const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const data = (await post(url, body, config.timeoutMs)) as {
    choices?: { message?: { content?: unknown } }[];
  };
  const raw = data.choices?.[0]?.message?.content;
  if (typeof raw !== "string") return undefined;
  return cleanTitle(raw, deps?.maxChars ?? MAX_TITLE_CHARS);
}

export interface DurableTopicDeps {
  state: StateStore;
  host: BridgeHost;
  client: ChatClient;
  config: TopicSummaryConfig;
  chatKey: string;
  display: string;
}

/**
 * Re-title the /model card for this conversation, if one is waiting.
 *
 * Called detached (never awaited) after a reply is posted, so a slow CPU model
 * can take minutes without holding anything up. No-op unless /model left a
 * pending card, which makes it cheap to call on every turn and impossible to
 * re-title the same card twice.
 */
export async function applyDurableTopicSummary(deps: DurableTopicDeps): Promise<void> {
  const { state, host, client, config, chatKey, display } = deps;
  const card = state.takeTopicCard(chatKey);
  if (!card) return;
  try {
    const binding = await host.bindingFor(chatKey);
    if (!binding) {
      logger.info(`[chat] ${display}: no conversation yet — topic title skipped`);
      return;
    }
    const conversation = await host.harness.conversation(
      binding.conversationId as ConversationId,
      host.context,
    );
    if (!conversation) return;
    const opened = await conversation.viewState(host.context);
    const started = Date.now();
    const title = await summarizeConversationTopic(opened.value as ViewLike, config);
    if (!title) {
      logger.info(`[chat] ${display}: topic title came back empty — card left as "Model switched"`);
      return;
    }
    await client.updateMessageCards(
      card.messageName,
      modelConfirmCard({ ok: true, created: true, modelLabel: card.modelLabel }, { title }),
      `${title} — new conversation on ${card.modelLabel}`,
    );
    logger.info(`[chat] ${display}: topic title "${title}" (${Math.round((Date.now() - started) / 1000)}s)`);
  } catch (err) {
    // Keep the card as-is; a title is a nicety, and retrying on every later
    // turn would keep a dead local model in the loop forever.
    logger.error(`[chat] ${display}: topic title failed — card left as "Model switched":`, (err as Error).message);
  }
}
