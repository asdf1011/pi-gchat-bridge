#!/usr/bin/env node
/**
 * List the files one conversation wrote or edited.
 *
 *   npx tsx src/scripts/artifacts.ts 6317
 *   npx tsx src/scripts/artifacts.ts 6317 --json
 *   npx tsx src/scripts/artifacts.ts            # every conversation, with counts
 *
 * Reads the database directly and read-only, on purpose. The alternative — open
 * a `Harness` — would take the bridge's pid lock and refuse to start while the
 * bridge is running, which is exactly when this is most useful. `node:sqlite`'s
 * read-only mode has been shown to work against this database with the bridge
 * live, including its WAL.
 *
 * `node:sqlite` is imported through `createRequire` because `@types/node` here
 * predates the module; the shape used is four methods wide.
 */
import { createRequire } from "node:module";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { artifactRoots, deriveArtifacts, type ArtifactEntryLike } from "../durable/artifacts.js";

interface Prepared {
  all(...params: unknown[]): unknown[];
}
interface Database {
  prepare(sql: string): Prepared;
  close(): void;
}

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => Database;
};

const dbPath = process.env.BRIDGE_DB ?? new URL("../../bridge.sqlite", import.meta.url).pathname;
const roots = artifactRoots(process.env.PI_CWD ?? "/workspace", getAgentDir());

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const requested = args.filter((arg) => !arg.startsWith("--"));

const db = new DatabaseSync(dbPath, { readOnly: true });

/** Entries in commit order, in the shape the derivation expects. */
function entriesOf(conversationId: number): ArtifactEntryLike[] {
  const rows = db
    .prepare("select id, record from entries where conversation_id = ? order by commit_seq asc")
    .all(conversationId) as { id: number; record: string }[];
  return rows.map((row) => {
    const record = JSON.parse(row.record) as { model?: ArtifactEntryLike["model"] };
    return { id: row.id, model: record.model } as ArtifactEntryLike;
  });
}

function conversationIds(): number[] {
  const rows = db.prepare("select id from conversations order by id desc").all() as { id: number }[];
  return rows.map((row) => row.id);
}

try {
  const ids = requested.length > 0 ? requested.map(Number) : conversationIds();
  if (requested.length > 0 && ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    process.stderr.write("usage: artifacts.ts [conversationId ...] [--json]\n");
    process.exit(2);
  }

  const results = ids.map((id) => ({
    conversationId: id,
    artifacts: deriveArtifacts(entriesOf(id), roots),
  }));

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ roots, conversations: results }, null, 2)}\n`);
  } else {
    process.stdout.write(`roots: ${roots.join("  ")}\n`);
    for (const result of results) {
      if (requested.length === 0 && result.artifacts.length === 0) continue;
      process.stdout.write(`\nconversation ${result.conversationId} — ${result.artifacts.length} artifact(s)\n`);
      for (const artifact of result.artifacts) {
        const touches = [
          artifact.wrote > 0 ? `${artifact.wrote}w` : "",
          artifact.edited > 0 ? `${artifact.edited}e` : "",
        ]
          .filter((part) => part !== "")
          .join(" ");
        process.stdout.write(`  ${touches.padEnd(4)} ${artifact.key}\n`);
      }
    }
  }
} finally {
  db.close();
}
