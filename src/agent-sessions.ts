import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

/** Minimal structural view of pi messages, so we don't depend on exact exports. */
interface PiBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}
interface PiMessage {
  role: string;
  content?: string | PiBlock[];
}

const SESSION_HEADER = (cwd: string): string =>
  JSON.stringify({
    type: "session",
    version: 3,
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    cwd,
  });

interface SpaceEntry {
  session: AgentSession;
  /** Absolute path to the session JSONL (needed to reopen after a watchdog reset). */
  file: string;
  /** Last time any agent event fired (watchdog stall detection). */
  lastActivityAt: number;
  /** True while a watchdog reset is in progress for this session. */
  resetting: boolean;
  /** In-flight tool calls (tool_execution_start/end deltas). */
  toolsInFlight: number;
  /** Steered messages awaiting delivery into the running turn. */
  pendingSteers: { text: string; delivered: boolean }[];
}

/** Extract plain text from a pi message content (string or block array). */
function contentText(content: unknown): string {
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
function truncate(text: string, max = 60): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Best available display label for a session file, read straight from the
 * JSONL (pi persists all of these):
 *   1. user-set display name (session_info entries, set via /name)
 *   2. compaction summary (pi's LLM-generated summary of the conversation)
 *   3. first user message text
 *   4. fallback: file name (e.g. `spaces_<id>`) — only when the file has
 *      none of the above (e.g. empty/image-only sessions)
 *
 * Streams the file so large sessions don't get fully buffered in memory.
 */
async function summarizeSessionFile(file: string): Promise<string> {
  let name: string | undefined;
  let firstUserText = "";
  let compactionSummary = "";
  try {
    const rl = readline.createInterface({
      input: fs.createReadStream(file, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let entry: { type?: string; name?: string; summary?: string; message?: PiMessage };
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // unparsable line — skip it, don't give up on the file
      }
      if (entry.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) {
        name = entry.name.trim();
      } else if (entry.type === "message" && entry.message?.role === "user" && !firstUserText) {
        firstUserText = contentText(entry.message.content).trim();
      } else if (entry.type === "compaction" && typeof entry.summary === "string" && entry.summary.trim() && !compactionSummary) {
        compactionSummary = entry.summary.trim();
      }
      if (name && firstUserText && compactionSummary) break; // all sources found, stop early
    }
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

/**
 * Resolve with the promise's value, or `undefined` after `ms` — so a wedged
 * abort (e.g. an uninterruptible tool child) can never block recovery.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms)),
  ]);
}

/** A session offered in the resume picker. */
export interface SessionInfo {
  /** Display label (derived from the file name). */
  label: string;
  /** Absolute path to the session JSONL. */
  file: string;
  /** For sorting (most recently modified first). */
  mtimeMs: number;
}

/** A model offered in the model picker. */
export interface ModelInfo {
  provider: string;
  id: string;
  label: string;
}

/** Result of a model switch. */
export interface SwitchModelResult {
  ok: boolean;
  label: string;
  error?: string;
}

/**
 * Routes incoming Chat messages to a per-thread pi AgentSession.
 *
 * - Each Chat thread gets its own persistent pi session (JSONL file under
 *   `sessions/`), so conversations are fully independent and survive bridge
 *   restarts. Sessions are created lazily on first message in a thread.
 * - Sessions for different threads run CONCURRENTLY (the receiver dispatches
 *   handlers without awaiting them); a stream in one thread never blocks
 *   another. Within a thread, messages are serialized (busy → redelivered
 *   later, Pub/Sub acts as the per-thread queue).
 * - `handleMessage` returns null when a thread's session is already streaming,
 *   and the caller leaves the message unacked so it is retried later.
 */
export class AgentRouter {
  private sessions = new Map<string, SpaceEntry>();
  /** In-flight session creations, keyed by session key (dedupes races). */
  private creating = new Map<string, Promise<SpaceEntry>>();
  private modelRuntime: ModelRuntime | undefined;
  private watchdogTimer: NodeJS.Timeout | undefined;

  private constructor(
    private cwd: string,
    private sessionsDir: string,
    /** Max streaming time with zero agent events before a session is force-reset (0 = disabled). */
    private stallTimeoutMs: number,
    /** How often the watchdog scans for stalled sessions. */
    private watchdogIntervalMs: number,
    /** How long to wait for an in-flight tool call before aborting to redirect. */
    private steerWaitMs: number,
  ) {}

  static async create(
    cwd: string,
    sessionsDir: string,
    stallTimeoutMs: number,
    watchdogIntervalMs: number,
    steerWaitMs: number,
  ): Promise<AgentRouter> {
    const router = new AgentRouter(cwd, sessionsDir, stallTimeoutMs, watchdogIntervalMs, steerWaitMs);
    router.modelRuntime = await ModelRuntime.create();
    if (router.stallTimeoutMs > 0 && router.watchdogIntervalMs > 0) {
      router.watchdogTimer = setInterval(() => {
        void router.watchdogTick().catch((err) =>
          console.error("[watchdog] tick failed:", (err as Error).message),
        );
      }, router.watchdogIntervalMs);
      console.log(`[router] watchdog enabled: stall=${router.stallTimeoutMs}ms interval=${router.watchdogIntervalMs}ms`);
    } else {
      console.log("[router] watchdog disabled");
    }
    return router;
  }

  /**
   * Stable per-conversation key, in priority order:
   *   1. threadKey — the app-chosen identifier stored on threads the app
   *      creates (Google echoes it back in events). Space-prefixed so the same
   *      key in different spaces can't collide.
   *   2. thread name — for threads the app didn't create (no threadKey).
   *   3. space — fallback for non-threaded DMs.
   */
  static keyFor(spaceName: string, threadName?: string, threadKey?: string): string {
    return threadKey ? `${spaceName}/${threadKey}` : (threadName ?? spaceName);
  }

  /**
   * @returns the assistant reply text, or null if the session was busy and the
   * message was skipped (caller should NOT mark it processed/acked so it is
   * redelivered later).
   *
   * If `onDelta` is provided, it is called with each streamed text delta from
   * the assistant, so the caller can render a live reply.
   */
  async handleMessage(
    sessionKey: string,
    spaceName: string,
    text: string,
    onDelta?: (delta: string) => void,
  ): Promise<string | null> {
    let entry = this.sessions.get(sessionKey);
    if (!entry) {
      entry = await this.openOrCreateSession(sessionKey, spaceName);
      this.sessions.set(sessionKey, entry);
    }

    if (entry.session.isStreaming) {
      console.log(`[router] ${sessionKey} busy, skipping message`);
      return null;
    }

    const unsubscribe = onDelta
      ? entry.session.subscribe((event) => {
          if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
            onDelta(event.assistantMessageEvent.delta);
          }
        })
      : undefined;

    try {
      await entry.session.prompt(text);
      let reply = this.lastAssistantText(entry.session);
      // Guaranteed delivery: any steers that were queued but never injected
      // into the running turn get their own follow-up prompt now, so no
      // steered message is ever silently lost.
      const undelivered = entry.pendingSteers.filter((s) => !s.delivered);
      for (const steer of undelivered) {
        steer.delivered = true;
        await entry.session.prompt(steer.text);
        reply = `${reply}${reply ? "\n\n" : ""}${this.lastAssistantText(entry.session)}`;
      }
      entry.pendingSteers = [];
      return reply.trim() || null;
    } finally {
      unsubscribe?.();
    }
  }

  /** Whether the session for this conversation is currently streaming (busy). */
  isBusy(sessionKey: string): boolean {
    return this.sessions.get(sessionKey)?.session.isStreaming ?? false;
  }

  /**
   * List session JSONL files available for the resume picker: the bridge's
   * own session store plus pi's global session store (what the TUI /resume
   * shows), so sessions from other projects/spaces appear too.
   */
  async listSessions(): Promise<SessionInfo[]> {
    const byPath = new Map<string, SessionInfo>();

    // 1. Bridge sessions (custom store under BRIDGE_SESSIONS_DIR).
    if (fs.existsSync(this.sessionsDir)) {
      for (const f of fs.readdirSync(this.sessionsDir).filter((x) => x.endsWith(".jsonl"))) {
        const file = path.join(this.sessionsDir, f);
        try {
          const label = await summarizeSessionFile(file);
          byPath.set(file, { label, file, mtimeMs: fs.statSync(file).mtimeMs });
        } catch {
          // race: file deleted mid-scan
        }
      }
    }

    // 2. pi's global sessions (TUI store) — all projects, so the picker shows
    //    every session, not just this space's.
    try {
      const all = await SessionManager.listAll();
      for (const s of all) {
        const base =
          s.name ??
          (s.firstMessage ? truncate(s.firstMessage, 40) : path.basename(s.path, ".jsonl"));
        const label = s.cwd && s.cwd !== this.cwd ? `${base} · ${s.cwd}` : base;
        byPath.set(s.path, { label, file: s.path, mtimeMs: s.modified.getTime() });
      }
    } catch (err) {
      console.error("[router] SessionManager.listAll failed:", (err as Error).message);
    }

    return [...byPath.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  /**
   * List usable models (auth-filtered availability snapshot — no network).
   * Returns [] if no provider auth is configured; switch-time auth is checked
   * again by setModel().
   */
  listModels(): ModelInfo[] {
    if (!this.modelRuntime) return [];
    return this.modelRuntime
      .getAvailableSnapshot()
      .map((m) => ({
        provider: m.provider ?? "",
        id: m.id,
        label: `${m.name ?? m.id}${m.provider ? ` (${m.provider})` : ""}`,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  /**
   * Switch the active model for a conversation's session. Fails (without
   * touching the session) if the session is busy or the model needs auth we
   * don't have.
   */
  async switchModel(sessionKey: string, providerId: string, modelId: string): Promise<SwitchModelResult> {
    const entry = this.sessions.get(sessionKey);
    if (!entry) return { ok: false, label: modelId, error: "No active session for this conversation" };
    if (entry.session.isStreaming) {
      return { ok: false, label: modelId, error: "busy" };
    }
    if (!this.modelRuntime) return { ok: false, label: modelId, error: "No model runtime" };
    const model = this.modelRuntime.getModel(providerId, modelId);
    if (!model) return { ok: false, label: modelId, error: `Unknown model ${providerId}/${modelId}` };
    try {
      await entry.session.setModel(model);
      return { ok: true, label: `${model.name ?? model.id}${providerId ? ` (${providerId})` : ""}` };
    } catch (err) {
      return { ok: false, label: modelId, error: (err as Error).message };
    }
  }

  /**
   * Resume a different session file for a conversation: tear down the current
   * session and open the target JSONL (created if missing). Returns the label
   * of the session now active, or null if busy.
   */
  async switchSession(sessionKey: string, file: string): Promise<string | null> {
    const entry = this.sessions.get(sessionKey);
    if (entry?.session.isStreaming) {
      console.log(`[router] ${sessionKey} busy, refusing session switch`);
      return null;
    }
    const label = path.basename(file).replace(/\.jsonl$/, "");
    const opened = await this.openOrCreateSession(sessionKey, sessionKey, file);
    const prev = this.sessions.get(sessionKey);
    this.sessions.set(sessionKey, opened);
    prev?.session.dispose();
    console.log(`[router] ${sessionKey} switched to session ${label} -> ${file}`);
    return label;
  }

  /**
   * Get the current display name of the conversation's session (the latest
   * `session_info` entry), or undefined when none is set / no session exists.
   */
  async getSessionName(sessionKey: string): Promise<string | undefined> {
    const file = this.sessions.get(sessionKey)?.file;
    if (!file || !fs.existsSync(file)) return undefined;
    let name: string | undefined;
    try {
      const rl = readline.createInterface({
        input: fs.createReadStream(file, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as { type?: string; name?: string };
          // Later session_info entries overwrite earlier ones (pi does the same).
          if (parsed.type === "session_info" && typeof parsed.name === "string") {
            name = parsed.name.trim() || undefined;
          }
        } catch {
          // skip unparsable lines
        }
      }
    } catch {
      // unreadable file
    }
    return name;
  }

  /**
   * Set a display name for the conversation's session (shown in the session
   * picker instead of the first message). Returns the name, or null when the
   * conversation has no session yet (send a message first).
   */
  setSessionName(sessionKey: string, name: string): string | null {
    const entry = this.sessions.get(sessionKey);
    if (!entry) return null;
    entry.session.setSessionName(name);
    return name;
  }

  /**
   * Session stats for a conversation (aggregated over the WHOLE session file,
   * including compacted history — i.e. what was actually billed), or null when
   * the conversation has no session yet.
   */
  sessionStats(sessionKey: string): import("@earendil-works/pi-coding-agent").SessionStats | null {
    const entry = this.sessions.get(sessionKey);
    if (!entry) return null;
    return entry.session.getSessionStats();
  }

  /**
   * Steer a message into the RUNNING turn (interleaved): queued now, delivered
   * after the current assistant turn finishes its tool calls and before the
   * next LLM call — so in-flight tool results land first, then the model
   * addresses both the original work and the new message together. Returns
   * false if the session wasn't streaming (caller falls back to a normal
   * prompt).
   */
  async steer(sessionKey: string, text: string): Promise<boolean> {
    const entry = this.sessions.get(sessionKey);
    if (!entry || !entry.session.isStreaming) return false;
    // Track for guaranteed delivery (fix: steers never silently lost).
    entry.pendingSteers.push({ text, delivered: false });
    try {
      await entry.session.steer(text);
      return true;
    } catch (err) {
      console.error(`[router] ${sessionKey} steer failed:`, (err as Error).message);
      entry.pendingSteers.pop();
      return false;
    }
  }

  /**
   * Deliver a message to a streaming conversation with a bounded tool wait:
   * - if a tool call is in flight, wait up to `steerWaitMs` for it to finish
   *   (its result lands, then the steer delivers right after)
   * - if the tool is still running after the cap, abort and redirect instead
   *   (implicit stop) so the interjection is never stuck behind a long tool.
   * Returns "steered" | "redirected" | "not-busy".
   */
  async redirect(sessionKey: string, text: string): Promise<"steered" | "redirected" | "not-busy"> {
    const entry = this.sessions.get(sessionKey);
    if (!entry || !entry.session.isStreaming) return "not-busy";

    if (entry.toolsInFlight > 0) {
      const deadline = Date.now() + this.steerWaitMs;
      while (entry.toolsInFlight > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (entry.toolsInFlight > 0) {
        console.log(
          `[router] ${sessionKey} tool still running after ${this.steerWaitMs}ms — aborting to redirect`,
        );
        await this.interrupt(sessionKey);
        return "redirected";
      }
    }

    return (await this.steer(sessionKey, text)) ? "steered" : "not-busy";
  }

  /**
   * Implicit stop: a new message while a conversation is streaming aborts the
   * current run so the new message can redirect it. The aborted turn is KEPT
   * in the session (pi marks it stopReason "aborted" and the context builder
   * handles it), so the redirect has the full context of why the interrupt
   * happened. Only a genuinely wedged session (abort can't clear it) falls
   * back to the watchdog forceReset (truncate + dispose + reopen).
   */
  async interrupt(sessionKey: string): Promise<void> {
    const entry = this.sessions.get(sessionKey);
    if (!entry || !entry.session.isStreaming) return;
    console.log(`[router] ${sessionKey} interrupting current run (implicit stop)`);
    await withTimeout(entry.session.abort(), 15_000);
    if (entry.session.isStreaming) {
      console.log(`[router] ${sessionKey} still streaming after abort — force-resetting`);
      await this.forceReset(sessionKey, entry);
      return;
    }
    console.log(`[router] ${sessionKey} interrupted — aborted turn kept in context`);
  }

  /**
   * Scan for sessions that have been streaming with no agent activity for
   * longer than the stall threshold (a hung tool call — e.g. a network fetch
   * without a timeout — produces no events, so the session never frees up and
   * every message in that conversation is deferred as "busy" forever).
   */
  private async watchdogTick(): Promise<void> {
    const now = Date.now();
    for (const [key, entry] of [...this.sessions.entries()]) {
      if (entry.resetting || !entry.session.isStreaming) continue;
      const stalledMs = now - entry.lastActivityAt;
      if (stalledMs < this.stallTimeoutMs) continue;
      console.log(
        `[watchdog] ${key} stalled ${Math.round(stalledMs / 1000)}s without agent activity — force-resetting`,
      );
      try {
        await this.forceReset(key, entry);
      } catch (err) {
        console.error(`[watchdog] reset of ${key} failed:`, (err as Error).message);
      }
    }
  }

  /**
   * Recover a wedged session: abort the stuck run, drop the incomplete
   * trailing turn (so a re-open can't re-run the hung tool call), then tear
   * down and reopen the session from the same JSONL file. Deferred "busy"
   * messages are redelivered by Pub/Sub and land on the fresh session.
   */
  private async forceReset(key: string, entry: SpaceEntry): Promise<void> {
    entry.resetting = true;
    try {
      // 1. Abort the stuck run — this kills the tool's process tree. Bounded
      //    so a wedged abort can't block recovery.
      await withTimeout(entry.session.abort(), 15_000);
      // 2. Remove any trailing assistant turn(s) that never completed (have
      //    unanswered tool calls) from the file.
      const dropped = this.truncateIncompleteTail(entry.file);
      // 3. Replace the wedged in-memory session with a fresh one on the file.
      entry.session.dispose();
      this.sessions.delete(key);
      const reopened = await this.openOrCreateSession(key, key, entry.file);
      this.sessions.set(key, reopened);
      console.log(`[watchdog] ${key} reset (dropped ${dropped} incomplete entr${dropped === 1 ? "y" : "ies"}), session reopened`);
    } finally {
      entry.resetting = false;
    }
  }

  /**
   * Rewrite the session file, dropping trailing message entries whose
   * assistant turn never completed (assistant messages with unanswered tool
   * calls). Returns the number of entries dropped, 0 if already clean.
   */
  private truncateIncompleteTail(file: string | undefined): number {
    if (!file || !fs.existsSync(file)) return 0;
    const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0);
    let lastCompleted = -1;
    for (let i = 0; i < lines.length; i++) {
      try {
        const entry = JSON.parse(lines[i]) as {
          type?: string;
          message?: { role?: string; content?: Array<{ type?: string }> };
        };
        if (entry.type !== "message") continue;
        const message = entry.message ?? {};
        if (message.role === "assistant" && !(message.content ?? []).some((b) => b.type === "toolCall")) {
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

  dispose(): void {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    for (const { session } of this.sessions.values()) {
      try {
        session.dispose();
      } catch {
        // best effort
      }
    }
    this.sessions.clear();
  }

  /**
   * Open (or create) the session file for a conversation key. Serialized per
   * key so concurrent first-messages in the same thread can't double-create.
   */
  private openOrCreateSession(sessionKey: string, spaceName: string, file?: string): Promise<SpaceEntry> {
    const existing = this.sessions.get(sessionKey);
    if (existing) return Promise.resolve(existing);
    const inFlight = this.creating.get(sessionKey);
    if (inFlight) return inFlight;

    const p = this.doOpen(sessionKey, spaceName, file).finally(() => {
      this.creating.delete(sessionKey);
    });
    this.creating.set(sessionKey, p);
    return p;
  }

  private async doOpen(sessionKey: string, spaceName: string, file?: string): Promise<SpaceEntry> {
    const target = file ?? this.sessionFileFor(sessionKey);
    const legacy = this.sessionFileFor(spaceName);
    // One-time migration: the pre-parallel bridge kept one session per SPACE.
    // The first thread to open after upgrade inherits that file so history
    // isn't lost; new threads get fresh files.
    if (file === undefined && !fs.existsSync(target) && legacy !== target && fs.existsSync(legacy)) {
      fs.renameSync(legacy, target);
      console.log(`[router] migrated ${legacy} -> ${target}`);
    }
    if (!fs.existsSync(target)) {
      fs.writeFileSync(target, SESSION_HEADER(this.cwd) + "\n");
    }
    const { session } = await createAgentSession({
      cwd: this.cwd,
      modelRuntime: this.modelRuntime,
      sessionManager: SessionManager.open(target),
    });
    const entry: SpaceEntry = {
      session,
      file: target,
      lastActivityAt: Date.now(),
      resetting: false,
      toolsInFlight: 0,
      pendingSteers: [],
    };
    // Long-lived listener: any agent event counts as activity for the watchdog;
    // tool_execution start/end tracks in-flight tools (bounded steer wait);
    // a user message_start matching a queued steer marks it as delivered.
    entry.session.subscribe((event) => {
      entry.lastActivityAt = Date.now();
      if (event.type === "tool_execution_start") {
        entry.toolsInFlight++;
      } else if (event.type === "tool_execution_end") {
        entry.toolsInFlight = Math.max(0, entry.toolsInFlight - 1);
      } else if (event.type === "message_start" && event.message?.role === "user") {
        const text = contentText(event.message.content);
        const pending = entry.pendingSteers.find((s) => !s.delivered && s.text === text);
        if (pending) pending.delivered = true;
      }
    });
    console.log(`[router] opened session for ${sessionKey} -> ${target}`);
    return entry;
  }

  private sessionFileFor(sessionKey: string): string {
    const safe = sessionKey.replace(/[^a-zA-Z0-9]/g, "_");
    return path.join(this.sessionsDir, `${safe}.jsonl`);
  }

  private lastAssistantText(session: AgentSession): string {
    const messages = session.messages as unknown as PiMessage[];
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role !== "assistant") continue;
      const blocks = Array.isArray(message.content) ? message.content : [];
      const text = blocks
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("");
      if (text.trim()) return text;
    }
    return "";
  }
}
