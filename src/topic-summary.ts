import http from "node:http";
import https from "node:https";
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

/** Longest slice of each message we send — enough for a topic, cheap to evaluate. */
const MAX_USER_CHARS = 600;
const MAX_ASSISTANT_CHARS = 900;
/**
 * Sanity limit on title length: no word-count target (longer titles are fine),
 * just a guard so a runaway generation can't turn the card header into a wall
 * of text. Chat wraps the header, and the thread list truncates it anyway.
 */
export const MAX_TITLE_CHARS = 200;

/**
 * Deliberately terse: a 2B model follows a handful of short rules and ignores a
 * long brief. "Topic, not answer" is the important one — without it the model
 * summarizes the assistant's conclusion ("…is blocked by two layers: …"), which
 * makes a useless title.
 *
 * The last clause exists because a conversation's first exchange often has no
 * topic yet ("Hello" → "I'm in /workspace…"). Without it the model invents one:
 * that thread came back as "Workflow Design for AI Chat Interfaces".
 *
 * This is contract `title-v3` in evals/ (see evals/README.md for the v1 → v3
 * comparison). The word count is guidance, not a contract — cleanTitle only
 * enforces MAX_TITLE_CHARS.
 */
export const TOPIC_SYSTEM_PROMPT = [
  "You write titles for chat conversations.",
  "Read the user's first message and the assistant's reply, then reply with a title of at most 12 words.",
  "Describe what the conversation is about, not who said what.",
  "No quotes, no trailing period, no preamble.",
  "If they don't contain a topic yet, say what the conversation started with.",
].join(" ");

export interface TopicSummaryConfig {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  /**
   * Bearer token for a hosted titler.
   *
   * Only sent when set: the local llama.cpp server takes no auth, and sending an
   * empty header there is at best noise.
   */
  apiKey?: string;
}

/** What the title prompt was built from (kept separate so it's unit-testable). */
export interface TopicPromptInput {
  userText: string;
  assistantText: string;
  hasImage: boolean;
}

/** Transcript fragment handed to the local model, ending in its cue to answer. */
export function buildTopicPrompt(input: TopicPromptInput): string {
  const user = input.userText.trim() || "(the user sent a photo with no text)";
  const lines = [
    `USER: ${user.slice(0, MAX_USER_CHARS)}`,
    `ASSISTANT: ${input.assistantText.trim().slice(0, MAX_ASSISTANT_CHARS)}`,
    "TITLE:",
  ];
  return lines.join("\n\n");
}

/**
 * Normalize a model's raw title into something safe for a card header:
 * first line only, no "TITLE:" echo or wrapping quotes, no trailing
 * punctuation, whitespace collapsed. Length is only capped at MAX_TITLE_CHARS
 * (on a word boundary) as a runaway guard. Returns undefined when nothing
 * usable is left, so the caller keeps the existing card rather than writing
 * an empty header.
 */
export function cleanTitle(raw: string, maxChars = MAX_TITLE_CHARS): string | undefined {
  let text = (raw ?? "").split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
  text = text.replace(/^(title|topic|conversation)\s*[::]\s*/i, "");
  // Card headers don't render Markdown, so stray emphasis/quote markers would
  // show up literally in the thread list.
  text = text.replace(/^["'“”‘’*_`]+|["'“”‘’*_`]+$/g, "");
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > maxChars) {
    // Cut at the last word boundary that fits instead of mid-word.
    text = text.slice(0, maxChars).replace(/\s+\S*$/, "").trim() || text.slice(0, maxChars).trim();
  }
  text = text.replace(/[\s.,;:!?–-]+$/u, "").trim();
  return text.length > 0 ? text : undefined;
}

type PostJson = (url: string, body: unknown, timeoutMs: number) => Promise<unknown>;

/**
 * POST JSON over node:http(s) and return the parsed response.
 *
 * NOT `fetch`: llama.cpp buffers the whole completion and only sends response
 * headers at the END, and undici aborts after a 300s `headersTimeout` — which
 * a slow CPU model blows through easily, failing the job with "fetch failed"
 * while the server is still happily generating. Here the only deadline is our
 * own (configurable) one. Injection-friendly so tests need no real server.
 */
export function postJson(
  url: string,
  body: unknown,
  timeoutMs: number,
  apiKey?: string,
): Promise<unknown> {
  const target = new URL(url);
  const transport = target.protocol === "https:" ? https : http;
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = transport.request(
      target,
      {
        method: "POST",
        // No connection pooling: llama.cpp closes the socket after a buffered
        // response, and node's keep-alive agent reuses the dead socket for the
        // next request, failing it instantly with "socket hang up".
        agent: false,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new Error(`HTTP ${status}: ${text.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error(`unparsable response: ${text.slice(0, 200)}`));
          }
        });
        res.on("error", reject);
      },
    );
    // Idle-socket guard (also covers connect). Independent of undici's hidden
    // 300s header deadline, so a long generation isn't mistaken for a hang.
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`)));
    req.on("error", reject);
    req.end(payload);
  });
}

/**
 * Ask the local model for a conversation title. Never throws: failures are
 * logged and reported as undefined so the caller leaves the card as it is.
 */
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
