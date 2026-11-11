/**
 * The title prompt, its parser, and the HTTP call that sends it.
 *
 * These are the parts of the old `topic-summary.ts` that were never about *storage*: a prompt
 * contract, a normaliser, and a POST that cannot use `fetch`. Every surface that titles a
 * conversation needs them; only the SDK-era implementation needed a JSONL session file. They live
 * here now, so the module that read sessions can be deleted without taking them with it.
 */
import http from "node:http";
import https from "node:https";

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

type PostJson = (url: string, body: unknown, timeoutMs: number) => Promise<unknown>;
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


/**
 * POST JSON over node:http(s) and return the parsed response.
 *
 * NOT `fetch`: llama.cpp buffers the whole completion and only sends response
 * headers at the END, and undici aborts after a 300s `headersTimeout` — which
 * a slow CPU model blows through easily, failing the job with "fetch failed"
 * while the server is still happily generating. Here the only deadline is our
 * own (configurable) one. Injection-friendly so tests need no real server.
 */
