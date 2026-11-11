import {
  buildTopicPrompt,
  cleanTitle,
  MAX_TITLE_CHARS,
  postJson,
  TOPIC_SYSTEM_PROMPT,
  type TopicSummaryConfig,
} from "./durable/topic-prompt.js";
import type { AgentRouter } from "./agent-sessions.js";
import { modelConfirmCard } from "./cards.js";
import type { ChatClient } from "./chat-client.js";
import { logger } from "./logger.js";
import { readFirstTurn } from "./session-file.js";
import type { StateStore } from "./state.js";

/**
 * Conversation-topic titles for the /model card (gchat display only).
 *
 * When /model starts a conversation, the card it leaves behind ("Model
 * switched / New conversation on X") becomes the thread's top message — i.e.
 * the one line the space's conversation list shows. That says which model is
 * running but nothing about the topic, so once the first exchange is done we
 * ask a small LOCAL model for a one-line title and patch it into the card's
 * header. Nothing is written to the session: pi's history stays untouched, so
 * the title can't leak into the model's context or bust the prompt cache.
 *
 * The local model is the right tool here: always available, free, and this is
 * a summarization task, not agency. It's also SLOW on CPU (a few tokens/sec),
 * which is why every step is bounded and the whole thing runs as a detached
 * background job well after the reply has been posted.
 */

/** The `postJson` signature, so a test can inject a fake instead of running a server. */
type PostJson = (url: string, body: unknown, timeoutMs: number) => Promise<unknown>;

/** What the title prompt was built from (kept separate so it's unit-testable). */
export async function summarizeSessionTopic(
  file: string,
  config: TopicSummaryConfig,
  deps?: { post?: PostJson; maxChars?: number },
): Promise<string | undefined> {
  const post = deps?.post ?? ((url, body, timeout) => postJson(url, body, timeout, config.apiKey));
  const turn = await readFirstTurn(file);
  // Image-only greetings ("what's going on here" + photo) are exactly the case
  // this feature exists for, so pass the image itself — LFM3-VL is multimodal.
  if (!turn.userText.trim() && !turn.assistantText.trim() && !turn.image) return undefined;

  const userContent: unknown[] = [
    { type: "text", text: buildTopicPrompt({ ...turn, hasImage: !!turn.image }) },
  ];
  if (turn.image) {
    userContent.push({
      type: "image_url",
      image_url: { url: `data:${turn.image.mimeType};base64,${turn.image.data}` },
    });
  }

  const body = {
    model: config.model,
    messages: [
      { role: "system", content: TOPIC_SYSTEM_PROMPT },
      // A single text block is sent as a plain string: some llama.cpp chat
      // templates mishandle a one-element content array.
      { role: "user", content: turn.image ? userContent : (userContent[0] as { text: string }).text },
    ],
    max_tokens: 48,
    temperature: 0,
    // The server's template would otherwise spend the whole budget thinking.
    chat_template_kwargs: { enable_thinking: false },
  };

  const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  if (turn.image) {
    logger.info(`[chat] topic title: sending a ${Math.round(turn.image.data.length / 1024)}KB image`);
  }
  const data = (await post(url, body, config.timeoutMs)) as {
    choices?: { message?: { content?: unknown } }[];
  };
  const raw = data.choices?.[0]?.message?.content;
  if (typeof raw !== "string") return undefined;
  return cleanTitle(raw, deps?.maxChars ?? MAX_TITLE_CHARS);
}

export interface TopicSummaryDeps {
  state: StateStore;
  router: AgentRouter;
  client: ChatClient;
  config: TopicSummaryConfig;
  sessionKey: string;
  display: string;
}

/**
 * Re-title the /model card for this conversation, if one is waiting.
 *
 * Called detached (never awaited) right after a turn's reply is posted, so a
 * slow CPU model can take minutes without holding anything up. No-op unless
 * /model left a pending card for this conversation, which makes it both cheap
 * to call on every turn and impossible to re-title the same card twice.
 */
export async function applyTopicSummary(deps: TopicSummaryDeps): Promise<void> {
  const { state, router, client, config, sessionKey, display } = deps;
  const card = state.takeTopicCard(sessionKey);
  if (!card) return;
  try {
    const file = router.sessionFile(sessionKey);
    if (!file) {
      logger.info(`[chat] ${display}: no session file yet — topic title skipped`);
      return;
    }
    const started = Date.now();
    const title = await summarizeSessionTopic(file, config);
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
