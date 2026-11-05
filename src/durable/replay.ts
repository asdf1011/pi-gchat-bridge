/**
 * Replay real legacy traffic through the durable stack, offline.
 *
 * Purpose changed at cutover. It was planned as pre-cutover validation; instead
 * it answers a narrower question afterwards: does the durable engine produce
 * the same *kind* of reply the SDK host produced for the same request, on real
 * prompts rather than ones invented for a test.
 *
 * Deliberately offline: reads the session files, never touches Pub/Sub, so it
 * cannot double-answer anything in Chat and can run while the bridge is live on
 * the same database (read-only: a separate temporary store).
 *
 *   npx tsx src/durable/replay.ts --limit 5
 *
 * Prints, per prompt: latency, the reply, and the projected Chat text length.
 * Eyeballing is the point — there is no automated oracle for "a good answer".
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

import { AssistantEntry } from "@earendil-works/pi-durable";

import { projectView, type ViewLike } from "../session-host/projection.js";
import { defaultSettings } from "../adapter/commands.js";
import { inProcessSessionHost } from "../session-host/inprocess.js";
import { BridgeHost } from "./host.js";

interface Sample {
  prompt: string;
  /** The reply the SDK host actually sent, for comparison. */
  expected: string;
}


/**
 * Is this prompt replayable without its surrounding conversation?
 *
 * The first replay run took 36-91s per prompt because it replayed the *last*
 * pairs of a long thread, which are full of "Let's do it" and "Ok, go ahead" —
 * prompts whose referent is the previous turn. Stripped of context the model
 * has to reason about what "it" means, which is slow and tests nothing about
 * the engine. Real traffic has a referent; a replay that removes it is a worse
 * test than a shorter, self-contained one.
 */
function isSelfContained(text: string): boolean {
  const trimmed = text.trim();
  // Injected notifications and harness notices.
  if (trimmed.startsWith("<")) return false;
  // Too short to carry its own referent ("Ok", "Go", "Let's do it").
  if (trimmed.length < 60) return false;
  return true;
}

/** Text of a legacy message entry, or "" when it carries none (tool-only turns). */
function textOf(message: { role?: string; content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && "text" in block) {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("").trim();
}

/** Consecutive (user, assistant) text pairs from a session file. */
function samplesFrom(file: string, want: number): Sample[] {
  const samples: Sample[] = [];
  let pendingPrompt: string | undefined;
  const lines = fs.readFileSync(file, "utf8").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: { type?: string; message?: { role?: string; content?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const message = entry.message;
    if (!message) continue;
    if (message.role === "user") {
      const text = textOf(message);
      pendingPrompt = text && isSelfContained(text) ? text : undefined;
      continue;
    }
    if (message.role === "assistant" && pendingPrompt) {
      const reply = textOf(message);
      if (reply) {
        samples.push({ prompt: pendingPrompt, expected: reply });
        pendingPrompt = undefined;
        if (samples.length >= want) break;
      }
    }
  }
  return samples;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const limit = Number(argv[argv.indexOf("--limit") + 1]) || 5;
  const only = argv.includes("--file") ? argv[argv.indexOf("--file") + 1] : undefined;

  // This thread is the richest source of prompts with non-trivial answers.
  const file = only ?? "sessions/spaces_sPA7FKAAAAE_threads_BFpkfrGTCJA-84899d68.jsonl";
  if (!fs.existsSync(file)) {
    console.error(`no such session file: ${file}`);
    process.exit(1);
  }

  // Take the LAST N pairs: they exercise the current model and current tooling,
  // where older turns may predate both.
  const all = samplesFrom(file, 10_000);
  const samples = all.slice(-limit);
  console.log(`${all.length} replayable pairs in ${path.basename(file)}, replaying ${samples.length}\n`);

  // A throwaway store: replay writes real conversations, and must never touch
  // the live bridge database.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "durable-replay-"));
  const settingsManager = SettingsManager.create(getAgentDir(), process.cwd());
  void settingsManager;

  const host = await BridgeHost.open({ dbPath: path.join(dir, "replay.sqlite"), cwd: process.cwd() });
  const model = process.env.REPLAY_MODEL_PROVIDER && process.env.REPLAY_MODEL_ID
    ? { provider: process.env.REPLAY_MODEL_PROVIDER, modelId: process.env.REPLAY_MODEL_ID }
    : await defaultModel(host);

  try {
    for (const [index, sample] of samples.entries()) {
      const binding = await host.conversationFor(`replay/${index}`, { model });
      const started = Date.now();
      const submission = await binding.conversation.submit(
        { type: "input", content: [{ type: "text", text: sample.prompt }] },
        host.context,
      );
      const settled = await submission.wait(host.context);
      const elapsed = Date.now() - started;

      // The answer entry, exactly as the live sink receives it — so this
      // exercises the same projection the bridge uses, not a parallel path.
      // Same read the live bridge does: the settled answer entry, committed.
      const answerId = settled.status === "done" ? settled.answer : undefined;
      const answer = answerId === undefined
        ? undefined
        : await binding.conversation.commit((tx) => tx.entry(AssistantEntry, answerId), host.context);
      const text = textOf(
        (answer?.model?.[0] ?? {}) as { content?: unknown },
      );
      // And the same view the sink paints from, so a projection fault shows up
      // here rather than first in Chat.
      const opened = await binding.conversation.viewState(host.context);
      const projected = projectView(opened.value as ViewLike);
      const projectedChars = projected.lastAssistantText.length;

      console.log(`── ${index + 1}. ${elapsed} ms · ${settled.status} · ${text.length} chars (projected ${projectedChars})`);
      console.log(`   asked:  ${sample.prompt.replace(/\s+/g, " ").slice(0, 160)}`);
      console.log(`   answer: ${text.replace(/\s+/g, " ").slice(0, 240)}`);
      console.log(`   before: ${sample.expected.replace(/\s+/g, " ").slice(0, 240)}\n`);
    }
  } finally {
    await host.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The bridge's own default-resolution, not a second implementation.
 *
 * The first draft split `settings.defaultModel` on "/" and fell through to
 * getModels()[0] when it had no provider prefix — which `deepseek-flash` does
 * not, so every replay ran on a Bedrock model and failed instantly. Reusing
 * `defaultSettings` means there is one resolver to be wrong in one place.
 */
async function defaultModel(host: BridgeHost): Promise<{ provider: string; modelId: string }> {
  const seam = inProcessSessionHost({ host, roots: [] });
  const defaults = await defaultSettings(seam);
  if (defaults.provider && defaults.modelId) {
    return { provider: defaults.provider, modelId: defaults.modelId };
  }
  const [fallback] = await seam.models();
  if (!fallback) throw new Error("no models available");
  return { provider: fallback.provider, modelId: fallback.id };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
