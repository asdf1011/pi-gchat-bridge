/**
 * A second bridge: a CLI that reads a conversation and can speak into it.
 *
 * It is deliberately the smallest possible surface — no streaming, no tools, no model —
 * because its real job is to be evidence. If adding a surface to this architecture needs
 * server changes, the architecture is wrong, and finding that out here costs a day rather
 * than a week.
 *
 * What it demonstrates, in the order the design claims them:
 *
 *   - **the cursor is the client's.** It keeps its own position per conversation in a
 *     small file, so a CLI that has been closed for a week resumes where it left off —
 *     and a CLI with no file adopts at the head rather than replaying a conversation.
 *   - **reads are pull, and that is enough.** `GET /entries?since=N`. No subscription, no
 *     heartbeat: a tool a person runs is not a service that must be live.
 *   - **writing is a submission, not a message.** `POST /submissions` puts words into the
 *     conversation with an origin of `cli`, so every existing surface treats it like any
 *     other turn — Chat quotes it, the pane renders it, and nothing about the CLI is
 *     special-cased anywhere.
 *
 * Serving it: the server's own HTTP listener answers `/v1` (see `adapter/v1-routes.ts`).
 * This file is only the client, which is why it can be tested against a stub.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** One entry as the protocol reports it. */
export interface CliEntry {
  entryId: number;
  role: "user" | "assistant";
  text: string;
  at?: number;
  origin?: string;
}

export interface CliState {
  version: 1;
  /** Last entry this CLI has printed, per conversation. Its own position, not the server's. */
  conversations: Record<string, { cursor: number }>;
}

export interface CliDeps {
  /** e.g. `http://127.0.0.1:8081` */
  baseUrl: string;
  token?: string;
  statePath?: string;
  /** Where output goes; injected so tests can read it. */
  out?(line: string): void;
  fetch?(input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
  }>;
}

export function defaultStatePath(): string {
  return process.env.BRIDGE_CLI_STATE ?? path.join(os.homedir(), ".pi", "bridge-cli.json");
}

/** Load the CLI's positions. A missing or broken file is an empty one — never a crash. */
export async function loadState(file: string): Promise<CliState> {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, "utf8")) as Partial<CliState>;
    if (parsed?.version === 1 && typeof parsed.conversations === "object" && parsed.conversations !== null) {
      return { version: 1, conversations: parsed.conversations as CliState["conversations"] };
    }
  } catch {
    // First run, or a file somebody edited by hand. Both mean "no position".
  }
  return { version: 1, conversations: {} };
}

export async function saveState(file: string, state: CliState): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(state, null, 1)}\n`, "utf8");
  await fsp.rename(temporary, file);
}

async function call(deps: CliDeps, pathname: string, init?: { method?: string; body?: unknown }): Promise<unknown> {
  const fetchImpl = deps.fetch ?? ((input, options) => fetch(input, options as RequestInit));
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (deps.token) headers.Authorization = `Bearer ${deps.token}`;
  const response = await fetchImpl(`${deps.baseUrl.replace(/\/$/, "")}${pathname}`, {
    method: init?.method ?? "GET",
    headers,
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const body = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
  if (!response.ok) {
    const message = (body as { error?: unknown }).error;
    throw new Error(typeof message === "string" ? message : `HTTP ${response.status}`);
  }
  return body;
}

/** `list`: what conversations this bridge can see, and where its own position is. */
export async function list(deps: CliDeps, state?: CliState): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const body = (await call(deps, "/v1/conversations")) as {
    items?: { conversationId: number; address: string; name?: string; lastActivityAt?: number }[];
  };
  const positions = state ?? (await loadState(deps.statePath ?? defaultStatePath()));
  const items = body.items ?? [];
  for (const item of items) {
    const since = positions.conversations[String(item.conversationId)]?.cursor ?? 0;
    out(
      `${String(item.conversationId).padStart(6)}  ${item.address}` +
        `${item.name === undefined ? "" : `  "${item.name}"`}` +
        `  at ${since === 0 ? "head-on-first-read" : `entry ${since}`}`,
    );
  }
  return items.length;
}

/**
 * `tail`: print entries after this CLI's position and advance it.
 *
 * One pass, or `follow` to keep asking. Polling is honest here: a person watching a
 * terminal is not a service that must be notified, and the design's rule against polling
 * is about a *delivering* bridge that should learn from its transport instead.
 */
export async function tail(
  deps: CliDeps,
  options: { conversationId: number; follow?: boolean; intervalMs?: number; once?: boolean },
): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const file = deps.statePath ?? defaultStatePath();
  const state = await loadState(file);
  const key = String(options.conversationId);

  if (state.conversations[key] === undefined) {
    // Adopt at the head, like every other bridge: a first read prints what happens next
    // rather than a captured conversation.
    const head = (await call(
      deps,
      `/v1/conversations/${options.conversationId}/entries?since=0&limit=1`,
    )) as { newest?: number; entries?: CliEntry[] };
    const newest = head.newest ?? 0;
    state.conversations[key] = { cursor: newest };
    await saveState(file, state);
    out(
      `# adopted at entry ${newest} — this CLI prints what happens from now on ` +
        `(state in ${file})`,
    );
  }

  let printed = 0;
  const pass = async (): Promise<boolean> => {
    const since = state.conversations[key]?.cursor ?? 0;
    const body = (await call(
      deps,
      `/v1/conversations/${options.conversationId}/entries?since=${since}&limit=50`,
    )) as { entries?: CliEntry[] };
    const entries = body.entries ?? [];
    for (const entry of entries) {
      const who = entry.origin === undefined ? entry.role : `${entry.role}:${entry.origin}`;
      out(`[${entry.entryId}] ${who}: ${entry.text.replace(/\s+/g, " ").slice(0, 200)}`);
      state.conversations[key] = { cursor: entry.entryId };
      printed += 1;
    }
    if (entries.length > 0) await saveState(file, state);
    return entries.length > 0;
  };

  await pass();
  if (!options.follow) return printed;

  // Deliberately simple: a fixed interval, no heartbeat, no reconnection ladder. A CLI is
  // run by a person, and Ctrl-C is the supervision.
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 5_000));
    await pass();
  }
}

/** `say`: put words into the conversation. The origin makes it a first-class message. */
export async function say(
  deps: CliDeps,
  conversationId: number,
  text: string,
  /** Stable per attempt, so a retried `say` is the same submission rather than a second message. */
  requestId: string = randomUUID(),
): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const body = (await call(deps, `/v1/conversations/${conversationId}/submissions`, {
    method: "POST",
    body: { text, origin: "cli", requestId },
  })) as { submissionId?: number };
  out(`submitted ${body.submissionId ?? "?"} to conversation ${conversationId} (origin cli)`);
  return body.submissionId ?? 0;
}

const USAGE = [
  "usage: bridge-cli <command> [options]",
  "",
  "  list                       conversations this bridge can see, with its own position",
  "  tail   --conversation <id> [--follow]     print new entries, then remember where it got to",
  "  say    --conversation <id> <words…>       submit a message as the cli surface",
  "",
  "env: BRIDGE_URL (default http://127.0.0.1:8081), BRIDGE_WEB_TOKEN,",
  "     BRIDGE_CLI_STATE (default ~/.pi/bridge-cli.json)",
].join("\n");

/** The command line, in one function so a test can drive it as a person would. */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const [command, ...rest] = argv;
  const conversationAt = rest.indexOf("--conversation");
  const conversationId = conversationAt === -1 ? undefined : Number(rest[conversationAt + 1]);
  const positional = rest.filter((value, index) => value !== "--conversation" && index !== conversationAt + 1);
  const follow = rest.includes("--follow");

  switch (command) {
    case "list":
      // `list` returns how many it printed; the exit code is whether it worked.
      await list(deps);
      return 0;
    case "tail": {
      if (conversationId === undefined || !Number.isFinite(conversationId)) {
        out("tail needs --conversation <id>");
        return 2;
      }
      await tail(deps, { conversationId, follow });
      return 0;
    }
    case "say": {
      if (conversationId === undefined || !Number.isFinite(conversationId)) {
        out("say needs --conversation <id>");
        return 2;
      }
      const text = positional.join(" ").trim();
      if (text === "") {
        out("say needs words");
        return 2;
      }
      await say(deps, conversationId, text);
      return 0;
    }
    default:
      out(USAGE);
      return command === undefined || command === "--help" ? 0 : 2;
  }
}

// Entry point when run directly (`tsx src/scripts/bridge-cli.ts …`).
if (process.argv[1] && /bridge-cli\.(ts|js)$/.test(process.argv[1]) && fs.existsSync(process.argv[1])) {
  const baseUrl = process.env.BRIDGE_URL ?? "http://127.0.0.1:8081";
  const token = process.env.BRIDGE_WEB_TOKEN ?? "";
  void runCli(process.argv.slice(2), { baseUrl, ...(token ? { token } : {}) }).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(`bridge-cli: ${(error as Error).message}`);
      process.exit(1);
    },
  );
}
