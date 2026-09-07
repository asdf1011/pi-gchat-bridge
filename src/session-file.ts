import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import crypto from "node:crypto";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * Reading and mutating pi SESSION FILES lives only here, so the bridge's
 * assumptions about pi's on-disk JSONL schema are contained in one module.
 *
 * Where pi exports a type/parser we use it: entries are typed as pi's
 * `SessionEntry` (a discriminated union), so narrowing on `type` gives the
 * right fields and a shape change in pi surfaces as a compile error here
 * instead of a silent wrong read.
 */

/** Minimal structural view of pi's assistant message content, since pi doesn't
 *  re-export AgentMessage from the package root. */
export interface PiBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}
export interface PiMessage {
  role: string;
  content?: string | PiBlock[];
}
/** Minimal structural view of pi's image content blocks. */
export interface PiImage {
  type: "image";
  data: string;
  mimeType: string;
}

/** The session-file header pi expects at the top of a new session. */
export const SESSION_HEADER = (cwd: string): string =>
  JSON.stringify({
    type: "session",
    version: 3,
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    cwd,
  });

/**
 * True when the file exists and contains at least one real message entry
 * (synchronous; session files are small). A file with only a header — or no
 * file at all — means the conversation has no content yet.
 */
export function sessionFileHasMessagesSync(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .some((line) => line.trim().length > 0 && line.includes('"type":"message"'));
  } catch {
    return false;
  }
}

/**
 * Seed a NEW conversation's session file with the content of an app-posted
 * notification thread (bridge /notify endpoint). Writes, via pi's own
 * SessionManager so the schema can't drift:
 *   - a user message framing the notification as auto-posted background
 *     (with an optional retrieval hint, e.g. an email id),
 *   - an assistant ack — pi only flushes entries to disk once an assistant
 *     message exists, so this makes the seed durable,
 *   - a session_info title (clean name in pi's session picker).
 * No LLM call. The caller is responsible for only seeding conversations that
 * have no prior content (see sessionFileHasMessagesSync).
 */
export function seedNotificationFile(
  file: string,
  cwd: string,
  text: string,
  opts?: { hint?: string; title?: string },
): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sm = SessionManager.open(file, undefined, cwd);
  const body = [
    "[Background — an automated cron job posted the notification below to this Google Chat thread; you did not write it.",
    "Treat it as what the user is replying to when they message in this thread.]",
    "",
    text,
    ...(opts?.hint ? ["", opts.hint] : []),
  ].join("\n");
  const ts = new Date().toISOString();
  // pi's SessionManager is lenient at runtime (only role/content matter); the
  // declared types additionally require timestamp/api/provider/etc. Cast so the
  // seed stays minimal — pi's own loader tolerates the sparse shape.
  type Appendable = Parameters<SessionManager["appendMessage"]>[0];
  sm.appendMessage(
    {
      role: "user",
      content: [{ type: "text", text: body }],
      timestamp: ts,
    } as unknown as Appendable,
  );
  sm.appendMessage(
    {
      role: "assistant",
      content: [{ type: "text", text: "Noted — the notification above is in context for this thread." }],
      timestamp: ts,
    } as unknown as Appendable,
  );
  if (opts?.title) {
    sm.appendSessionInfo(opts.title.trim().replace(/\s+/g, " ").slice(0, 120));
  }
}

/** Extract plain text from pi message content (string or block array). */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text?: string } => typeof b === "object" && b !== null && "text" in b)
      .map((b) => b.text ?? "")
      .join("");
  }
  return "";
}

/** Collapse whitespace and trim to a display-friendly length. */
export function truncate(text: string, max = 60): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Stream a session file's newline-delimited JSON, invoking `fn` with each
 *  parsed entry. Unparsable lines are skipped, so a partially-written or
 *  corrupted file never aborts the read. `fn` may return `true` to stop early. */
export async function readSessionEntries(file: string, fn: (entry: SessionEntry) => boolean | void): Promise<void> {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry: SessionEntry;
    try {
      entry = JSON.parse(line) as SessionEntry;
    } catch {
      continue; // unparsable line — skip it, don't give up on the file
    }
    if (fn(entry) === true) break;
  }
}

/**
 * Best available display label for a session file, read straight from the
 * JSONL (pi persists all of these):
 *   1. user-set display name (session_info entries, set via /name)
 *   2. compaction summary (pi's LLM-generated summary of the conversation)
 *   3. first user message text
 *   4. fallback: file name (e.g. `spaces_<id>`) — only when the file has
 *      none of the above (e.g. empty/image-only sessions)
 */
export async function summarizeSessionFile(file: string): Promise<string> {
  let name: string | undefined;
  let firstUserText = "";
  let compactionSummary = "";
  try {
    await readSessionEntries(file, (entry) => {
      if (entry.type === "session_info") {
        if (entry.name && entry.name.trim()) name = entry.name.trim();
      } else if (entry.type === "message" && entry.message.role === "user" && !firstUserText) {
        firstUserText = contentText(entry.message.content).trim();
      } else if (entry.type === "compaction" && entry.summary.trim() && !compactionSummary) {
        compactionSummary = entry.summary.trim();
      }
      return !!(name && firstUserText && compactionSummary); // all sources found, stop early
    });
  } catch {
    // unreadable file — fall through to the file-name fallback
  }
  return (
    name ??
    (compactionSummary ? truncate(compactionSummary) :
      firstUserText ? truncate(firstUserText) :
      path.basename(file, ".jsonl"))
  );
}

/** Latest `model_change` entry's provider/modelId (pi appends chronologically). */
export async function readLastModelIds(file: string): Promise<{ provider: string; modelId: string } | undefined> {
  let provider: string | undefined;
  let modelId: string | undefined;
  try {
    await readSessionEntries(file, (entry) => {
      if (entry.type === "model_change" && entry.provider && entry.modelId) {
        // Later entries overwrite earlier ones (pi appends chronologically).
        provider = entry.provider;
        modelId = entry.modelId;
      }
      return false;
    });
  } catch {
    // unreadable file
  }
  return provider && modelId ? { provider, modelId } : undefined;
}

/** Latest `session_info` display name (set via /name), or undefined when unset. */
export async function readLatestDisplayName(file: string): Promise<string | undefined> {
  let name: string | undefined;
  try {
    await readSessionEntries(file, (entry) => {
      // Later session_info entries overwrite earlier ones (pi does the same).
      if (entry.type === "session_info" && typeof entry.name === "string") {
        name = entry.name.trim() || undefined;
      }
      return false;
    });
  } catch {
    // unreadable file
  }
  return name;
}

/**
 * Rewrite a session file, dropping trailing turns whose assistant message never
 * completed (has unanswered toolCall blocks). So a re-open after a watchdog
 * reset doesn't re-run the hung tool call. Returns the number of entries
 * dropped, 0 if already clean.
 */
export function truncateIncompleteTail(file: string | undefined): number {
  if (!file || !fs.existsSync(file)) return 0;
  const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0);
  let lastCompleted = -1;
  for (let i = 0; i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i]) as SessionEntry;
      if (entry.type !== "message") continue;
      // A completed assistant turn is one that isn't waiting on a tool call.
      if (entry.message.role === "assistant" && !(entry.message.content ?? []).some((b) => b.type === "toolCall")) {
        lastCompleted = i;
      }
    } catch {
      // Unparsable line — leave the file untouched rather than risk damage.
      return 0;
    }
  }
  if (lastCompleted < 0) return 0;
  const dropped = lines.length - lastCompleted - 1;
  if (dropped > 0) {
    fs.writeFileSync(file, lines.slice(0, lastCompleted + 1).join("\n") + "\n");
  }
  return dropped;
}
