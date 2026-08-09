import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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
  ) {}

  static async create(
    cwd: string,
    sessionsDir: string,
    stallTimeoutMs: number,
    watchdogIntervalMs: number,
  ): Promise<AgentRouter> {
    const router = new AgentRouter(cwd, sessionsDir, stallTimeoutMs, watchdogIntervalMs);
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

  /** Stable per-conversation key: the thread when threaded, else the space. */
  static keyFor(spaceName: string, threadName?: string): string {
    return threadName ?? spaceName;
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
    } finally {
      unsubscribe?.();
    }
    return this.lastAssistantText(entry.session);
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
          byPath.set(file, { label: f.replace(/\.jsonl$/, ""), file, mtimeMs: fs.statSync(file).mtimeMs });
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
          (s.firstMessage ? s.firstMessage.slice(0, 40) : path.basename(s.path, ".jsonl"));
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
    };
    // Long-lived listener: any agent event counts as activity for the watchdog.
    entry.session.subscribe(() => {
      entry.lastActivityAt = Date.now();
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
