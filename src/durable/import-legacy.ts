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
export function readLegacyMessages(file: string): { role: string; text: string }[] {
  const out: { role: string; text: string }[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry: { type?: string; message?: LegacyMessage };
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a truncated tail line is expected after a crash
    }
    if (entry.type !== "message" || !entry.message) continue;
    const role = entry.message.role === "user" ? "user" : entry.message.role === "assistant" ? "assistant" : undefined;
    if (!role) continue;
    out.push({ role, text: messageText(entry.message) });
  }
  return out;
}

/**
 * Replay every text-bearing message of a legacy thread as entries.
 *
 * Imported messages have to be valid pi-ai messages, not just plausible ones: a
 * bare `{role, content: "…"}` assistant turn makes the next request fail with
 * `message.content.filter is not a function`, because an AssistantMessage carries
 * content *blocks* plus the request metadata the provider adapters read.
 *
 * One commit for the whole transcript: either the thread arrives complete or not
 * at all, and hundreds of separate transactions buy nothing.
 */
export async function fullReplay(
  host: BridgeHost,
  conversation: { id: ConversationId },
  messages: { role: string; text: string }[],
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

  return host.harness.commit(async (tx) => {
    let count = 0;
    for (const message of messages) {
      if (!message.text.trim()) continue;
      const model =
        message.role === "user"
          ? [{ role: "user" as const, content: message.text, timestamp: at }]
          : [{
              role: "assistant" as const,
              content: [{ type: "text" as const, text: message.text }],
              api: "openai-completions",
              provider: ref?.provider ?? "imported",
              model: ref?.modelId ?? "imported",
              usage,
              stopReason: "stop" as const,
              timestamp: at,
            }];
      await tx.appendEntry(conversation.id as never, {
        kind: message.role === "user" ? "pi.user" : "pi.assistant",
        data: { imported: true, source },
        model: model as never,
      });
      count += 1;
    }
    return count;
  }, host.context);
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

  const messages = readLegacyMessages(sessionFile);
  const handoff = buildHandoff(messages, { tail, perMessageChars: 1_200 });
  const chars = messages.reduce((total, message) => total + message.text.length, 0);
  console.log(
    `[import] ${path.basename(sessionFile)}: ${messages.length} message(s), ${chars.toLocaleString()} chars` +
      (full ? ` (full replay ≈ ${Math.round(chars / 4).toLocaleString()} tokens)` : `, handoff ${handoff.length} chars`),
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
