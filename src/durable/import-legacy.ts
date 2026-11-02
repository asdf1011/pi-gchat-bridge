/**
 * One-shot import of a legacy pi session into a durable conversation.
 *
 * Used once, at cutover, for the threads whose history is worth keeping. It is
 * **not** a runtime read path: after this runs, the legacy JSONL is just a file
 * on disk, and nothing in the bridge ever opens it again.
 *
 *   npx tsx src/durable/import-legacy.ts <db> <chatKey> <session.jsonl> [--full] [--tail N] [--dry]
 *
 * Two modes, and the choice is about the model behind the conversation:
 *
 *   --full   replay every user/assistant message as an entry. Exact, and cheap
 *            when the backend has a big context window: the largest thread on
 *            this deployment is ~37k tokens against deepseek's 1M. Each later
 *            turn carries the whole history, which is what the thread had before.
 *   default  summarise: the tail (default: the last 12 messages) as a single
 *            **handoff note** via `conversation.reset()`, a write that seeds
 *            context without asking the model anything. For a small-context or
 *            slow backend, where replaying everything would mean a long prefill
 *            on every turn.
 *
 * What neither mode carries: thinking blocks, tool calls, tool output and branch
 * structure. Those stay in the legacy file, which is never deleted.
 *   - It keeps the *substance* of the reasoning and drops thinking blocks, tool
 *     calls, tool output and branch structure. Those stay in the legacy file,
 *     which is never deleted.
 *   - It is idempotent: the conversation's `reset` uses a deterministic request
 *     id, so running it twice does not double the note.
 */
import fs from "node:fs";
import path from "node:path";

import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

import type { ConversationId } from "@earendil-works/pi-durable";

import { BridgeHost } from "./host.js";

interface LegacyMessage {
  role?: string;
  content?: unknown;
}

/** Text of a legacy message, flattening pi's content blocks. */
function messageText(message: LegacyMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => {
      if (typeof block === "string") return [block];
      if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
        return [(block as { text?: string }).text ?? ""];
      }
      return [];
    })
    .join("")
    .trim();
}

/**
 * The conversation to carry over, as a handoff note.
 *
 * Shape: a short header naming the origin, then the last `tail` exchanges with
 * their speaker. Assistant text is truncated per message — a handoff note is for
 * continuity, not for replaying every word of a 20k-token thread.
 */
export function buildHandoff(messages: { role: string; text: string }[], options: { tail: number; perMessageChars: number }): string {
  const useful = messages.filter((message) => message.text.trim() !== "");
  const kept = useful.slice(-options.tail);
  const dropped = useful.length - kept.length;
  const lines = [
    "This conversation continues one that was migrated from the previous bridge.",
    dropped > 0
      ? `The earlier part (${dropped} message${dropped === 1 ? "" : "s"}) is not included; the points below are where it left off.`
      : "The points below are where it left off.",
    "",
    ...kept.map((message) => {
      const who = message.role === "user" ? "User" : "Assistant";
      const text =
        message.text.length > options.perMessageChars
          ? `${message.text.slice(0, options.perMessageChars).trimEnd()}…`
          : message.text;
      return `**${who}:** ${text}`;
    }),
    "",
    "Continue from here. Prior detail can be re-derived by asking the user.",
  ];
  return lines.join("\n");
}

/** Every message of a legacy session file, oldest first. */
export interface LegacyModel {
  provider: string;
  modelId: string;
}

export interface LegacyMessage2 {
  role: string;
  text: string;
  /**
   * The model this message was produced under, as recorded by the legacy
   * session's `model_change` entries. `undefined` for user messages, and for
   * sessions that predate the first `model_change`.
   *
   * Provenance, not decoration: a thread that ran on the local 2B and was later
   * switched to deepseek must not have its whole history stamped with the model
   * the importer happened to be configured with. The assistant turn carries the
   * model that actually generated it.
   */
  model?: LegacyModel;
  /**
   * The raw pi-ai message, when replaying it verbatim is better than rebuilding
   * it from `text`.
   *
   * Set for everything that is not plain prose: `toolResult` messages (the
   * `tool_use` → `tool_result` pairing a provider validates) and `system` turns.
   * A tool row has no text, so the old reader dropped 14,159 of them — 104 of
   * 116 legacy files had tool traffic — and what survived was an assistant
   * claiming "let me check X" with the check missing.
   */
  raw?: unknown;
}

/**
 * Everything the importer needs from a legacy transcript: the text-bearing
 * messages, in order, each tagged with the model in force when it happened.
 *
 * `model_change` is a state machine, not a per-message field: it sets the
 * current model until the next change. So the model is tracked while walking
 * the file, which is also why this cannot be a separate pass over the JSONL.
 */
export function readLegacyTranscript(file: string): { messages: LegacyMessage2[]; finalModel?: LegacyModel } {
  const messages: LegacyMessage2[] = [];
  let current: LegacyModel | undefined;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry: { type?: string; message?: LegacyMessage; provider?: string; modelId?: string };
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a truncated tail line is expected after a crash
    }
    if (entry.type === "model_change" && entry.provider && entry.modelId) {
      current = { provider: entry.provider, modelId: entry.modelId };
      continue;
    }
    if (entry.type !== "message" || !entry.message) continue;
    const rawRole = entry.message.role;
    if (rawRole !== "user" && rawRole !== "assistant" && rawRole !== "system" && rawRole !== "toolResult") continue;
    const role = rawRole === "toolResult" ? "toolResult" : rawRole;
    const text = messageText(entry.message);
    // Keep a row the text flattener cannot represent faithfully: a tool result,
    // or an assistant turn whose only content is tool calls and thinking.
    const raw = role === "toolResult" || role === "system" || (role === "assistant" && !text) ? entry.message : undefined;
    messages.push({ role, text, model: role === "assistant" ? current : undefined, ...(raw ? { raw } : {}) });
  }
  return { messages, finalModel: current };
}

/** Text-bearing messages only, for callers that do not care about provenance. */
export function readLegacyMessages(file: string): { role: string; text: string }[] {
  return readLegacyTranscript(file)
    .messages.filter((message) => !message.raw)
    .map(({ role, text }) => ({ role, text }));
}

/**
 * Replay every text-bearing message of a legacy thread as entries.
 *
 * Imported messages have to be valid pi-ai messages, not just plausible ones: a
 * bare `{role, content: "…"}` assistant turn makes the next request fail with
 * `message.content.filter is not a function`, because an AssistantMessage carries
 * content *blocks* plus the request metadata the provider adapters read.
 *
 * ONE COMMIT PER MESSAGE, deliberately. Batching the whole transcript into one
 * commit looked like the obvious optimisation and was wrong: entries written in
 * the same commit share a `commit_seq`, and within a tie the order falls back to
 * entry ids, which do not follow call order inside a transaction. 44 of 109
 * conversations imported with their first exchange reversed because of it
 * (`assistant` before `user`), and any transcript could have been scrambled
 * internally with no way to tell from the outside. Distinct `commit_seq` values
 * are what make the replay order the transcript order, and 3k local SQLite
 * commits cost seconds — cheaper than a history you cannot trust.
 *
 * A message that fails to write is counted, not ignored: a partial import has to
 * be visible, because the caller skips conversations that already have bindings
 * and would otherwise never retry them.
 */
export async function fullReplay(
  host: BridgeHost,
  conversation: { id: ConversationId },
  messages: LegacyMessage2[],
  source: string,
): Promise<number> {
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const at = Date.now();
  const handle = (await host.harness.conversation(conversation.id as never, host.context))!;
  const agent = await handle.agent(host.context);
  const ref = agent.model;

  let count = 0;
  for (const message of messages) {
    // A raw row (tool result, system turn) is kept even without text: that is
    // the point of keeping it. Prose still needs to say something.
    if (!message.raw && !message.text.trim()) continue;
    // Prefer the model recorded alongside the message; fall back to the
    // conversation's current model only for transcripts that never recorded
    // one (three sessions predate the first `model_change`).
    const provenance = message.model ?? (ref ? { provider: ref.provider, modelId: ref.modelId } : undefined);
    const raw = message.raw as { api?: string; provider?: string; model?: string; usage?: unknown; stopReason?: string } | undefined;
    let kind: string;
    let model: unknown[];
    if (message.role === "user") {
      kind = "pi.user";
      model = [{ role: "user" as const, content: message.text, timestamp: at }];
    } else if (message.role === "toolResult") {
      kind = "pi.toolResult";
      model = [message.raw];
    } else if (message.role === "system") {
      kind = "pi.system";
      model = [message.raw];
    } else {
      kind = "pi.assistant";
      // A pure tool-call turn keeps its blocks (the tool_use ids a following
      // tool_result must reference); a prose turn is rebuilt from text so the
      // request metadata the adapters read is present.
      model = message.raw
        ? [{ ...raw, provider: raw?.provider ?? provenance?.provider ?? "imported", model: raw?.model ?? provenance?.modelId ?? "imported", usage: raw?.usage ?? usage, stopReason: raw?.stopReason ?? "toolUse", timestamp: at }]
        : [{
            role: "assistant" as const,
            content: [{ type: "text" as const, text: message.text }],
            api: "openai-completions",
            provider: provenance?.provider ?? "imported",
            model: provenance?.modelId ?? "imported",
            usage,
            stopReason: "stop" as const,
            timestamp: at,
          }];
    }
    await host.harness.commit(async (tx) => {
      await tx.appendEntry(conversation.id as never, {
        kind,
        data: { imported: true, source, ...(provenance ? { model: `${provenance.provider}/${provenance.modelId}` } : {}) },
        model: model as never,
      });
    }, host.context);
    count += 1;
  }
  return count;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [dbPath, chatKey, sessionFile] = args.filter((arg) => !arg.startsWith("--"));
  const dry = args.includes("--dry");
  const full = args.includes("--full");
  const tailIndex = args.indexOf("--tail");
  const tail = tailIndex >= 0 ? Number(args[tailIndex + 1]) : 12;
  if (!dbPath || !chatKey || !sessionFile) {
    console.error("usage: import-legacy.ts <db> <chatKey> <session.jsonl> [--full] [--tail N] [--dry]");
    process.exit(2);
  }

  const { messages } = readLegacyTranscript(sessionFile);
  const handoff = buildHandoff(messages, { tail, perMessageChars: 1_200 });
  const chars = messages.reduce((total, message) => total + message.text.length, 0);
  const nonProse = messages.filter((message) => message.raw).length;
  console.log(
    `[import] ${path.basename(sessionFile)}: ${messages.length} message(s)` +
      (nonProse ? ` (${nonProse} tool/call row(s) replayed verbatim)` : "") +
      `, ${chars.toLocaleString()} chars` +
      (full ? ` (full replay ≈ ${Math.round(chars / 4).toLocaleString()} tokens, + tool traffic)` : `, handoff ${handoff.length} chars`),
  );

  if (dry) {
    console.log("--- handoff (dry run, nothing written) ---");
    console.log(handoff);
    return;
  }

  const host = await BridgeHost.open({ dbPath, cwd: process.cwd() });
  try {
    const existing = await host.bindingFor(chatKey);
    const bound = existing
      ? {
          conversation: (await host.harness.conversation(existing.conversationId as never, host.context))!,
          binding: existing,
        }
      : await host.conversationFor(chatKey, {
          // Start on the configured default model, not on whatever is first in the
          // catalog: `getModels()[0]` is alphabetical and picked a Bedrock model
          // the first time this ran. /model can switch it afterwards.
          model: (() => {
            const settings = SettingsManager.create(host.cwdPath, getAgentDir(), { projectTrusted: false });
            const provider = settings.getDefaultProvider();
            const modelId = settings.getDefaultModel();
            if (provider && modelId) return { provider, modelId };
            const first = host.modelRuntime.getModels()[0];
            if (!first) throw new Error("no models configured");
            return { provider: first.provider, modelId: first.id };
          })(),
        });
    if (full) {
      const written = await fullReplay(host, bound.conversation, messages, path.basename(sessionFile));
      console.log(`[import] ${chatKey} -> conversation ${bound.binding.conversationId} (${written} entries replayed)`);
    } else {
      // reset() writes a handoff note and starts a new context from it: a write,
      // so no model is called and no answer is queued.
      await bound.conversation.reset(handoff, host.context);
      console.log(`[import] ${chatKey} -> conversation ${bound.binding.conversationId} (handoff written)`);
    }
  } finally {
    await host.close();
  }
}

// Only run when invoked directly, so the helpers above stay importable by tests.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("[import] failed:", error);
    process.exit(1);
  });
}
