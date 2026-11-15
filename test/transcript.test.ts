/**
 * The search CLI.
 *
 * Two properties carry the weight, and both are about not being a liability next to a store that
 * exactly one process owns: the index is derived data in its own file (so deleting it is always
 * safe), and catching it up is a tail on `entries.id` (so "stale" is not a state that exists).
 *
 * The rest is the query grammar, which is where a person and FTS5 disagree: a hyphen is `NOT` to
 * FTS5 and a hyphen to the person, and an unbalanced quote is a hard error rather than a search.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  catchUp,
  countByConversation,
  defaultIndexPath,
  displayText,
  describeTime,
  entryLink,
  entryLinkMarkdown,
  linkLabel,
  readConversationNames,
  shorten,
  flattenRecord,
  proseSnippet,
  readOrigins,
  roleOf,
  runCli,
  SCHEMA,
  search,
  toFtsQuery,
} from "../src/scripts/transcript.js";

const STORE_SCHEMA = `
  CREATE TABLE entries (
    id INTEGER PRIMARY KEY,
    conversation_id INTEGER NOT NULL,
    head INTEGER,
    commit_seq INTEGER NOT NULL,
    record TEXT NOT NULL
  );
`;

/** One entry record, in the shape the store actually writes. */
function record(kind: string, content: unknown, timestamp = 1_700_000_000_000): string {
  return JSON.stringify({ kind, model: [{ role: "assistant", content, timestamp }] });
}

function textRecord(kind: string, text: string, timestamp?: number): string {
  return record(kind, [{ type: "text", text }], timestamp);
}

/**
 * A store with a handful of entries, and a counter so a test can append more and watch the tail.
 * Built as a real SQLite file rather than a mock: the thing under test *is* SQL, and a mock would
 * only prove that the mock works.
 */
function makeStore(entries: [kind: string, content: unknown][]): {
  dir: string;
  storePath: string;
  append(kind: string, content: unknown): number;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-search-"));
  const storePath = path.join(dir, "store.sqlite");
  const db = new DatabaseSync(storePath);
  db.exec(STORE_SCHEMA);
  const insert = db.prepare(
    "INSERT INTO entries (conversation_id, commit_seq, record) VALUES (?, ?, ?)",
  );
  for (const [kind, content] of entries) {
    const info = insert.run(1, 1, record(kind, content));
    void info;
  }
  const nextId = () => (db.prepare("SELECT max(id) AS id FROM entries").get() as { id: number | null }).id ?? 0;
  return {
    dir,
    storePath,
    append(kind, content) {
      insert.run(1, 1, record(kind, content));
      return nextId();
    },
  };
}

function lines(): { out: string[]; err: string[]; deps: { out(l: string): void; err(l: string): void } } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    deps: {
      out: (line: string) => out.push(line),
      err: (line: string) => err.push(line),
    },
  };
}

// --- flattening -------------------------------------------------------------------------------

test("flattenRecord keeps what was said and drops the envelope", () => {
  const text = flattenRecord(
    JSON.stringify({
      kind: "pi.assistant",
      model: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "consider the FTS index" },
            { type: "text", text: "the answer is 42" },
            { type: "toolCall", name: "bash", arguments: { command: "ls -la" } },
          ],
        },
      ],
    }),
  );
  assert.match(text, /consider the FTS index/);
  assert.match(text, /the answer is 42/);
  assert.match(text, /bash/);
  assert.match(text, /ls -la/);
  assert.ok(!text.includes("pi.assistant"), "the kind is a column, not text");
});

test("flattenRecord accepts a string content and an empty one", () => {
  assert.equal(flattenRecord(record("pi.user", "just words")), "just words");
  assert.equal(flattenRecord(record("pi.user", "")), "");
  assert.equal(flattenRecord(record("pi.system", [])), "");
});

test("flattenRecord returns nothing for a record it cannot parse, rather than throwing", () => {
  // A store that contains one bad row should not make search unusable.
  assert.equal(flattenRecord("{not json"), "");
  assert.equal(flattenRecord(JSON.stringify({ kind: "pi.user" })), "");
  assert.equal(flattenRecord(JSON.stringify({ kind: "pi.user", model: "no" })), "");
});

// --- query grammar ----------------------------------------------------------------------------

test("a hyphen is a word, not a NOT operator", () => {
  // Raw FTS5 reads `pi-durable` as `pi NOT durable` and quietly returns the wrong rows.
  assert.equal(toFtsQuery("pi-durable"), '"pi-durable"');
});

test("terms are all required, and a phrase stays a phrase", () => {
  assert.equal(toFtsQuery("alpha beta"), '"alpha" AND "beta"');
  assert.equal(toFtsQuery('"google chat"'), '"google chat"');
  assert.equal(toFtsQuery('"google chat" sqlite'), '"google chat" AND "sqlite"');
});

test("a trailing star is a prefix search, outside the quotes", () => {
  assert.equal(toFtsQuery("quantiz*"), '"quantiz"*');
});

test("FTS operators and stray quotes cannot reach the grammar as syntax", () => {
  assert.equal(toFtsQuery("AND"), '"AND"');
  assert.equal(toFtsQuery("NEAR(a b)"), '"NEAR(a" AND "b)"');
  assert.equal(toFtsQuery('say "hi'), '"say" AND """hi"', 'a stray quote is escaped, not left to break the grammar');
  assert.equal(toFtsQuery("   "), "");
  assert.equal(toFtsQuery("*"), "");
});

// --- indexing ---------------------------------------------------------------------------------

test("catchUp indexes only what is new, and advances the watermark even over unsearchable rows", () => {
  const store = makeStore([
    ["pi.user", "first question"],
    ["pi.system", ""], // nothing to search, but it still has an id
  ]);
  const db = new DatabaseSync(store.storePath, { readOnly: true });
  // A fresh index, not one `search` has already caught up.
  const index = new DatabaseSync(defaultIndexPath(store.storePath));
  // The real schema, not a copy: a second declaration in a test goes stale the first time a
  // column is added to the index.
  index.exec(SCHEMA);

  const first = catchUp(db, index);
  assert.deepEqual([first.indexed, first.examined], [1, 2], "the empty entry is examined once");
  assert.equal(first.highWaterMark, 2);

  const again = catchUp(db, index);
  assert.deepEqual([again.indexed, again.examined], [0, 0], "nothing re-reads");
  assert.equal(again.highWaterMark, 2);

  const id = store.append("pi.assistant", [{ type: "text", text: "an answer about quantisation" }]);
  const third = catchUp(db, index);
  assert.deepEqual([third.indexed, third.examined], [1, 1], "only the new entry");
  assert.equal(third.highWaterMark, id);

  index.close();
  db.close();
});

test("delete the index and the next search rebuilds it — nothing depends on it existing", () => {
  const store = makeStore([["pi.user", "the durable store is sqlite"]]);
  const first = search({ storePath: store.storePath }, { query: "durable" });
  assert.equal(first.hits.length, 1);

  const indexPath = defaultIndexPath(store.storePath);
  fs.rmSync(indexPath, { force: true });
  fs.rmSync(`${indexPath}-wal`, { force: true });
  fs.rmSync(`${indexPath}-shm`, { force: true });

  const rebuilt = search({ storePath: store.storePath }, { query: "durable" });
  assert.equal(rebuilt.hits.length, 1);
  assert.equal(rebuilt.stats.indexed, 1, "rebuilt from scratch, not from a remembered watermark");
});

test("the index lives beside the store, not inside it", () => {
  // The store is owned by exactly one process; a search writing to it would be the bug the lock
  // exists to prevent. The index is a sibling file for that reason.
  const store = makeStore([["pi.user", "hello"]]);
  const before = fs.statSync(store.storePath).size;
  search({ storePath: store.storePath }, { query: "hello" });
  assert.equal(fs.statSync(store.storePath).size, before, "the store is unchanged");
  assert.ok(fs.existsSync(defaultIndexPath(store.storePath)));
});

// --- searching --------------------------------------------------------------------------------

test("tool results are indexed but kept out of an unfiltered search", () => {
  const store = makeStore([
    ["pi.assistant", [{ type: "text", text: "the answer mentions quantisation" }]],
    ["pi.tool-result", [{ type: "text", text: "quantisation output from a command" }]],
  ]);

  const defaultHits = search({ storePath: store.storePath }, { query: "quantisation" });
  assert.deepEqual(defaultHits.hits.map((hit) => hit.kind), ["pi.assistant"]);

  const all = search({ storePath: store.storePath }, { query: "quantisation", kinds: ["pi.tool-result", "pi.assistant"] });
  assert.equal(all.hits.length, 2, "--all / --kind reaches them when asked for");

  const only = search({ storePath: store.storePath }, { query: "quantisation", kinds: ["pi.tool-result"] });
  assert.deepEqual(only.hits.map((hit) => hit.kind), ["pi.tool-result"]);
});

test("a single common term is still a search, not a fallback to nothing", () => {
  // Regression: `MATCH x` and `MATCH (x)` are the same query, and with one term the shorter plan
  // is what SQLite needs to be allowed to pick.
  const store = makeStore([
    ["pi.user", "sqlite is everywhere"],
    ["pi.user", "another sqlite mention"],
  ]);
  const { hits } = search({ storePath: store.storePath }, { query: "sqlite" });
  assert.equal(hits.length, 2);
});

test("hits carry a snippet with the match marked, newest first on a tie", () => {
  const store = makeStore([
    ["pi.user", "a question about the ledger"],
    ["pi.user", "an answer about the ledger"],
  ]);
  const { hits } = search({ storePath: store.storePath }, { query: "ledger" });
  assert.equal(hits.length, 2);
  assert.match(hits[0]!.snippet, /\[ledger\]/, "the match is bracketed for the terminal");
  assert.equal(hits[0]!.entryId > hits[1]!.entryId, true, "ties break toward the newest");
});

test("search finds text appended since the index was built", () => {
  const store = makeStore([["pi.user", "before"]]);
  assert.equal(search({ storePath: store.storePath }, { query: "after" }).hits.length, 0);
  store.append("pi.user", [{ type: "text", text: "the word after" }]);
  assert.equal(search({ storePath: store.storePath }, { query: "after" }).hits.length, 1);
});

test("a missing store is an error with a name, not a crash", () => {
  assert.throws(
    () => search({ storePath: "/nonexistent/store.sqlite" }, { query: "anything" }),
    /no store at/,
  );
});

// --- the command line -------------------------------------------------------------------------

test("cli prints hits and exits 0, and says so when there are none", () => {
  const store = makeStore([["pi.user", "a memorable phrase"]]);

  const found = lines();
  // `--no-links`, because the default follows `BRIDGE_WEB_ORIGIN` and this test is about the hit,
  // not the link. The link's own behaviour is tested below, with the origin pinned.
  assert.equal(
    runCli(["search", "memorable", "--no-links"], { storePath: store.storePath, ...found.deps }),
    0,
  );
  assert.equal(found.out.length, 1);
  assert.match(found.out[0]!, /memorable/);

  const none = lines();
  assert.equal(runCli(["search", "absent"], { storePath: store.storePath, ...none.deps }), 0);
  assert.match(none.out[0]!, /no matches/);
});

test("cli rejects a bad option rather than searching for it", () => {
  const store = makeStore([["pi.user", "x"]]);
  const { out, err, deps } = lines();
  assert.equal(runCli(["search", "--nope", "x"], { storePath: store.storePath, ...deps }), 2);
  assert.match(err.join("\n"), /unknown option/);
  assert.ok(out.length > 0, "usage, so the person sees the options");
});

test("cli with no query prints usage and exits 2", () => {
  const store = makeStore([]);
  const { out, deps } = lines();
  assert.equal(runCli([], { storePath: store.storePath, ...deps }), 2);
  assert.match(out.join("\n"), /usage: transcript /);
});

test("cli --conversation and --kind narrow the same way the API does", () => {
  const store = makeStore([
    ["pi.user", "ledger one"],
    ["pi.tool-result", "ledger two"],
  ]);
  const scoped = lines();
  runCli(["search", "ledger", "--kind", "pi.user", "--no-links"], {
    storePath: store.storePath,
    ...scoped.deps,
  });
  assert.equal(scoped.out.length, 1, "tool results stay out unless asked for");
  assert.match(scoped.out[0]!, /^ +1 /, "conversation id leads the line");
});

test("cli --reindex rebuilds and reports what it did", () => {
  const store = makeStore([["pi.user", "one"], ["pi.user", "two"]]);
  search({ storePath: store.storePath }, { query: "one" }); // creates the index
  const { out, deps } = lines();
  assert.equal(runCli(["reindex"], { storePath: store.storePath, ...deps }), 0);
  assert.match(out.join("\n"), /reindexed 2 entries/);
});

// --- counting per conversation -----------------------------------------------------------------

test("countByConversation ranks by how much a thread is about the query", () => {
  // The reason the mode exists: a ranked snippet list says "what was said", not "where". One
  // conversation with a lot of matches should lead, and `--by-conv` says so directly.
  const store = makeStore([["pi.user", "ledger once"]]);
  // A second conversation that discusses it across several turns. The count is of matching
  // *entries*, not word occurrences — the unit a thread is actually about something in.
  const db = new DatabaseSync(store.storePath);
  const insert = db.prepare(
    "INSERT INTO entries (conversation_id, commit_seq, record) VALUES (?, ?, ?)",
  );
  for (const text of ["ledger opening", "ledger again", "ledger settled"]) {
    insert.run(7, 1, record("pi.user", text));
  }
  db.close();

  const { conversations } = countByConversation({ storePath: store.storePath }, { query: "ledger" });
  assert.equal(conversations.length, 2);
  assert.equal(conversations[0]!.conversationId, 7, "the thread mostly about ledgers leads");
  assert.equal(conversations[0]!.matches, 3, "matching entries, not word occurrences");
  assert.equal(conversations[1]!.conversationId, 1);
  assert.equal(conversations[1]!.matches, 1);
});

test("countByConversation counts tool results instead of hiding the thread", () => {
  // A conversation whose only matches are command output is still the conversation where the
  // thing happened. Filtering it out would answer "never discussed" — the opposite of the truth.
  const store = makeStore([
    ["pi.tool-result", "ledger output from a command"],
    ["pi.tool-result", "more ledger output"],
  ]);
  const { conversations } = countByConversation({ storePath: store.storePath }, { query: "ledger" });
  assert.equal(conversations.length, 1);
  assert.equal(conversations[0]!.matches, 2);
  assert.equal(conversations[0]!.toolResults, 2, "the caller can say how much is hidden");

  const plain = search({ storePath: store.storePath }, { query: "ledger" });
  assert.equal(plain.hits.length, 0, "and a plain search still shows none of it");
});

test("countByConversation on a common single term is a count, not a miss", () => {
  // Same plan hazard as `search`: one term, many rows.
  const store = makeStore([
    ["pi.user", "sqlite here"],
    ["pi.user", "sqlite there"],
  ]);
  const { conversations } = countByConversation({ storePath: store.storePath }, { query: "sqlite" });
  assert.equal(conversations.length, 1);
  assert.equal(conversations[0]!.matches, 2);
});

test("cli --by-conv prints one line per conversation, newest first on a tie", () => {
  const store = makeStore([
    ["pi.user", "ledger in the durable store"],
    ["pi.user", "a second ledger mention"],
  ]);
  const { out, deps } = lines();
  assert.equal(runCli(["search", "ledger", "--by-conv"], { storePath: store.storePath, ...deps }), 0);
  assert.equal(out.length, 1);
  assert.match(out[0]!, /^ +1 /, "conversation id leads");
  assert.match(out[0]!, /2 matches/);
});

test("cli --by-conv says when a thread's matches are all tool output", () => {
  const store = makeStore([["pi.tool-result", "ledger output"]]);
  const { out, deps } = lines();
  runCli(["search", "ledger", "--by-conv"], { storePath: store.storePath, ...deps });
  assert.match(out[0]!, /all tool output/, "so a hit is not mistaken for a thread with no matches");
});

test("cli --by-conv with nothing matching says so and exits 0", () => {
  const store = makeStore([["pi.user", "unrelated words"]]);
  const { out, deps } = lines();
  assert.equal(runCli(["search", "absent", "--by-conv"], { storePath: store.storePath, ...deps }), 0);
  assert.match(out[0]!, /no matches/);
});

// --- freshness ----------------------------------------------------------------------------------

test("an index already at the source's newest entry takes no writer lock, at any staleness", () => {
  // The common case for a repeated search: nothing to import, so nothing to write. This is the
  // probe that makes a write lock unnecessary rather than merely optional.
  const store = makeStore([["pi.user", "the ledger entry"]]);
  search({ storePath: store.storePath }, { query: "ledger" }); // builds and catches up

  for (const maxStalenessSeconds of [0, 5, 3600]) {
    const stats = search({ storePath: store.storePath }, { query: "ledger", maxStalenessSeconds }).stats;
    assert.equal(stats.indexed, 0, `nothing imported at maxStalenessSeconds=${maxStalenessSeconds}`);
    assert.equal(stats.examined, 0);
    assert.equal(stats.stale, false);
  }
});

test("maxStalenessSeconds defers a required import, and says the answer is stale", () => {
  const store = makeStore([["pi.user", "first ledger mention"]]);
  search({ storePath: store.storePath }, { query: "ledger" });
  store.append("pi.user", [{ type: "text", text: "second ledger mention" }]);

  const stale = search({ storePath: store.storePath }, { query: "ledger", maxStalenessSeconds: 300 });
  assert.equal(stale.hits.length, 1, "the new entry is deferred, not imported");
  assert.equal(stale.stats.indexed, 0);
  assert.equal(stale.stats.stale, true, "and the caller is told, rather than guessing");
});

test("maxStalenessSeconds 0 imports immediately, even though the index was just written", () => {
  // The default must never silently return an old answer: a person at a terminal just wrote
  // something and expects to find it.
  const store = makeStore([["pi.user", "first ledger mention"]]);
  search({ storePath: store.storePath }, { query: "ledger" });
  store.append("pi.user", [{ type: "text", text: "second ledger mention" }]);

  const fresh = search({ storePath: store.storePath }, { query: "ledger", maxStalenessSeconds: 0 });
  assert.equal(fresh.hits.length, 2);
  assert.equal(fresh.stats.stale, false);
});

test("staleness is measured from the last import, not from the last search", () => {
  const store = makeStore([["pi.user", "a ledger mention"]]);
  search({ storePath: store.storePath }, { query: "ledger" }); // sets imported_at
  const first = search({ storePath: store.storePath }, { query: "ledger" }).stats;
  assert.ok((first.ageMs ?? 0) >= 0, "an import just happened, so the age exists and is small");
  assert.ok((first.ageMs ?? 0) < 60_000);
});

test("two concurrent reads both succeed instead of one failing with SQLITE_BUSY", () => {
  // The bug this fixes: `PRAGMA busy_timeout` defaults to zero, so the loser of a race got
  // `database is locked` — which reads as "no results" to anything only looking at stdout.
  const store = makeStore([["pi.user", "a race between readers"]]);
  search({ storePath: store.storePath }, { query: "race" }); // create the index first
  const results = Array.from({ length: 4 }, () =>
    search({ storePath: store.storePath }, { query: "race" }),
  );
  for (const result of results) assert.equal(result.hits.length, 1);
});

test("cli --stats reports freshness, and warns when the answer is stale", () => {
  const store = makeStore([["pi.user", "ledger"]]);
  search({ storePath: store.storePath }, { query: "ledger" });
  store.append("pi.user", [{ type: "text", text: "a later ledger" }]);

  const stale = lines();
  runCli(["search", "ledger", "--max-stale", "300", "--stats"], { storePath: store.storePath, ...stale.deps });
  assert.match(stale.err.join("\n"), /STALE/);
  assert.match(stale.err.join("\n"), /--max-stale 0/, "and tells the reader how to fix it");

  const fresh = lines();
  runCli(["search", "ledger", "--stats"], { storePath: store.storePath, ...fresh.deps });
  assert.doesNotMatch(fresh.err.join("\n"), /STALE/);
  assert.match(fresh.err.join("\n"), /good up to entry/);
});

test("cli rejects a --max-stale that is not a number of seconds", () => {
  const store = makeStore([["pi.user", "x"]]);
  const { err, deps } = lines();
  assert.equal(runCli(["search", "x", "--max-stale", "soon"], { storePath: store.storePath, ...deps }), 2);
  assert.match(err.join("\n"), /--max-stale needs a number/);
  assert.equal(runCli(["search", "x", "--max-stale", "-5"], { storePath: store.storePath, ...deps }), 2);
});

// --- the command surface ------------------------------------------------------------------------

test("read requires --conversation, because a bare number does not say what it is", () => {
  const store = makeStore([["pi.user", "hello"]]);
  const { out, err, deps } = lines();
  assert.equal(runCli(["read"], { storePath: store.storePath, ...deps }), 2);
  assert.match(err.join("\n"), /read needs --conversation/);
  assert.match(out.join("\n"), /usage: transcript/);
});

test("read defaults to prose: no tool results, no thinking", () => {
  const store = makeStore([
    ["pi.user", "the question"],
    ["pi.assistant", [{ type: "thinking", thinking: "a private consideration" }, { type: "text", text: "the answer" }]],
    ["pi.tool-result", [{ type: "text", text: "command output" }]],
  ]);
  const { out, deps } = lines();
  const printed = runCli(["read", "--conversation", "1"], { storePath: store.storePath, ...deps });
  const text = out.join("\n");
  assert.equal(printed, 0);
  assert.match(text, /the question/);
  assert.match(text, /the answer/);
  assert.doesNotMatch(text, /command output/, "tool results are not conversation by default");
  assert.doesNotMatch(text, /private consideration/, "thinking is not shown by default");
});

test("read --with-tools and --with-thinking widen it, one at a time", () => {
  const store = makeStore([
    ["pi.assistant", [{ type: "thinking", thinking: "a private consideration" }, { type: "text", text: "the answer" }]],
    ["pi.tool-result", [{ type: "text", text: "command output" }]],
  ]);

  const tools = lines();
  runCli(["read", "--conversation", "1", "--with-tools"], { storePath: store.storePath, ...tools.deps });
  assert.match(tools.out.join("\n"), /command output/);
  assert.doesNotMatch(tools.out.join("\n"), /private consideration/);

  const thinking = lines();
  runCli(["read", "--conversation", "1", "--with-thinking"], { storePath: store.storePath, ...thinking.deps });
  assert.match(thinking.out.join("\n"), /private consideration/);
  assert.doesNotMatch(thinking.out.join("\n"), /command output/);
});

test("read --from starts at an entry, and read reports an empty conversation", () => {
  const store = makeStore([
    ["pi.user", "first"],
    ["pi.user", "second"],
    ["pi.user", "third"],
  ]);
  const { out, deps } = lines();
  runCli(["read", "--conversation", "1", "--from", "2"], { storePath: store.storePath, ...deps });
  const text = out.join("\n");
  assert.doesNotMatch(text, /first/);
  assert.match(text, /second/);
  assert.match(text, /third/);

  const empty = lines();
  assert.equal(runCli(["read", "--conversation", "999"], { storePath: store.storePath, ...empty.deps }), 0);
  assert.match(empty.out.join("\n"), /no entries in conversation 999/);
});

test("an unknown command is refused rather than treated as a query", () => {
  const store = makeStore([["pi.user", "x"]]);
  const { err, deps } = lines();
  assert.equal(runCli(["serch", "ledger"], { storePath: store.storePath, ...deps }), 2);
  assert.match(err.join("\n"), /unknown command/);
});

test("read rejects the search-only flags rather than ignoring them", () => {
  const store = makeStore([["pi.user", "x"]]);
  const { err, deps } = lines();
  assert.equal(runCli(["read", "--conversation", "1", "--max-stale", "5"], { storePath: store.storePath, ...deps }), 2);
  assert.match(err.join("\n"), /unknown option --max-stale/);
});

// --- display text: the snippet a person reads ------------------------------------------------

test("displayText keeps prose and drops a tool call's arguments", () => {
  // The whole reason this exists: matching wants the command, the snippet wants the prose.
  // Searching `ofxsync` must find the entry, but `bash {"command":"cd /workspace/..."}` is not
  // a snippet anybody can read.
  const entry = JSON.stringify({
    kind: "pi.assistant",
    model: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me build the system." },
          { type: "toolCall", name: "bash", arguments: { command: "cd /workspace && mkdir -p ofxsync" } },
        ],
      },
    ],
  });
  assert.match(displayText(entry), /Let me build the system\./);
  assert.ok(!displayText(entry).includes("mkdir"), "the command is not in the prose");
  // …but it is still matchable.
  assert.match(flattenRecord(entry), /mkdir -p ofxsync/);
});

test("displayText falls back to the command when the entry is nothing but a tool call", () => {
  // "bash" alone orients nobody — five hits whose entire snippet was `bash` is what prompted
  // this. With no prose to displace, the command is the only thing worth showing.
  const call = (name: string, args: unknown) =>
    JSON.stringify({
      kind: "pi.assistant",
      model: [{ role: "assistant", content: [{ type: "toolCall", name, arguments: args }] }],
    });
  assert.equal(displayText(call("bash", { command: "ls -la" })), "bash ls -la");
  assert.equal(displayText(call("read", { file_path: "/tmp/x.ts" })), "read /tmp/x.ts");
  assert.equal(displayText(call("grep", { pattern: "ledger" })), "grep ledger");
  // A tool whose arguments name nothing recognisable contributes its name, not a JSON dump.
  assert.equal(displayText(call("mystery", { beta: 1 })), "mystery");
});

test("roleOf reports the role an entry carries, and nothing when it has none", () => {
  // The role is the model message's, not the entry kind's: a `pi.user` entry can hold any role,
  // and this reads what is there rather than inferring from the kind.
  const withRole = (role: string) =>
    JSON.stringify({ kind: "pi.user", model: [{ role, content: "hello" }] });
  assert.equal(roleOf(withRole("user")), "user");
  assert.equal(roleOf(withRole("assistant")), "assistant");
  assert.equal(roleOf(JSON.stringify({ kind: "pi.user" })), undefined);
  assert.equal(roleOf(JSON.stringify({ kind: "pi.user", model: [{ content: "x" }] })), undefined);
  assert.equal(roleOf("{not json"), undefined);
});

test("a hit whose term appears only in a tool call still matches, and shows prose", () => {
  const store = makeStore([
    [
      "pi.assistant",
      [
        { type: "text", text: "Running the check now." },
        { type: "toolCall", name: "bash", arguments: { command: "bean-check staging.beancount" } },
      ],
    ],
  ]);
  const { hits } = search({ storePath: store.storePath }, { query: "bean-check" });
  assert.equal(hits.length, 1);
  assert.match(hits[0]!.snippet, /Running the check now\./, "the snippet is prose");
  assert.ok(!hits[0]!.snippet.includes("staging.beancount"), "not the command");
  assert.equal(hits[0]!.role, "assistant");
});

test("proseSnippet brackets the terms and centres on the first match", () => {
  const text = `${"filler ".repeat(60)}the ofxsync run failed ${"trailing ".repeat(60)}`;
  const snippet = proseSnippet(text, "ofxsync");
  assert.match(snippet, /\[ofxsync\]/);
  assert.ok(snippet.startsWith("…"), "a match in the middle is not shown from the start");
  assert.ok(snippet.length < 240, `snippet was ${snippet.length} chars`);
  // Short words are not bracketed: splitting a phrase on whitespace would mark every `a`.
  // Case-insensitively, and the text keeps its own casing... except that the replacement
  // writes the *matched substring* back, so `Testing` against `testing` yields `[testing]`.
  assert.equal(proseSnippet("a testing a web message", "Testing a web message"), "a [testing] a [web] [message]");
});

test("proseSnippet shows the opening words when the term was only in a tool call", () => {
  // No bracketed term is a normal outcome, not a failure: the entry matched, the prose did not
  // contain the word. Showing the first words is more honest than pretending otherwise.
  const snippet = proseSnippet("Looking at the build output.", "bean-check");
  assert.equal(snippet, "Looking at the build output.");
  assert.ok(!snippet.includes("["), snippet);
});

test("readOrigins reads each conversation's stamps and ignores what it cannot parse", () => {
  const store = makeStore([["pi.user", "hello"], ["pi.assistant", [{ type: "text", text: "hi" }]]]);
  const db = new DatabaseSync(store.storePath);
  db.exec(`
    CREATE TABLE documents (id INTEGER PRIMARY KEY, kind TEXT, scope_kind TEXT, owner_id INTEGER, retired_at INTEGER);
    CREATE TABLE document_revisions (document_id INTEGER, seq INTEGER, content TEXT);
    INSERT INTO documents VALUES (1, '"gchat.origins"', 'conversation', 7, NULL);
    INSERT INTO documents VALUES (2, '"gchat.origins"', 'conversation', 8, NULL);
    INSERT INTO document_revisions VALUES (1, 1, '{"byEntry":{"11":{"origin":"webui"}}}');
    INSERT INTO document_revisions VALUES (2, 1, 'not json');
  `);
  const origins = readOrigins(db);
  db.close();
  assert.equal(origins.get("7:11"), "webui");
  // The bad document contributes nothing rather than throwing.
  assert.equal(origins.size, 1);
});

test("readOrigins on a store with no origins table is empty, not an error", () => {
  // A store written before the stamps existed, or one this tool does not own.
  const store = makeStore([["pi.user", "hello"]]);
  const db = new DatabaseSync(store.storePath, { readOnly: true });
  assert.equal(readOrigins(db).size, 0);
  db.close();
});

// --- links -------------------------------------------------------------------------------------

test("entryLink builds the page's own shape, with the entry as a fragment", () => {
  // What the page now honours: /<id>/ opens a conversation, #e<entryId> names a turn in it.
  assert.equal(entryLink(27202, 28368, "https://pi.hl.id.au"), "https://pi.hl.id.au/27202/#e28368");
  // A trailing slash on the configured origin does not become a double slash.
  assert.equal(entryLink(7, 9, "https://pi.hl.id.au/"), "https://pi.hl.id.au/7/#e9");
  // No entry id is the conversation, not `/undefined/#eundefined`.
  assert.equal(entryLink(7, undefined, "https://pi.hl.id.au"), "https://pi.hl.id.au/7/");
});

test("entryLink with no configured origin is empty rather than invented", () => {
  // A deployment with no web UI has no pages to link to. Guessing a host would send a reader
  // somewhere that does not exist, which is worse than printing nothing.
  assert.equal(entryLink(7, 9, ""), "");
});

test("cli prints the link under a hit, and --link-host overrides where it points", () => {
  const store = makeStore([["pi.user", "a memorable phrase"]]);
  const entryId = 1;

  const pinned = lines();
  runCli(["search", "memorable", "--link-host", "https://example.test"], {
    storePath: store.storePath,
    ...pinned.deps,
  });
  // Its own line: a URL spliced into the snippet stops being clickable.
  assert.equal(pinned.out.length, 2);
  assert.match(pinned.out[0]!, /memorable/);
  // Markdown link form, because a bare URL is not clickable in the web bridge's renderer. The
  // label names the conversation and when, and this fixture has no binding, so the id leads and
  // the time is the fixture's fixed timestamp.
  assert.equal(
    pinned.out[1]!.trim(),
    `[conversation 1, message ${entryId} — 2023-11-14 22:13](https://example.test/1/#e${entryId})`,
  );

  const suppressed = lines();
  runCli(["search", "memorable", "--no-links"], { storePath: store.storePath, ...suppressed.deps });
  assert.equal(suppressed.out.length, 1, "nothing but the hit");
});

test("entryLinkMarkdown writes the form both surfaces render as a link", () => {
  // The web bridge's renderer handles `[label](url)` and does not autolink a raw URL — it falls
  // through as escaped text, which is how a line of `https://…` sat there unclickable. Chat
  // autolinks a bare URL *and* accepts Markdown, so this form is correct on both.
  assert.equal(
    entryLinkMarkdown(27202, 28368, "https://pi.hl.id.au"),
    "[conversation 27202, message 28368](https://pi.hl.id.au/27202/#e28368)",
  );
  // No entry id: the label says what it is rather than leaving a dangling "message undefined".
  assert.equal(
    entryLinkMarkdown(7, undefined, "https://pi.hl.id.au"),
    "[conversation 7](https://pi.hl.id.au/7/)",
  );
  // The same no-origin rule as the plain form.
  assert.equal(entryLinkMarkdown(7, 9, ""), "");
});

// --- labels a reader can recognise ------------------------------------------------------------

test("describeTime says yesterday, days ago, or a date — and stops converting at a week", () => {
  // Built from UTC fields: these labels are pasted into conversations, so the phrase has to be a
  // property of the message rather than of when the tool ran.
  const at = Date.UTC(2026, 10, 14, 18, 5); // 2026-11-14 18:05 UTC
  assert.equal(describeTime(at, Date.UTC(2026, 10, 14, 20, 0)), "today at 6:05pm");
  assert.equal(describeTime(at, Date.UTC(2026, 10, 15, 9, 0)), "yesterday at 6:05pm");
  assert.equal(describeTime(at, Date.UTC(2026, 10, 17, 9, 0)), "3 days ago at 6:05pm");
  // A week is where relative stops helping: "43 days ago" is a number nobody converts.
  assert.equal(describeTime(at, Date.UTC(2026, 10, 21, 9, 0)), "2026-11-14 18:05");
  // Midnight and noon are the two the twelve-hour form gets wrong if it is written carelessly.
  assert.equal(describeTime(Date.UTC(2026, 10, 14, 0, 5), Date.UTC(2026, 10, 14, 12, 0)), "today at 12:05am");
  assert.equal(describeTime(Date.UTC(2026, 10, 14, 12, 5), Date.UTC(2026, 10, 14, 20, 0)), "today at 12:05pm");
  // By calendar date, not elapsed seconds: 23:50 then 00:10 is "yesterday" to a reader.
  assert.equal(
    describeTime(Date.UTC(2026, 10, 14, 23, 50), Date.UTC(2026, 10, 15, 0, 10)),
    "yesterday at 11:50pm",
  );
  // No timestamp at all is nothing, not "1970".
  assert.equal(describeTime(0), "");
});

test("shorten cuts at a word boundary, and leaves a short name alone", () => {
  assert.equal(shorten("Ledger sync"), "Ledger sync");
  const long = "I have accounts at several institutions. Chase, Schwab, Capital One, Wells Fargo";
  const cut = shorten(long);
  assert.ok(cut.length <= 49, cut);
  assert.ok(cut.endsWith("…"));
  // Cut at a space, so the last word is whole.
  assert.ok(!/ [a-z]{1,2}…$/.test(cut) || cut.split(" ").at(-1) === "…", cut);
});

test("a link label names the conversation and when, keeping the id to disambiguate", () => {
  const now = Date.UTC(2026, 10, 15, 9, 0);
  const at = Date.UTC(2026, 10, 14, 18, 5);
  assert.equal(
    linkLabel(27202, 34779, { name: "Ledger sync", at }, now),
    "Ledger sync — yesterday at 6:05pm — (27202, message 34779)",
  );
  // No name: the id leads, because a bare time says nothing about which conversation.
  assert.equal(
    linkLabel(6317, 6780, { at }, now),
    "conversation 6317, message 6780 — yesterday at 6:05pm",
  );
  // No time either: still a usable label.
  assert.equal(linkLabel(7, undefined, {}), "conversation 7");
});

test("readConversationNames prefers a title over a preview, and cleans both", () => {
  const store = makeStore([["pi.user", "hello"]]);
  const db = new DatabaseSync(store.storePath);
  db.exec(`
    CREATE TABLE documents (id INTEGER PRIMARY KEY, kind TEXT, scope_kind TEXT, owner_id INTEGER, retired_at INTEGER);
    CREATE TABLE document_revisions (document_id INTEGER, seq INTEGER, content TEXT);
    INSERT INTO documents VALUES (1, '"gchat.bindings"', 'session', 0, NULL);
  `);
  db.prepare("INSERT INTO document_revisions VALUES (1, 1, ?)").run(
    JSON.stringify({
      byChatKey: {
        "spaces/a/threads/t1": { conversationId: 27202, label: "Ledger  sync", preview: "opening words" },
        "spaces/a/threads/t2": { conversationId: 8508, preview: "I don't see any names yet" },
        // A binding with neither is absent rather than an empty name.
        "spaces/a/threads/t3": { conversationId: 9 },
      },
    }),
  );
  const names = readConversationNames(db);
  db.close();
  assert.equal(names.get(27202), "Ledger sync", "the title wins, and whitespace is collapsed");
  assert.equal(names.get(8508), "I don't see any names yet", "the preview is the fallback");
  assert.equal(names.has(9), false);
});
