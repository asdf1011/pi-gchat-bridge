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
export const INDEX_VERSION = 1;

export interface Hit {
  entryId: number;
  conversationId: number;
  kind: string;
  at: number;
  snippet: string;
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

const SCHEMA = `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value ANY) STRICT;

  CREATE VIRTUAL TABLE transcript USING fts5(
    text,
    entry_id UNINDEXED,
    conversation_id UNINDEXED,
    kind UNINDEXED,
    at UNINDEXED,
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(record);
  } catch {
    return "";
  }
  const model = (parsed as { model?: unknown }).model;
  if (!Array.isArray(model)) return "";

  const parts: string[] = [];
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
          if (typeof block.name === "string") parts.push(block.name);
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
  return parts.join("\n");
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
    "INSERT INTO transcript (text, entry_id, conversation_id, kind, at) VALUES (?, ?, ?, ?, ?)",
  );

  let indexed = 0;
  let highWaterMark = watermark;
  index.exec("BEGIN");
  try {
    for (const row of rows) {
      highWaterMark = Math.max(highWaterMark, row.id);
      const text = flattenRecord(row.record);
      if (text === "") continue;
      const kind = kindOf(row.record) ?? "";
      insert.run(text, row.id, row.conversation_id, kind, timestampOf(row.record));
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

function kindOf(record: string): string | undefined {
  try {
    const kind = (JSON.parse(record) as { kind?: unknown }).kind;
    return typeof kind === "string" ? kind : undefined;
  } catch {
    return undefined;
  }
}

/** One row as the index hands it back. */
interface HitRow {
  entry_id: number;
  conversation_id: number;
  kind: string;
  at: number;
  snippet: string;
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

    const select = `SELECT entry_id, conversation_id, kind, at,
                           snippet(transcript, 0, '[', ']', '…', 12) AS snippet
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
        snippet: row.snippet.replace(/\s+/g, " ").trim(),
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
    wantStats, byConversation, maxStaleness,
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
}

function searchVerb(args: SearchVerbArgs): number {
  const { deps, out, err, positional, conversationId, kinds, limit, wantStats } = args;
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

  for (const hit of hits) {
    out(
      `${String(hit.conversationId).padStart(6)}  ${formatAt(hit.at)}  ` +
        `${hit.kind.replace(/^pi\./, "").padEnd(11)}  ${hit.snippet}`,
    );
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
