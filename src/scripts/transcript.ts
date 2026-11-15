/**
 * Full-text search over archived conversations.
 *
 * The bridge's store (`bridge.sqlite`) is append-only, owned by exactly one process, and rotated
 * with a WAL beside it. Adding an FTS index inside it would put a second writer on the file the
 * lock exists to protect — so the index lives in its own database and the store is only ever read.
 *
 * Three things make this cheap enough to run on every query:
 *
 *   - `entries.id` is monotonic, so catching up is a tail: index `id > high water mark`, usually a
 *     handful of rows. A stale index is not a state anyone has to remember to fix.
 *   - SQLite's FTS5 is compiled into `node:sqlite` here, so there is no native module to build.
 *   - The index is disposable. Delete the file and the next query rebuilds it; nothing anywhere
 *     depends on it existing.
 *
 * The store is attached read-only. A search never writes to `bridge.sqlite`, and a search run
 * while the bridge is mid-turn sees a consistent snapshot rather than an error.
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Entry kinds, in the vocabulary the store uses. */
export const ENTRY_KINDS = [
  "pi.user",
  "pi.assistant",
  "pi.tool-result",
  "pi.system",
  "pi.compaction",
  "app.notice",
] as const;

/**
 * Tool results are ~39% of all entries and the noisiest part of the corpus, so they are indexed
 * but kept out of an unfiltered search. `--kind tool-result` asks for them by name.
 */
export const DEFAULT_EXCLUDED_KINDS: readonly string[] = ["pi.tool-result"];

/** Bumped when the flattened text or the schema changes, so an old index rebuilds itself. */
export const INDEX_VERSION = 2;

export interface Hit {
  entryId: number;
  conversationId: number;
  kind: string;
  at: number;
  /** Prose from the entry, with the matched terms bracketed. Never tool-call JSON. */
  snippet: string;
  /** `user` or `assistant`, when the entry says. Absent rather than guessed. */
  role?: string;
  /** The surface that produced it — `gchat`, `webui`, `cron`. Absent when never stamped. */
  origin?: string;
}

export interface SearchOptions {
  query: string;
  /** Restrict to one conversation. */
  conversationId?: number;
  /** If given, *only* these kinds. Overrides the default exclusion. */
  kinds?: readonly string[];
  limit?: number;
  maxStalenessSeconds?: number;
}

/** One conversation's share of a search: which threads are actually about this. */
export interface ConversationCount {
  conversationId: number;
  /** Entries that matched. */
  matches: number;
  /** Of those, how many were tool results and so hidden from a default search. */
  toolResults: number;
  /** Newest matching entry, so a list can be ordered by recency when counts tie. */
  at: number;
}

export interface CountOptions {
  query: string;
  kinds?: readonly string[];
  limit?: number;
  maxStalenessSeconds?: number;
}

/**
 * How stale an answer may be, in seconds. `0` means "never stale" — tail before searching.
 *
 * This is a promise the *caller* makes about the result, not a switch for how the index is
 * maintained, which is why it replaced a `--stale-ok` flag: a caller should not have to know
 * whether an import is due. `agentic_search` passes a few seconds and never waits on a writer;
 * a person at a terminal leaves it at 0.
 *
 * It gates *whether* a required import must happen now. It never causes one that is not
 * required — an index already at the source's newest entry takes no lock at any setting.
 */
export interface ReadOptions {
  maxStalenessSeconds?: number;
}

export interface IndexStats {
  indexed: number;
  /** True when the answer may be missing entries the store already has. */
  stale: boolean;
  /** Milliseconds since the index last caught up. `undefined` when it never has. */
  ageMs?: number;
  /** Rows examined to catch up, whether or not they had text. */
  examined: number;
  highWaterMark: number;
  ms: number;
}

export interface SearchDeps {
  /** The bridge's store. Read-only: never written by this tool. */
  storePath: string;
  /** Where the FTS index lives. Defaults to a sibling of the store. */
  indexPath?: string;
  out?(line: string): void;
}

export function defaultIndexPath(storePath: string): string {
  return path.join(
    path.dirname(storePath),
    `${path.basename(storePath, path.extname(storePath))}-search.sqlite`,
  );
}

/**
 * The index's schema, as one statement set.
 *
 * Exported so a test can build an index without copying it: the copy in the test drifted the
 * moment a column was added here, and failed with "no column named display_text" rather than
 * with anything about the change.
 */
export const SCHEMA = `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value ANY) STRICT;

  CREATE VIRTUAL TABLE transcript USING fts5(
    text,
    entry_id UNINDEXED,
    conversation_id UNINDEXED,
    kind UNINDEXED,
    at UNINDEXED,
    display_text UNINDEXED,
    role UNINDEXED,
    origin UNINDEXED,
    tokenize = 'unicode61'
  );
`;

/**
 * Flatten one entry record into the text a search should see.
 *
 * Everything a person would call "what was said": prompts and replies, the model's thinking, a
 * tool call's name and arguments, and a tool's output. The record wraps one entry as
 * `{ kind, model: [{ role, content }] }`, where content is a string or an array of blocks.
 */
export function flattenRecord(record: string): string {
  return collectParts(record, { prose: false }).parts.join("\n");
}

/**
 * Walk an entry's content blocks once, collecting text for matching and for display.
 *
 * One walk rather than two, because the two must agree about what an entry *is*: the fields a
 * hit shows and the text it matched are both properties of the same content, and a second
 * parser is a second chance to disagree about a `content` shape.
 *
 * `prose` selects the strict reading used for snippets — see `displayText`.
 */
function collectParts(
  record: string,
  options: { prose: boolean },
): { parts: string[]; toolNames: string[] } {
  const parts: string[] = [];
  const toolNames: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(record);
  } catch {
    return { parts, toolNames };
  }
  const model = (parsed as { model?: unknown }).model;
  if (!Array.isArray(model)) return { parts, toolNames };

  for (const message of model as { content?: unknown }[]) {
    const content = message?.content;
    if (typeof content === "string") {
      if (content !== "") parts.push(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content as Record<string, unknown>[]) {
      if (block === null || typeof block !== "object") continue;
      switch (block.type) {
        case "text":
          if (typeof block.text === "string" && block.text !== "") parts.push(block.text);
          break;
        case "thinking":
          if (typeof block.thinking === "string" && block.thinking !== "") parts.push(block.thinking);
          break;
        case "toolCall": {
          if (typeof block.name !== "string") break;
          if (options.prose) {
            toolNames.push(block.name);
            break;
          }
          parts.push(block.name);
          const args = block.arguments;
          if (typeof args === "string") parts.push(args);
          else if (args !== undefined) parts.push(JSON.stringify(args));
          break;
        }
        default:
          break;
      }
    }
  }
  return { parts, toolNames };
}

/**
 * The part of an entry a *person* wrote or read, for showing beside a hit.
 *
 * `flattenRecord` is for matching: it includes tool names, arguments and outputs, because a
 * search for `ofxsync` should find the command that ran it. A snippet drawn from that text is
 * often a wall of JSON — the first search this tool did returned eight lines of
 * `bash {"command":"cd /workspace/..."}` — so the snippet comes from here instead, while the
 * match still comes from there.
 *
 * Prose is: a string content, `text` blocks, and `thinking` blocks (both are words somebody
 * said, and a decision often appears in reasoning before it appears in a reply). A tool call
 * contributes nothing but its name, and only when it has no text beside it — enough for the
 * snippet to say *what* happened when the entry is nothing but a tool call.
 */
export function displayText(record: string): string {
  const { parts, toolNames } = collectParts(record, { prose: true });
  if (parts.length > 0) return parts.join("\n");
  // Nothing was said, so the entry *is* a tool call. Its name alone ("bash") orients nobody —
  // the first version showed five hits whose entire snippet was the word `bash` — so the
  // command goes in too, stripped of its JSON envelope. This is the one place tool arguments
  // are allowed into a snippet, because there is no prose for them to displace.
  const { commands } = collectCommands(record);
  return commands.length > 0 ? commands.join("\n") : toolNames.join("\n");
}

/**
 * A tool call's own words: the command for `bash`, the path for `read`, and so on.
 *
 * Chosen from the arguments by key rather than by dumping them, so the snippet reads as the
 * action instead of as a serialised object. Unknown tools contribute their name only.
 */
export function collectCommands(record: string): { commands: string[] } {
  const commands: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(record);
  } catch {
    return { commands };
  }
  const model = (parsed as { model?: unknown }).model;
  if (!Array.isArray(model)) return { commands };
  for (const message of model as { content?: unknown }[]) {
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Record<string, unknown>[]) {
      if (block?.type !== "toolCall") continue;
      const name = typeof block.name === "string" ? block.name : "";
      const args = block.arguments as Record<string, unknown> | string | undefined;
      const object = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : undefined;
      const pick = (key: string): string | undefined =>
        typeof object?.[key] === "string" ? (object[key] as string) : undefined;
      const detail =
        pick("command") ?? pick("file_path") ?? pick("path") ?? pick("pattern") ?? pick("url");
      commands.push(detail === undefined ? name : `${name} ${detail}`.trim());
    }
  }
  return { commands };
}

/** The roles present in an entry, for a hit's `role` field. */
export function roleOf(record: string): string | undefined {
  try {
    const model = (JSON.parse(record) as { model?: unknown }).model;
    if (!Array.isArray(model)) return undefined;
    for (const message of model as { role?: unknown }[]) {
      if (typeof message?.role === "string" && message.role !== "") return message.role;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** The timestamp an entry carries, in ms, or 0 when the record has none. */
function timestampOf(record: string): number {
  try {
    const parsed = JSON.parse(record) as { model?: { timestamp?: unknown }[] };
    const value = parsed.model?.[0]?.timestamp;
    return typeof value === "number" ? value : 0;
  } catch {
    return 0;
  }
}

/**
 * How long a connection waits for another writer before giving up.
 *
 * SQLite's default is zero: the loser of a race gets `SQLITE_BUSY` immediately. Two searches
 * started at once — or a search while a `--reindex` is running — hit that, and the failure reads
 * as "no results" to anything that only looks at stdout. Five seconds is longer than the catch-up
 * write ever takes and short enough that a genuinely stuck writer still fails instead of hanging.
 */
const BUSY_TIMEOUT_MS = 5_000;

/**
 * Open (or create) the index database.
 *
 * This always opens writable, and that is fine: opening a WAL database does not take the writer
 * lock, only writing does. `bringUpToDate` settles whether there is anything to write before any
 * statement that would need one.
 */
function openIndex(indexPath: string): DatabaseSync {
  const exists = fs.existsSync(indexPath);
  const db = new DatabaseSync(indexPath);
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  if (!exists) {
    // WAL is a property of the file, so it is only worth setting once.
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(SCHEMA);
    db.prepare("INSERT INTO meta (key, value) VALUES ('version', ?)").run(INDEX_VERSION);
    return db;
  }
  const version = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as
    | { value?: unknown }
    | undefined;
  if (version?.value !== INDEX_VERSION) {
    // Schema or flattening changed: the index is derived data, so start over.
    db.exec("DROP TABLE IF EXISTS transcript");
    db.exec("DROP TABLE IF EXISTS meta");
    db.exec(SCHEMA);
    db.prepare("INSERT INTO meta (key, value) VALUES ('version', ?)").run(INDEX_VERSION);
  }
  return db;
}

function readWaterMark(db: DatabaseSync): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'watermark'").get() as
    | { value?: unknown }
    | undefined;
  return typeof row?.value === "number" ? row.value : 0;
}

/**
 * Index everything appended since the last run.
 *
 * `entries.id` is monotonic, so this is a tail and not a diff: no deletion handling, no hashing.
 * Entries with no searchable text (an empty system prompt, say) still advance the watermark, so
 * they are examined once and never again.
 */
export function catchUp(store: DatabaseSync, index: DatabaseSync): IndexStats {
  const started = Date.now();
  const watermark = readWaterMark(index);
  const rows = store
    .prepare("SELECT id, conversation_id, record FROM entries WHERE id > ? ORDER BY id")
    .all(watermark) as { id: number; conversation_id: number; record: string }[];

  const insert = index.prepare(
    "INSERT INTO transcript (text, entry_id, conversation_id, kind, at, display_text, role, origin) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  // The origin stamp is not on the entry: it lives in the durable store's `gchat.origins`
  // documents, one per conversation, newest revision is a base holding the whole map. Read it
  // once per catch-up and index the result, so a hit can say which surface said it without a
  // second database and a join on every query. Absent for anything older than the stamps
  // themselves or pruned since — `undefined`, never a guess.
  const origins = readOrigins(store);

  let indexed = 0;
  let highWaterMark = watermark;
  index.exec("BEGIN");
  try {
    for (const row of rows) {
      highWaterMark = Math.max(highWaterMark, row.id);
      const text = flattenRecord(row.record);
      if (text === "") continue;
      const kind = kindOf(row.record) ?? "";
      insert.run(
        text,
        row.id,
        row.conversation_id,
        kind,
        timestampOf(row.record),
        displayText(row.record),
        roleOf(row.record) ?? "",
        origins.get(`${row.conversation_id}:${row.id}`) ?? "",
      );
      indexed += 1;
    }
    index
      .prepare("INSERT INTO meta (key, value) VALUES ('watermark', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(highWaterMark);
    // When the index last caught up, so a later read can decide whether it may skip the tail
    // without consulting the source at all.
    index
      .prepare("INSERT INTO meta (key, value) VALUES ('imported_at', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(Date.now());
    index.exec("COMMIT");
  } catch (error) {
    index.exec("ROLLBACK");
    throw error;
  }

  return { indexed, examined: rows.length, highWaterMark, stale: false, ms: Date.now() - started };
}

/**
 * Every origin stamp in the store, keyed `"<conversationId>:<entryId>"`.
 *
 * One document per conversation (`gchat.origins`, conversation scope), each holding the whole
 * map for its owner — so there is no newest-revision-per-entry work, just the latest revision of
 * each document. A store written before the split has no such documents and this returns
 * nothing; a conversation whose document is missing reads as unknown, which is what a reader
 * must assume anyway.
 *
 * Best-effort: this is a convenience for a hit's label, and a store it cannot read must not
 * stop an index being built.
 */
export function readOrigins(store: DatabaseSync): Map<string, string> {
  const origins = new Map<string, string>();
  let docs: { id: number; owner_id: number }[];
  try {
    docs = store
      .prepare(
        `SELECT id, owner_id FROM documents
          WHERE kind = ? AND scope_kind = 'conversation' AND retired_at IS NULL`,
      )
      .all('"gchat.origins"') as { id: number; owner_id: number }[];
  } catch {
    return origins;
  }
  const latest = store.prepare(
    "SELECT content FROM document_revisions WHERE document_id = ? ORDER BY seq DESC LIMIT 1",
  );
  for (const doc of docs) {
    try {
      const row = latest.get(doc.id) as { content?: string } | undefined;
      if (row?.content === undefined) continue;
      const byEntry = (JSON.parse(row.content) as { byEntry?: Record<string, { origin?: unknown }> })
        .byEntry;
      if (byEntry === undefined || byEntry === null) continue;
      for (const [entryId, stamp] of Object.entries(byEntry)) {
        const origin = stamp?.origin;
        if (typeof origin !== "string" || origin === "") continue;
        origins.set(`${doc.owner_id}:${entryId}`, origin);
      }
    } catch {
      continue;
    }
  }
  return origins;
}

function kindOf(record: string): string | undefined {
  try {
    const kind = (JSON.parse(record) as { kind?: unknown }).kind;
    return typeof kind === "string" ? kind : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A snippet of prose, with the query's words bracketed.
 *
 * The words come from the query rather than from the index, because the index's own
 * highlighter runs on the column that matched — which is the tool-arguments one. Splitting the
 * query on whitespace and matching case-insensitively is coarser than FTS tokenisation (it does
 * not stem, so `quantiz` highlights `quantiz` but not `quantization`), and that is the right
 * trade: the snippet exists to orient a reader, and the search itself already decided the row
 * matched.
 *
 * No match in the prose is a normal outcome — the term was in a tool call — and the snippet then
 * shows the entry's first words unmarked. That is more honest than pretending the entry is
 * about the term.
 */
export function proseSnippet(displayText: string, query: string, width = 220): string {
  const flat = displayText.replace(/\s+/g, " ").trim();
  if (flat === "") return "";
  // Words of one or two characters are dropped: the query is split on whitespace, so "a" in a
  // phrase brackets every `a` in the entry — the first version produced
  // `[Testing] [a] [web] [message]` — and FTS would not have matched them as words anyway.
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.replace(/^["']|["']$/g, "").replace(/\*$/, ""))
    .filter((term) => term.length >= 3);

  // Centre the window on the first match, so a hit in a long entry is not a snippet of its
  // opening paragraph.
  const lower = flat.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found !== -1 && (at === -1 || found < at)) at = found;
  }
  const start = at <= width / 3 ? 0 : Math.max(0, at - Math.floor(width / 3));
  const window = flat.slice(start, start + width);
  const body = `${start > 0 ? "…" : ""}${window}${start + width < flat.length ? "…" : ""}`;

  // Brackets around the terms, assembled from matches rather than by replacing in place, so a
  // term that appears inside an earlier replacement cannot be bracketed twice.
  const pattern = terms
    .filter((term) => term !== "")
    .sort((a, b) => b.length - a.length)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  if (pattern === "") return body;
  return body.replace(new RegExp(`(${pattern})`, "gi"), "[$1]");
}

/** One row as the index hands it back. */
interface HitRow {
  entry_id: number;
  conversation_id: number;
  kind: string;
  at: number;
  display_text: string;
  role: string;
  origin: string;
}

/** One row of a per-conversation count. */
interface CountRow {
  conversation_id: number;
  matches: number;
  tool_results: number | null;
  at: number | null;
}

/**
 * Turn what a person typed into an FTS5 query.
 *
 * FTS5 has its own grammar: a bare `AND`/`NEAR` is syntax, a hyphen is `NOT`, and an unbalanced
 * quote is a hard error. Someone searching for `pi-durable` means the word, not a minus. So each
 * whitespace-separated term is quoted unless it is already quoted by the caller, and a trailing
 * `*` (prefix search) is kept outside the quotes where FTS5 can see it.
 */
export function toFtsQuery(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "") return "";
  const terms = trimmed.match(/"[^"]*"|\S+/g) ?? [];
  const pieces: string[] = [];
  for (const term of terms) {
    if (term.startsWith('"') && term.endsWith('"') && term.length >= 2) {
      const inner = term.slice(1, -1).replace(/"/g, '""');
      if (inner.trim() !== "") pieces.push(`"${inner}"`);
      continue;
    }
    const prefix = term.endsWith("*");
    const word = prefix ? term.slice(0, -1) : term;
    if (word === "") continue;
    pieces.push(prefix ? `"${word.replace(/"/g, '""')}"*` : `"${word.replace(/"/g, '""')}"`);
  }
  // Every term required: a person typing three words wants the ones that have all three.
  return pieces.join(" AND ");
}

/**
 * The WHERE clause a search and a count share.
 *
 * Returns placeholders and params in matching order, so each caller can append its own `LIMIT ?`
 * and its own projection without either one re-deriving the filter rules. `visibleOnly` is what
 * separates "give me hits" (default: no tool results) from "tell me where the words are" (which
 * has to count them, or a conversation whose matches are all command output reads as a miss).
 */
function buildFilter(
  match: string,
  options: { conversationId?: number; kinds?: readonly string[]; visibleOnly: boolean },
): { conjunction: string; params: (string | number)[] } {
  const kinds = options.kinds;
  const where: string[] = ["transcript MATCH ?"];
  const params: (string | number)[] = [match];
  if (options.conversationId !== undefined) {
    where.push("conversation_id = ?");
    params.push(options.conversationId);
  }
  if (kinds !== undefined && kinds.length > 0) {
    where.push(`kind IN (${kinds.map(() => "?").join(", ")})`);
    params.push(...kinds);
  }
  if (options.visibleOnly && kinds === undefined) {
    for (const kind of DEFAULT_EXCLUDED_KINDS) {
      where.push("kind != ?");
      params.push(kind);
    }
  }
  return { conjunction: where.join(" AND "), params };
}

/** The newest entry id in the store, or 0 for an empty one. */
function sourceHighWaterMark(storePath: string): number {
  const store = new DatabaseSync(storePath, { readOnly: true });
  try {
    const row = store.prepare("SELECT max(id) AS id FROM entries").get() as
      | { id?: number | null }
      | undefined;
    return typeof row?.id === "number" ? row.id : 0;
  } finally {
    store.close();
  }
}

/**
 * Bring the index up to date — but only when something is actually missing, and only when the
 * caller has not said it is happy to be behind.
 *
 * The order matters, and it is the whole point of this function:
 *
 *   1. Does the source hold anything the index does not? A `max(id)` read costs ~1 ms, so this
 *      is settled without touching the index's write lock. **If nothing is missing, no lock is
 *      taken at any staleness setting** — that is the common case for a repeated search.
 *   2. If something *is* missing, the caller's `maxStalenessSeconds` decides whether to import
 *      now or answer from what is there. A required import may be deferred; it is never skipped
 *      by the probe, because the probe only reads.
 *
 * Deferring is also what a busy index falls back to: `SQLITE_BUSY` after `busy_timeout` becomes
 * a stale answer plus `stats.stale`, rather than an error that reads as "no results".
 */
function bringUpToDate(
  index: DatabaseSync,
  storePath: string,
  maxStalenessSeconds: number,
): IndexStats {
  const started = Date.now();
  const watermark = readWaterMark(index);
  const newest = sourceHighWaterMark(storePath);
  const importedAt = readImportedAt(index);
  const ageMs = importedAt === undefined ? undefined : Date.now() - importedAt;

  const upToDate = (stale: boolean): IndexStats => ({
    indexed: 0,
    examined: 0,
    highWaterMark: watermark,
    stale,
    ...(ageMs === undefined ? {} : { ageMs }),
    ms: Date.now() - started,
  });

  // 1. Nothing to import. No writer, no lock, whatever the caller allowed.
  if (newest <= watermark) return upToDate(false);

  // 2. Something to import: does the caller need it now?
  if (maxStalenessSeconds > 0 && ageMs !== undefined && ageMs <= maxStalenessSeconds * 1000) {
    return upToDate(true);
  }

  return catchUpSafely(storePath, index, watermark, ageMs);
}

/** Run the tail, degrading to a stale answer rather than failing when the index is busy. */
function catchUpSafely(
  storePath: string,
  index: DatabaseSync,
  watermark: number,
  ageMs: number | undefined,
): IndexStats {
  const store = new DatabaseSync(storePath, { readOnly: true });
  try {
    const stats = catchUp(store, index);
    return { ...stats, stale: false, ...(ageMs === undefined ? {} : { ageMs }) };
  } catch (error) {
    if (!/SQLITE_BUSY|database is locked/i.test((error as Error).message)) throw error;
    // Somebody else is writing the index. A slightly old answer beats an exception that a
    // caller reads as an empty result set.
    return { indexed: 0, examined: 0, highWaterMark: watermark, stale: true, ...(ageMs === undefined ? {} : { ageMs }), ms: 0 };
  } finally {
    store.close();
  }
}

/** When the index last caught up, in ms since the epoch. */
function readImportedAt(db: DatabaseSync): number | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'imported_at'").get() as
    | { value?: unknown }
    | undefined;
  return typeof row?.value === "number" ? row.value : undefined;
}

/** Search the index./** Search the index. The index is brought up to date first, so results are never stale. */
export function search(deps: SearchDeps, options: SearchOptions): { hits: Hit[]; stats: IndexStats } {
  const indexPath = deps.indexPath ?? defaultIndexPath(deps.storePath);
  if (!fs.existsSync(deps.storePath)) {
    throw new Error(`no store at ${deps.storePath} — is BRIDGE_DB set?`);
  }
  const maxStalenessSeconds = options.maxStalenessSeconds ?? 0;
  const index = openIndex(indexPath);
  let stats: IndexStats;
  try {
    stats = bringUpToDate(index, deps.storePath, maxStalenessSeconds);

    const match = toFtsQuery(options.query);
    if (match === "") return { hits: [], stats };

    // `=` first: with a single term on a small index it is enough on its own. If that single
    // term is common (every entry here mentions `sqlite`), the join into the rows is what costs,
    // and `=*` asks SQLite for a plan that has already measured those rows.
    const { conjunction, params } = buildFilter(match, {
      ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
      ...(options.kinds === undefined ? {} : { kinds: options.kinds }),
      visibleOnly: true,
    });
    const withLimit = [...params, Math.max(1, options.limit ?? 20)];

    // `snippet()` only reads an FTS column, and the column it would read (`text`) is the one
    // full of tool arguments. So the matched row is selected whole and the snippet is drawn
    // from `display_text` afterwards — see `proseSnippet`. `text` still decides *which* rows
    // match, which is the whole point: a hit for `ofxsync` finds the command even though the
    // snippet shows prose.
    const select = `SELECT entry_id, conversation_id, kind, at, display_text, role, origin
                    FROM transcript
                    WHERE `;
    const tail = " ORDER BY bm25(transcript), entry_id DESC LIMIT ?";

    let rows = index.prepare(`${select}${conjunction}${tail}`).all(...withLimit) as unknown as HitRow[];
    if (rows.length === 0) {
      rows = index
        .prepare(`${select}(${conjunction})${tail}`)
        .all(...withLimit) as unknown as HitRow[];
    }

    return {
      hits: rows.map((row) => ({
        entryId: row.entry_id,
        conversationId: row.conversation_id,
        kind: row.kind,
        at: row.at,
        snippet: proseSnippet(row.display_text, options.query),
        ...(row.role === "" ? {} : { role: row.role }),
        ...(row.origin === "" ? {} : { origin: row.origin }),
      })),
      stats,
    };
  } finally {
    index.close();
  }
}

/**
 * Which conversations a query is about, most-matching first.
 *
 * A ranked snippet list answers "what was said", which is the wrong shape for "where is this
 * discussed": one long conversation can flood the top ten with its code, while the thread actually
 * about the subject sits at eleven. Counting per conversation answers the question in one query.
 *
 * Tool results are counted, not filtered — with a filter, a conversation whose every match is
 * command output reads as a miss, and that is exactly the "was this ever discussed" question the
 * mode exists for. `toolResults` reports how much of the count is hidden from a normal search.
 */
export function countByConversation(
  deps: SearchDeps,
  options: CountOptions,
): { conversations: ConversationCount[]; stats: IndexStats } {
  const indexPath = deps.indexPath ?? defaultIndexPath(deps.storePath);
  if (!fs.existsSync(deps.storePath)) {
    throw new Error(`no store at ${deps.storePath} — is BRIDGE_DB set?`);
  }
  const maxStalenessSeconds = options.maxStalenessSeconds ?? 0;
  const index = openIndex(indexPath);
  try {
    const stats = bringUpToDate(index, deps.storePath, maxStalenessSeconds);

    const match = toFtsQuery(options.query);
    if (match === "") return { conversations: [], stats };

    const { conjunction, params } = buildFilter(match, {
      ...(options.kinds === undefined ? {} : { kinds: options.kinds }),
      visibleOnly: false,
    });
    const withLimit = [...params, Math.max(1, options.limit ?? 20)];

    const sql = `SELECT conversation_id,
                        count(*) AS matches,
                        sum(CASE WHEN kind = '${DEFAULT_EXCLUDED_KINDS[0]}' THEN 1 ELSE 0 END) AS tool_results,
                        max(at) AS at
                 FROM transcript
                 WHERE ${conjunction}
                 GROUP BY conversation_id`;
    const ordered = " ORDER BY matches DESC, at DESC LIMIT ?";

    let rows = index.prepare(`${sql}${ordered}`).all(...withLimit) as unknown as CountRow[];
    if (rows.length === 0) {
      rows = index
        .prepare(`${sql.replace(`WHERE ${conjunction}`, `WHERE (${conjunction})`)}${ordered}`)
        .all(...withLimit) as unknown as CountRow[];
    }

    return {
      conversations: rows.map((row) => ({
        conversationId: row.conversation_id,
        matches: row.matches,
        toolResults: row.tool_results ?? 0,
        at: row.at ?? 0,
      })),
      stats,
    };
  } finally {
    index.close();
  }
}

/** Drop the index. The next search rebuilds it from scratch. */
export function reindex(deps: SearchDeps): number {
  const indexPath = deps.indexPath ?? defaultIndexPath(deps.storePath);
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(`${indexPath}${suffix}`, { force: true });
  }
  return indexPath.length;
}

/**
 * One line describing what the read did.
 *
 * Staleness is printed whenever it is true, not only in an opt-in mode: "why is the entry I
 * just wrote not in the results" should be answerable from the command that omitted it.
 */
function statsLine(stats: IndexStats): string {
  const age = stats.ageMs === undefined ? "never" : `${Math.round(stats.ageMs / 1000)}s ago`;
  const head = `# +${stats.indexed} indexed, ${stats.examined} examined, ${stats.ms} ms`;
  if (!stats.stale) return `${head}; good up to entry ${stats.highWaterMark} (imported ${age})`;
  return (
    `${head}; STALE — missing entries since entry ${stats.highWaterMark} (imported ${age}). ` +
    "Retry with a lower --max-stale, or --max-stale 0"
  );
}

/**
 * The URL of one message, for quoting a hit to somebody who can click it.
 *
 * `/<conversationId>/#e<entryId>` — the page's own shape, plus the entry anchor it now honours.
 * The origin comes from `BRIDGE_WEB_ORIGIN`, because this tool runs beside the bridge and the
 * bridge already knows where it is served from; guessing `pi.hl.id.au` here would break the day
 * the deployment moves, and a link built from the database path would be worse than none.
 *
 * No entry id means the conversation, not a broken string: a hit that cannot be anchored is
 * still a hit worth linking.
 */
export function entryLink(
  conversationId: number,
  entryId: number | undefined,
  origin: string = process.env.BRIDGE_WEB_ORIGIN ?? "",
): string {
  const base = origin.replace(/\/+$/, "");
  // A deployment with no web origin has no pages to link to, and inventing a host would send a
  // reader somewhere that does not exist. Empty, and the formatter omits the line.
  if (base === "") return "";
  return `${base}/${conversationId}/${entryId === undefined ? "" : `#e${entryId}`}`;
}

/**
 * What a conversation is called, by id, from the bindings document.
 *
 * The binding carries `label` (a generated title) and `preview` (the opening words, recorded once
 * so the index has something to show before a title exists). A conversation the bindings do not
 * describe — a web conversation created and never spoken in, or one whose binding predates the
 * field — is simply absent, and the caller falls back to the id rather than inventing a name.
 *
 * Read once per run, not per hit: it is one document and every hit asks the same question.
 */
export function readConversationNames(store: DatabaseSync): Map<number, string> {
  const names = new Map<number, string>();
  let doc: { id: number } | undefined;
  try {
    doc = store
      .prepare(
        `SELECT id FROM documents
          WHERE kind = ? AND scope_kind = 'session' AND retired_at IS NULL
          ORDER BY id DESC LIMIT 1`,
      )
      .get('"gchat.bindings"') as { id: number } | undefined;
  } catch {
    return names;
  }
  if (doc === undefined) return names;
  try {
    const row = store
      .prepare("SELECT content FROM document_revisions WHERE document_id = ? ORDER BY seq DESC LIMIT 1")
      .get(doc.id) as { content?: string } | undefined;
    if (row?.content === undefined) return names;
    // The stored field is `name`; `label` is only the *adapter-facing* name for it
    // (`NamedConversation.label` is built from `binding.name` in inprocess.ts). Reading `label`
    // here read a field the document does not have, so every titled conversation came back
    // nameless while its title sat one property away.
    const byChatKey = (JSON.parse(row.content) as {
      byChatKey?: Record<string, { conversationId?: unknown; name?: unknown; preview?: unknown }>;
    }).byChatKey;
    if (byChatKey === undefined || byChatKey === null) return names;
    for (const binding of Object.values(byChatKey)) {
      const id = binding?.conversationId;
      if (typeof id !== "number") continue;
      // The title first: a name is what somebody (or the titler) decided the thread is about,
      // and the preview is only its opening words. Fall back in that order, never both.
      const title = typeof binding.name === "string" && binding.name.trim() !== "" ? binding.name : undefined;
      const preview =
        typeof binding.preview === "string" && binding.preview.trim() !== "" ? binding.preview : undefined;
      const name = title ?? preview;
      if (name !== undefined) names.set(id, shorten(name.replace(/\s+/g, " ").trim()));
    }
  } catch {
    // An unreadable document costs a nicer label, nothing else.
  }
  return names;
}

/**
 * A name short enough to sit inside a link label.
 *
 * A generated title is already short; a *preview* is the opening words of the first message and can
 * run to fifteen — "I have accounts at several institutions. Chase, Schwab, Capital One, Wells
 * Fargo, interactive brokers, Morgan…" is a paragraph disguised as a name. Cut at a word boundary
 * rather than mid-word, because a truncated name should still read as a phrase.
 */
export function shorten(name: string, limit = 48): string {
  // A stored "title" is sometimes the opening heading of the first reply — six of 165 in the live
  // store are `## Short answer`, `## The setup`. The hashes are Markdown, not part of the name, and
  // inside a link label they read as a mistake.
  name = name.replace(/^#{1,6}\s+/, "").trim();
  if (name.length <= limit) return name;
  const cut = name.slice(0, limit);
  const space = cut.lastIndexOf(" ");
  return `${(space > limit / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:—-]+$/, "")}…`;
}

/**
 * A clock time a reader can place: "yesterday at 6:05pm", "3 days ago", "2026-11-09 07:56".
 *
 * Relative for anything within a week, because that is the window where "yesterday" is more use
 * than a date; absolute beyond it, because "43 days ago" is a number nobody converts. The relative
 * forms are computed in UTC from the message's own timestamp, so the phrase is a property of the
 * message rather than of when this tool happens to run — the same hit labelled twice says the same
 * thing, which matters because these labels get pasted into conversations.
 *
 * Deliberately no timezone conversion: the store records UTC, the CLI prints UTC elsewhere, and
 * silently rendering local time would make the label disagree with the timestamp beside it.
 */
export function describeTime(at: number, now: number = Date.now()): string {
  if (at <= 0) return "";
  const stamp = new Date(at);
  const hhmm = `${String(stamp.getUTCHours()).padStart(2, "0")}:${String(stamp.getUTCMinutes()).padStart(2, "0")}`;
  const clock = () => {
    const hour = stamp.getUTCHours();
    const suffix = hour < 12 ? "am" : "pm";
    const twelve = hour % 12 === 0 ? 12 : hour % 12;
    return `${twelve}:${String(stamp.getUTCMinutes()).padStart(2, "0")}${suffix}`;
  };
  // Whole days between the two, by calendar date rather than by elapsed seconds: 23:50 then 00:10
  // is "yesterday" to a reader even though it is twenty minutes.
  const dayOf = (value: Date) => Math.floor(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()) / 86_400_000);
  const days = dayOf(new Date(now)) - dayOf(stamp);
  if (days < 0) return `${stamp.toISOString().slice(0, 10)} ${hhmm}`; // clock skew, or a future stamp
  if (days === 0) return `today at ${clock()}`;
  if (days === 1) return `yesterday at ${clock()}`;
  if (days < 7) return `${days} days ago at ${clock()}`;
  return `${stamp.toISOString().slice(0, 10)} ${hhmm}`;
}

/**
 * The same link as Markdown, labelled with where it goes.
 *
 * A bare URL is not a link everywhere this text is read. The web bridge's renderer handles
 * `[label](url)` and does not autolink a raw URL at all — it falls through as escaped text, so a
 * line of `https://…` sat there unclickable. Chat autolinks a bare URL, and also accepts the
 * Markdown form, so writing the Markdown form is correct on both and needs no surface check.
 *
 * The label is `conversation 27202, message 34779` rather than "here" or the URL again: the reader
 * decides whether to click from what the link is, and the numbers are what the hit line above
 * already reports, so the link reads as the same thing.
 */
export function entryLinkMarkdown(
  conversationId: number,
  entryId: number | undefined,
  origin: string = process.env.BRIDGE_WEB_ORIGIN ?? "",
  described?: { name?: string; at?: number },
): string {
  const url = entryLink(conversationId, entryId, origin);
  if (url === "") return "";
  return `[${linkLabel(conversationId, entryId, described)}](${url})`;
}

/**
 * What a link says it goes to.
 *
 * Ids are precise and opaque; a reader deciding whether to click wants to recognise the thread.
 * So: the conversation's name when one is known, then when the message was, and the id only as
 * the thing that disambiguates — `"Ledger sync" — yesterday at 6:05pm (27202)`. When the name is
 * unknown the id leads, because a bare time says nothing about *which* conversation.
 */
export function linkLabel(
  conversationId: number,
  entryId: number | undefined,
  described?: { name?: string; at?: number },
  now: number = Date.now(),
): string {
  const name = described?.name?.trim();
  const when = entryId === undefined || described?.at === undefined ? "" : describeTime(described.at, now);
  // A name and a time, and no ids. The id is in the URL, which is the whole point of a link: a
  // reader copying it gets the exact conversation and message, so repeating the numbers in the
  // text only makes the label harder to read — and these labels are read far more than typed.
  if (name !== undefined && name !== "") {
    return when === "" ? name : `${name} — ${when}`;
  }
  // Unnamed: the id stays, because a bare time says nothing about *which* conversation, and this
  // is the case where the reader has no other handle on it.
  const base = entryId === undefined ? `conversation ${conversationId}` : `conversation ${conversationId}, message ${entryId}`;
  return when === "" ? base : `${base} — ${when}`;
}

function formatAt(at: number): string {
  if (at <= 0) return "".padEnd(16);
  return new Date(at).toISOString().slice(0, 16).replace("T", " ");
}

const USAGE = [
  "usage: transcript <command> [options]",
  "",
  "commands:",
  "  read   --conversation <id> [--from <entryId>] [--limit <n>]",
  "                             [--with-tools] [--with-thinking]",
  "  search <query>             [--conversation <id>] [--by-conv] [--kind <kind> …]",
  "                             [--all] [--limit <n>] [--max-stale <seconds>]",
  "  reindex",
  "",
  "search options:",
  '  <query>                    words, "a phrase", or a pref* — all terms required',
  "  --conversation <id>        only this conversation",
  "  --by-conv                  count matches per conversation instead of listing hits",
  "  --kind <kind> …            only these kinds (overrides the tool-result exclusion)",
  "  --all                      every kind, including tool results",
  "  --max-stale <seconds>      accept an answer that may miss the last <s> seconds;",
  "                             0 (default) always catches up first",
  "  --link-host <origin>       origin for the link printed under each hit",
  "                             (default BRIDGE_WEB_ORIGIN)",
  "  --no-links                 print hits without their links",
  "",
  "common options:",
  "  --limit <n>                lines to print (default 20)",
  "  --stats                    print indexing counts on stderr",
  "",
  `kinds: ${ENTRY_KINDS.join(", ")}`,
  "",
  "env: BRIDGE_DB (default ./bridge.sqlite), TRANSCRIPT_INDEX (default <store>-search.sqlite)",
].join("\n");

export interface CliDeps extends SearchDeps {
  /** Defaults to stdout. */
  out?(line: string): void;
  err?(line: string): void;
}

/**
 * `search`: parse the query options, then run the query.
 *
 * Options are parsed here rather than in the dispatcher so each verb owns its own grammar —
 * `search` accepts `--max-stale`, `read` would be wrong to.
 */
function searchCommand(
  argv: readonly string[],
  deps: CliDeps,
  out: (line: string) => void,
  err: (line: string) => void,
): number {
  const positional: string[] = [];
  let conversationId: number | undefined;
  let kinds: string[] | undefined;
  let limit = 20;
  let wantStats = false;
  let byConversation = false;
  let withTools = false;
  let withThinking = false;
  let fromEntry: number | undefined;
  let maxStaleness = 0;
  // Links are on by default when the deployment says where its pages are; `--no-links` turns them
  // off, and `--link-host` overrides the origin (a different proxy prefix, a test).
  let linkOrigin: string | false = process.env.BRIDGE_WEB_ORIGIN ?? "";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    switch (arg) {
      case "--conversation": {
        const value = Number(argv[++i]);
        if (!Number.isFinite(value)) {
          err(`${arg} needs a conversation id`);
          return 2;
        }
        conversationId = value;
        break;
      }
      case "--kind":
        kinds = kinds ?? [];
        while (i + 1 < argv.length && !String(argv[i + 1]).startsWith("--")) {
          kinds.push(String(argv[++i]));
        }
        if (kinds.length === 0) {
          err("--kind needs at least one kind");
          return 2;
        }
        break;
      case "--all":
        kinds = [...ENTRY_KINDS];
        break;
      case "--limit": {
        const value = Number(argv[++i]);
        if (!Number.isFinite(value) || value < 1) {
          err("--limit needs a positive number");
          return 2;
        }
        limit = value;
        break;
      }
      case "--max-stale": {
        const value = Number(argv[++i]);
        if (!Number.isFinite(value) || value < 0) {
          err("--max-stale needs a number of seconds");
          return 2;
        }
        maxStaleness = value;
        break;
      }
      case "--by-conv":
      case "--by-conversation":
        byConversation = true;
        break;
      case "--link-host": {
        const value = argv[++i];
        if (value === undefined || value === "") {
          err("--link-host needs an origin, e.g. https://pi.hl.id.au");
          return 2;
        }
        linkOrigin = value;
        break;
      }
      case "--no-links":
        linkOrigin = false;
        break;
      case "--stats":
        wantStats = true;
        break;
      case "--from": {
        const value = Number(argv[++i]);
        if (!Number.isFinite(value)) {
          err("--from needs an entry id");
          return 2;
        }
        fromEntry = value;
        break;
      }
      case "--with-tools":
        withTools = true;
        break;
      case "--with-thinking":
        withThinking = true;
        break;
      case "--help":
      case "-h":
        out(USAGE);
        return 0;
      default:
        if (arg.startsWith("--")) {
          err(`unknown option ${arg}`);
          out(USAGE);
          return 2;
        }
        positional.push(arg);
    }
  }

  if (fromEntry !== undefined || withTools || withThinking) {
    err("--from, --with-tools and --with-thinking belong to `transcript read`");
    out(USAGE);
    return 2;
  }

  return searchVerb({
    deps, out, err, positional, conversationId, kinds, limit,
    wantStats, byConversation, maxStaleness, linkOrigin,
  });
}

/** Everything `search` needs, so the dispatcher stays a dispatcher. */
interface SearchVerbArgs {
  deps: CliDeps;
  out(line: string): void;
  err(line: string): void;
  positional: string[];
  conversationId?: number;
  kinds?: string[];
  limit: number;
  wantStats: boolean;
  byConversation: boolean;
  maxStaleness: number;
  /** Origin for the links printed under hits. `false` suppresses them. */
  linkOrigin: string | false;
}

function searchVerb(args: SearchVerbArgs): number {
  const { deps, out, err, positional, conversationId, kinds, limit, wantStats } = args;
  const linkOrigin = args.linkOrigin;
  const query = positional.join(" ").trim();
  if (query === "") {
    out(USAGE);
    return 2;
  }

  if (args.byConversation) {
    const { conversations, stats } = countByConversation(deps, {
      query,
      ...(kinds === undefined ? {} : { kinds }),
      limit,
      maxStalenessSeconds: args.maxStaleness,
    });

    if (conversations.length === 0) {
      out(`no matches for ${JSON.stringify(query)}`);
      if (wantStats) err(statsLine(stats));
      return 0;
    }

    for (const row of conversations) {
      const total = `${row.matches} ${row.matches === 1 ? "match " : "matches"}`;
      // Say what the count hides, so a conversation that is all command output reads as found
      // rather than as a thread that happens to be low in the list.
      const hidden =
        row.toolResults > 0 && row.toolResults === row.matches
          ? "  (all tool output — not shown by a plain search)"
          : row.toolResults > 0
            ? `  (${row.toolResults} of them tool output)`
            : "";
      out(`${String(row.conversationId).padStart(6)}  ${formatAt(row.at)}  ${total.padEnd(11)}${hidden}`);
    }
    if (wantStats) err(statsLine(stats));
    return 0;
  }

  const { hits, stats } = search(deps, {
    query,
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(kinds === undefined ? {} : { kinds }),
    limit,
    maxStalenessSeconds: args.maxStaleness,
  });

  if (hits.length === 0) {
    out(`no matches for ${JSON.stringify(query)}`);
    if (wantStats) err(statsLine(stats));
    return 0;
  }

  // Read once, for every hit. Opened read-only and closed immediately: this is a label, and it
  // must not be able to fail the search or hold the store open.
  const names = (() => {
    try {
      const store = new DatabaseSync(deps.storePath, { readOnly: true });
      try {
        return readConversationNames(store);
      } finally {
        store.close();
      }
    } catch {
      return new Map<number, string>();
    }
  })();

  for (const hit of hits) {
    // Role and origin when the entry has them: `user:webui` says a browser asked, which is a
    // different fact from `assistant:gchat` and one a reader often needs to tell a prompt from
    // an answer. Absent rather than guessed, so the column is blank rather than wrong.
    const who = hit.role === undefined ? "" : hit.origin === undefined ? hit.role : `${hit.role}:${hit.origin}`;
    out(
      `${String(hit.conversationId).padStart(6)}  ${formatAt(hit.at)}  ` +
        `${hit.kind.replace(/^pi\./, "").padEnd(11)}  ${who.padEnd(18)}  ${hit.snippet}`,
    );
    // Its own line, in Markdown link form: a URL that has been wrapped or spliced into a sentence
    // stops being clickable, and a bare URL is not a link at all in the web bridge's renderer.
    const link =
      linkOrigin === false
        ? ""
        : entryLinkMarkdown(hit.conversationId, hit.entryId, linkOrigin, {
            ...(names.get(hit.conversationId) === undefined ? {} : { name: names.get(hit.conversationId)! }),
            at: hit.at,
          });
    if (link !== "") out(`              ${link}`);
  }
  if (wantStats) err(statsLine(stats));
  return 0;
}


/** One entry as `read` returns it: what was said, not the envelope around it. */
export interface ReadEntry {
  entryId: number;
  role: string;
  kind: string;
  at: number;
  /** Prose only — text blocks. Empty when the entry was nothing but a tool call. */
  text: string;
  /** Present only with `--with-thinking`. */
  thinking?: string;
  /** Present only with `--with-tools`. */
  toolOutput?: string;
}

/**
 * The prose of one entry: text blocks only, in order.
 *
 * Deliberately excludes thinking and tool-call arguments. Reading a conversation is for
 * following the argument, and in the real store one thread held 298 tool results against 9 user
 * messages — so including everything by default would bury the conversation in its own work.
 */
function proseOf(record: string): { text: string; thinking: string; role: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(record);
  } catch {
    return { text: "", thinking: "", role: "" };
  }
  const model = (parsed as { model?: unknown }).model;
  if (!Array.isArray(model)) return { text: "", thinking: "", role: "" };

  const text: string[] = [];
  const thinking: string[] = [];
  let role = "";
  for (const message of model as { role?: unknown; content?: unknown }[]) {
    if (typeof message?.role === "string" && role === "") role = message.role;
    const content = message?.content;
    if (typeof content === "string") {
      if (content !== "") text.push(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content as Record<string, unknown>[]) {
      if (block === null || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string") text.push(block.text);
      else if (block.type === "thinking" && typeof block.thinking === "string") thinking.push(block.thinking);
    }
  }
  return { text: text.join("\n\n"), thinking: thinking.join("\n\n"), role };
}

/**
 * `read`: whole entries for one conversation, prose by default.
 *
 * Reads the store rather than the index — this returns messages, not matches, so there is
 * nothing to search and no index to keep current. That also means it works before a search has
 * ever been run.
 */
function readCommand(
  argv: readonly string[],
  deps: CliDeps,
  out: (line: string) => void,
  err: (line: string) => void,
): number {
  let conversationId: number | undefined;
  let fromEntry: number | undefined;
  let limit = 40;
  let withTools = false;
  let withThinking = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    switch (arg) {
      case "--conversation": {
        const value = Number(argv[++i]);
        if (!Number.isFinite(value)) {
          err("--conversation needs an id");
          return 2;
        }
        conversationId = value;
        break;
      }
      case "--from": {
        const value = Number(argv[++i]);
        if (!Number.isFinite(value)) {
          err("--from needs an entry id");
          return 2;
        }
        fromEntry = value;
        break;
      }
      case "--limit": {
        const value = Number(argv[++i]);
        if (!Number.isFinite(value) || value < 1) {
          err("--limit needs a positive number");
          return 2;
        }
        limit = value;
        break;
      }
      case "--with-tools":
        withTools = true;
        break;
      case "--with-thinking":
        withThinking = true;
        break;
      case "--help":
      case "-h":
        out(USAGE);
        return 0;
      default:
        err(`unknown option ${arg} for read`);
        out(USAGE);
        return 2;
    }
  }

  // Named, not positional: a bare number would be a guess about what it means.
  if (conversationId === undefined) {
    err("read needs --conversation <id>");
    out(USAGE);
    return 2;
  }

  if (!fs.existsSync(deps.storePath)) {
    throw new Error(`no store at ${deps.storePath} — is BRIDGE_DB set?`);
  }

  const store = new DatabaseSync(deps.storePath, { readOnly: true });
  try {
    const rows = store
      .prepare(
        `SELECT id, record FROM entries
         WHERE conversation_id = ? AND id >= ?
         ORDER BY id
         LIMIT ?`,
      )
      .all(conversationId, fromEntry ?? 0, limit) as { id: number; record: string }[];

    if (rows.length === 0) {
      out(`no entries in conversation ${conversationId}${fromEntry === undefined ? "" : ` at or after ${fromEntry}`}`);
      return 0;
    }

    for (const row of rows) {
      const kind = kindOf(row.record) ?? "";
      // Tool results and system prompts are not conversation unless asked for.
      if (!withTools && (kind === "pi.tool-result" || kind === "pi.system")) continue;
      const prose = proseOf(row.record);
      const at = timestampOf(row.record);
      const role = prose.role || (kind === "pi.tool-result" ? "tool" : kind.replace(/^pi\./, ""));
      const text = prose.text || (withTools ? prose.thinking : "");
      if (text === "" && !(withThinking && prose.thinking !== "")) continue;

      out(`--- entry ${row.id}  ${formatAt(at)}  ${role}`);
      if (text !== "") out(text);
      if (withThinking && prose.thinking !== "") out(`[thinking] ${prose.thinking}`);
    }
    return 0;
  } finally {
    store.close();
  }
}

/**
 * The command line: verbs first, then options.
 *
 * `read` and `search` are the same capability at two levels — `search` finds entries and
 * `read` shows them — and the verb is explicit rather than inferred from the arguments. A bare
 * number is exactly the kind of implicit argument that reads as "the 27202nd something" to
 * whoever runs it next, so `read` names its conversation with a flag and refuses without one.
 */
export function runCli(argv: readonly string[], deps: CliDeps): number {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));

  const [verb, ...rest] = argv;
  switch (verb) {
    case "read":
      return readCommand(rest, deps, out, err);
    case "search":
      return searchCommand(rest, deps, out, err);
    case "reindex": {
      reindex(deps);
      const { stats } = search(deps, { query: "", limit: 1 });
      out(`reindexed ${stats.indexed} entries in ${stats.ms} ms (${stats.examined} examined)`);
      return 0;
    }
    case "--help":
    case "-h":
    case undefined:
      out(USAGE);
      return verb === undefined ? 2 : 0;
    default:
      err(`unknown command ${JSON.stringify(verb)}`);
      out(USAGE);
      return 2;
  }
}

// Entry point when run directly (`tsx src/scripts/transcript.ts …`).
if (process.argv[1] && /transcript\.(ts|js)$/.test(process.argv[1]) && fs.existsSync(process.argv[1])) {
  const store = process.env.BRIDGE_DB ?? path.resolve(process.cwd(), "bridge.sqlite");
  const index = process.env.TRANSCRIPT_INDEX;
  try {
    process.exit(
      runCli(process.argv.slice(2), {
        storePath: store,
        ...(index === undefined ? {} : { indexPath: index }),
      }),
    );
  } catch (error) {
    console.error(`transcript: ${(error as Error).message}`);
    process.exit(1);
  }
}
