/**
 * Import every legacy conversation of a space into durable conversations.
 *
 * Run once, at cutover. The hard part is not the copy — it is knowing which Chat
 * key each `sessions/*.jsonl` file belongs to, because the file name is the
 * *sanitized* key and sanitization is lossy (`/` and `-` and `_` all become `_`).
 * Two sources, in order of authority:
 *
 *   1. **The bridge log.** Every session the bridge opened is logged as
 *      `opened session for <key> -> <file>`, so the log is an exact key→file map
 *      for everything that has been used since it started. Preferred.
 *   2. **The naming rule**, for files never opened since (mostly cron
 *      notification threads). Reverse the sanitization by the pattern the keys
 *      actually follow: `spaces/<space>/threads/<name>` keeps underscores inside
 *      the thread name (Chat thread keys contain them), while a cron thread key
 *      is hyphenated (`chat-api-release-notes-2026-08-15`).
 *
 * Anything it cannot resolve is reported and skipped rather than guessed into the
 * wrong thread — an import into the wrong key is worse than no import, because it
 * puts one conversation's history in another thread's mouth.
 *
 *   npx tsx src/durable/import-all.ts <db> [--space spaces/XXXX] [--apply] [--log bridge.log]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createHash } from "node:crypto";

import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

import { BridgeHost } from "./host.js";
import { fullReplay, readLegacyMessages, readLegacyTranscript } from "./import-legacy.js";

interface Entry {
  key: string;
  file: string;
  messages: number;
  chars: number;
  source: "log" | "derived";
}

/** key → file, from `opened session for <key> -> <file>` lines. */
export function keyMapFromLog(logFile: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!fs.existsSync(logFile)) return map;
  const pattern = /opened session for (\S+) -> (\S+)/g;
  for (const match of fs.readFileSync(logFile, "utf8").matchAll(pattern)) {
    // The last mapping wins: a thread can be re-opened after an eviction.
    map.set(path.basename(match[2]), match[1]);
  }
  return map;
}

/**
 * Reverse `legacySessionFile()`'s sanitization for a file name, using the shape
 * of real conversation keys. Returns undefined when the name does not fit either
 * pattern, so the caller can report it instead of importing it somewhere wrong.
 */
export function deriveKey(fileName: string): string | undefined {
  const stem = fileName.replace(/\.jsonl$/, "");
  const match = /^(spaces_[A-Za-z0-9]+)_(.+)$/.exec(stem);
  if (!match) return undefined;
  const space = match[1].replace(/^spaces_/, "spaces/");
  const rest = match[2];

  const thread = /^threads_(.+?)(?:-([0-9a-f]{8}))?$/.exec(rest);
  if (thread) {
    // Chat thread names contain both `-` and `_` (`4-Xhvm-uLNc` sanitizes to
    // `4_Xhvm_uLNc`), so underscores in the file name are ambiguous. When the
    // name carries a hash, the hash decides; when it does not, an ambiguous name
    // is reported rather than guessed — importing one thread's history under
    // another thread's key is worse than not importing it.
    return resolve(space, thread[1], thread[2], "threads");
  }

  // A cron/notification thread. Its keys are hyphenated by convention
  // (`chat-api-release-notes-2026-08-15`), and the hashed siblings listed in the
  // log prove it, so an unhashed one can be read the same way.
  const cron = /^(.+?)(?:-([0-9a-f]{8}))?$/.exec(rest);
  if (cron) return resolve(space, cron[1], cron[2], undefined, true);
  return undefined;
}

/**
 * Pick the key that produced this file name. `sanitize()` maps every non
 * alphanumeric to `_`, so the candidates are the plausible readings of the name;
 * a hash suffix (the first 8 of sha256(key)) selects one exactly.
 */
function resolve(
  space: string,
  raw: string,
  hash: string | undefined,
  sub: string | undefined,
  hyphenatedByConvention = false,
): string | undefined {
  const readings = [raw.replace(/_/g, "-"), raw];
  const build = (name: string) => (sub ? `${space}/${sub}/${name}` : `${space}/${name}`);
  if (hash) {
    return readings.map(build).find((key) => createHash("sha256").update(key).digest("hex").startsWith(hash));
  }
  // No hash: trust the convention where one exists, otherwise only a name with
  // nothing to confuse.
  if (hyphenatedByConvention) return build(readings[0]);
  return raw.includes("_") ? undefined : build(raw);
}

export function buildInventory(sessionsDir: string, logFile: string, space?: string): {
  entries: Entry[];
  unresolved: string[];
} {
  const fromLog = keyMapFromLog(logFile);
  const entries: Entry[] = [];
  const unresolved: string[] = [];

  for (const fileName of fs.readdirSync(sessionsDir).filter((name) => name.endsWith(".jsonl")).sort()) {
    const file = path.join(sessionsDir, fileName);
    const logged = fromLog.get(fileName);
    const key = logged ?? deriveKey(fileName);
    if (!key) {
      unresolved.push(fileName);
      continue;
    }
    if (space && !key.startsWith(`${space}/`) && key !== space) continue;
    const messages = readLegacyMessages(file);
    const withText = messages.filter((message) => message.text.trim() !== "");
    entries.push({
      key,
      file,
      messages: withText.length,
      chars: withText.reduce((total, message) => total + message.text.length, 0),
      source: logged ? "log" : "derived",
    });
  }
  return { entries, unresolved };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dbPath = args.find((arg) => !arg.startsWith("--"));
  const apply = args.includes("--apply");
  const spaceIndex = args.indexOf("--space");
  const space = spaceIndex >= 0 ? args[spaceIndex + 1] : undefined;
  const logIndex = args.indexOf("--log");
  const logFile = logIndex >= 0 ? args[logIndex + 1] : path.join(process.cwd(), "bridge.log");

  const sessionsDir = path.join(process.cwd(), "sessions");
  if (!dbPath) {
    console.error("usage: import-all.ts <db> [--space spaces/XXXX] [--apply] [--log bridge.log]");
    process.exit(2);
  }

  const { entries, unresolved } = buildInventory(sessionsDir, logFile, space);
  const totalMessages = entries.reduce((total, entry) => total + entry.messages, 0);
  const totalChars = entries.reduce((total, entry) => total + entry.chars, 0);

  console.log(
    `${entries.length} conversation(s), ${totalMessages} message(s), ${totalChars.toLocaleString()} chars ` +
      `(~${Math.round(totalChars / 4).toLocaleString()} tokens across all, paid per conversation when used)`,
  );
  const bySource = entries.filter((entry) => entry.source === "derived");
  console.log(`${entries.length - bySource.length} from the log, ${bySource.length} derived from the file name`);
  if (unresolved.length) {
    console.log(`\n${unresolved.length} file(s) skipped (key unknown — left in the legacy store):`);
    for (const name of unresolved.slice(0, 20)) console.log(`  ${name}`);
  }

  const empty = entries.filter((entry) => entry.messages === 0);
  console.log(`\n${empty.length} conversation(s) have no text to import (tool-only or notification-only)`);

  if (!apply) {
    const sample = [...entries].sort((a, b) => b.chars - a.chars).slice(0, 8);
    console.log("\nlargest:");
    for (const entry of sample) {
      console.log(`  ${String(entry.messages).padStart(4)} msgs ${String(entry.chars).padStart(7)} chars  ${entry.key}`);
    }
    console.log("\nre-run with --apply to write them");
    return;
  }

  const host = await BridgeHost.open({ dbPath, cwd: process.cwd() });
  let imported = 0;
  let skipped = 0;
  try {
    for (const entry of entries) {
      if (entry.messages === 0) {
        skipped += 1;
        continue;
      }
      const existing = await host.bindingFor(entry.key);
      if (existing) {
        skipped += 1;
        continue; // idempotent: never replay twice
      }
      const binding = await host.conversationFor(entry.key, { model: defaultModel(host) });
      // readLegacyTranscript, not readLegacyMessages: only the former carries the
      // per-message model, and dropping it here is what left every imported turn
      // attributed to whatever the conversation happened to be configured with.
      const { messages } = readLegacyTranscript(entry.file);
      const written = await fullReplay(host, binding.conversation, messages, path.basename(entry.file));
      imported += 1;
      console.log(`  ${entry.key} -> conversation ${binding.binding.conversationId} (${written} entries)`);
    }
    console.log(`\nimported ${imported}, skipped ${skipped}`);
  } finally {
    await host.close();
  }
}

/**
 * The configured default model — not `getModels()[0]`, which is alphabetical and
 * picked a Bedrock model the first time this ran, leaving 109 conversations
 * configured for a provider with no credentials.
 */
function defaultModel(host: BridgeHost): { provider: string; modelId: string } {
  const settings = SettingsManager.create(host.cwdPath, getAgentDir(), { projectTrusted: false });
  const provider = settings.getDefaultProvider();
  const modelId = settings.getDefaultModel();
  if (provider && modelId) return { provider, modelId };
  const first = host.modelRuntime.getModels()[0];
  if (!first) throw new Error("no models configured");
  return { provider: first.provider, modelId: first.id };
}

export const TEMP_DB = path.join(os.tmpdir(), "import-all.db");

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("[import-all] failed:", error);
    process.exit(1);
  });
}
