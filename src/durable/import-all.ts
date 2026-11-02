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
import { DatabaseSync } from "node:sqlite";

import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

import { BridgeHost } from "./host.js";
import { fullReplay, readLegacyTranscript } from "./import-legacy.js";

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
 *
 * A DM is not a separate namespace in Chat: it is a space of type DM, named
 * `spaces/<id>`. Two DM shapes therefore have to be read here, and both were
 * missing from the first draft, which only knew about threads inside a space:
 *
 *   - `spaces_<id>.jsonl` — a non-threaded DM, whose key IS the space. The old
 *     regex demanded a `_<something>` tail, so every such DM was reported as
 *     unresolved and left behind in the legacy store.
 *   - `spaces_<id>_conv_<id>.jsonl` — a DM conversation, keyed `conv-<id>`. The
 *     key is hyphenated; reading it back with underscores invents a key nothing
 *     writes to, so the history would land in a conversation the bridge never
 *     looks up.
 */
export function deriveKey(fileName: string, known?: ReadonlyMap<string, string>): string | undefined {
  const stem = fileName.replace(/\.jsonl$/, "");
  // A bare space stem: check BEFORE the general pattern, which requires a tail.
  // The id charset excludes `_`, so this cannot swallow `spaces_<id>_threads_…`.
  const bare = /^spaces_([A-Za-z0-9]+)$/.exec(stem);
  if (bare) return `spaces/${bare[1]}`;

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
    return resolve(space, thread[1], thread[2], "threads", false, known);
  }

  // A DM conversation (`conv-<id>`), a space-level topic, or a cron/notification
  // thread (`chat-api-release-notes-2026-08-15`). All are hyphenated by
  // convention, and the hashed siblings listed in the log prove it, so an
  // unhashed one can be read the same way — but a bound key, when there is one,
  // outranks the convention, because it is a fact rather than a habit.
  const cron = /^(.+?)(?:-([0-9a-f]{8}))?$/.exec(rest);
  if (cron) return resolve(space, cron[1], cron[2], undefined, true, known);
  return undefined;
}

/**
 * Pick the key that produced this file name. `sanitize()` maps every non
 * alphanumeric to `_`, so the candidates are the plausible readings of the name;
 * a hash suffix (the first 8 of sha256(key)) selects one exactly.
 *
 * `known` — the keys that already have a binding — is what makes the unhashed
 * files decidable. Older write paths produced no hash at all (21 here, including
 * two `conv-` threads with no other record), and the previous rule gave up on
 * any name containing `_` rather than guess. But "give up" is itself a choice,
 * and the wrong one when the space has exactly one bound key that reproduces
 * this exact file name: `MKiv-3_kJVwQ` is the only key in the space that
 * sanitizes to `MKiv_3_kJVwQ`, so there is nothing to confuse it with. Ambiguity
 * is checked, not assumed from the presence of an underscore.
 */
function resolve(
  space: string,
  raw: string,
  hash: string | undefined,
  sub: string | undefined,
  hyphenatedByConvention = false,
  known?: ReadonlyMap<string, string>,
): string | undefined {
  // Sanitization is many-to-one: `-` and `_` both become `_`, so a name like
  // `MKiv-3_kJVwQ` and `MKiv_3_kJVwQ` produce the same stem. The readings must
  // span mixes of both, not just "all hyphens" and "all underscores" — the real
  // thread keys are mixed, and the two pure readings miss every one of them.
  const readings = readingsOf(raw);
  const build = (name: string) => (sub ? `${space}/${sub}/${name}` : `${space}/${name}`);
  if (hash) {
    return readings.map(build).find((key) => createHash("sha256").update(key).digest("hex").startsWith(hash));
  }
  // No hash: a bound key settles it exactly. This check runs before the
  // convention because the convention is a heuristic and the binding is
  // evidence — the two disagree for every name an older build wrote with
  // underscores where the live key has hyphens.
  //
  // Compared by *stem*, not by re-sanitizing each candidate: sanitization is
  // many-to-one, so every reading of the same file name sanitizes back to the
  // same stem and all of them "match". Comparing stems is also O(1) instead of
  // 2^n, which matters for the 20-underscore cron names.
  if (known) {
    const bound = known.get(sanitize(build(raw)));
    if (bound) return bound;
  }
  // No hash, no matching binding: trust the convention where one exists,
  // otherwise only a name with nothing to confuse. `known` is stem → key, and
  // the stem is the whole sanitized key from the file name, space prefix
  // included; the exact-match check above is the only place it can settle a tie.
  if (hyphenatedByConvention) return build(readings[0]);
  if (!raw.includes("_")) return build(raw);
  return undefined;
}

/**
 * Every way the `_` in a sanitized name could have been written.
 *
 * Chat thread ids mix `-` and `_` freely (`MKiv-3_kJVwQ`), and the file name
 * cannot tell them apart. 2^n for n underscores, and n is 0-3 for a thread id,
 * so this stays small. Cron/notification names are the exception — a date plus
 * a title reaches 20+ underscores, i.e. a million strings — so past
 * `MAX_READINGS` only the two readings the callers actually use are returned
 * (all-hyphen, then as-written). Nothing is lost: a bound key is compared by
 * stem in `resolve`, and the convention only ever wants the hyphenated form.
 *
 * The hyphenated reading is first, always: `readings[0]` is what the
 * hyphenate-by-convention path returns, and a caller that had to hunt for it
 * got the underscored name whenever enumeration order changed.
 */
const MAX_READINGS = 10;

export function readingsOf(raw: string): string[] {
  const positions = [...raw].flatMap((char, index) => (char === "_" ? [index] : []));
  if (positions.length === 0) return [raw];
  const hyphenated = raw.replace(/_/g, "-");
  if (positions.length > MAX_READINGS) return [hyphenated, raw];
  const out: string[] = [];
  for (let mask = (1 << positions.length) - 1; mask >= 0; mask -= 1) {
    const chars = [...raw];
    positions.forEach((position, bit) => {
      chars[position] = (mask >> bit) & 1 ? "-" : "_";
    });
    out.push(chars.join(""));
  }
  return out;
}

/** The file-name stem a key maps to: `sessionFileFor()`'s sanitization, minus the hash. */
function sanitize(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, "_");
}

export function buildInventory(
  sessionsDir: string,
  logFile: string,
  space?: string,
  /**
   * Every key that has a binding. The authoritative key list — the log only
   * covers threads opened since it started, which is exactly the gap the
   * unhashed files fall into.
   */
  boundKeys: readonly string[] = [],
): {
  entries: Entry[];
  unresolved: string[];
} {
  const fromLog = keyMapFromLog(logFile);
  const entries: Entry[] = [];
  const unresolved: string[] = [];
  // file stem → key, for every key we know exists. Only used to break ties for
  // unhashed files, so a stem two keys share stays unresolved.
  const stems = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const key of [...fromLog.values(), ...boundKeys]) {
    const stem = sanitize(key);
    if (stems.has(stem) && stems.get(stem) !== key) ambiguous.add(stem);
    stems.set(stem, key);
  }
  const known = new Map([...stems].filter(([stem]) => !ambiguous.has(stem)));

  for (const fileName of fs.readdirSync(sessionsDir).filter((name) => name.endsWith(".jsonl")).sort()) {
    const file = path.join(sessionsDir, fileName);
    const logged = fromLog.get(fileName);
    const key = logged ?? deriveKey(fileName, known);
    if (!key) {
      unresolved.push(fileName);
      continue;
    }
    if (space && !key.startsWith(`${space}/`) && key !== space) continue;
    // The transcript, not readLegacyMessages: a full replay also writes the tool
    // rows, so counting only prose would under-report a conversation by up to
    // 677 rows and make "no text to import" wrong for tool-only threads.
    const { messages } = readLegacyTranscript(file);
    const replayable = messages.filter((message) => message.raw || message.text.trim() !== "");
    entries.push({
      key,
      file,
      messages: replayable.length,
      chars: replayable.reduce((total, message) => total + message.text.length, 0),
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
  // A guard rather than a prompt: this runs unattended from a script, and the
  // one thing it must not do is quietly write a multi-million-token history.
  // Measured, not guessed — the tool rows are counted too (see buildInventory).
  const yes = args.includes("--yes");
  const tokenBudget = args.includes("--budget") ? Number(args[args.indexOf("--budget") + 1]) : 500_000;

  const sessionsDir = path.join(process.cwd(), "sessions");
  if (!dbPath) {
    console.error("usage: import-all.ts <db> [--space spaces/XXXX] [--apply] [--log bridge.log]");
    process.exit(2);
  }

  // Read the key list straight from the bindings document, so the dry run stays
  // read-only and still sees every key (not just the ones the log witnessed).
  const knownKeys = boundKeysFrom(dbPath);
  console.error(`[import-all] ${knownKeys.length} bound key(s) read from ${dbPath}`);
  const { entries, unresolved } = buildInventory(sessionsDir, logFile, space, knownKeys);
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

  const estimatedTokens = Math.round(totalChars / 4);
  if (apply && estimatedTokens > tokenBudget && !yes) {
    console.error(
      `\nrefusing to write: ~${estimatedTokens.toLocaleString()} tokens, over the ${tokenBudget.toLocaleString()} budget.\n` +
        "Every later turn in a thread carries this history, so it is paid for per turn,\n" +
        "not once. Narrow it with --space, or re-run with --yes if that is intended.",
    );
    process.exit(3);
  }

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

/**
 * Every Chat key that has a binding, read without opening the harness.
 *
 * `BindingSync`? No: a synchronous read-only SQLite handle is enough and keeps
 * the inventory usable in a dry run against the live database, which the harness
 * would refuse to open (the bridge process owns it).
 */
export function boundKeysFrom(dbPath: string): string[] {
  if (!fs.existsSync(dbPath)) return [];
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    // The bindings document is keyed by kind, and its value is the latest base
    // revision: every write checkpoints (see bindings-doc.ts), so one row holds
    // the whole map.
    const row = db
      .prepare(
        `select content from document_revisions where document_id = (
           select id from documents where record like '%gchat.bindings%'
         ) and kind = 'base' order by seq desc limit 1`,
      )
      .get() as { content?: string } | undefined;
    if (!row?.content) return [];
    const parsed = JSON.parse(row.content) as { byChatKey?: Record<string, unknown> };
    return Object.keys(parsed.byChatKey ?? {});
  } catch {
    // A locked or missing document is not fatal: the log still resolves most
    // files, and the rest are reported rather than imported somewhere wrong.
    return [];
  } finally {
    db?.close();
  }
}

export const TEMP_DB = path.join(os.tmpdir(), "import-all.db");

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("[import-all] failed:", error);
    process.exit(1);
  });
}
