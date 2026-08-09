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
}

/** A session offered in the resume picker. */
export interface SessionInfo {
  /** Display label (derived from the file name). */
  label: string;
  /** Absolute path to the session JSONL. */
  file: string;
}

/**
 * Routes incoming Chat messages to a per-space pi AgentSession.
 *
 * - Each Chat space gets its own persistent pi session (JSONL file under
 *   `sessions/`), so conversations survive bridge restarts.
 * - Sessions are created lazily when a space first messages the bot.
 * - While a session is streaming, new messages are left for the next poll
 *   (serial processing). `handleMessage` returns null in that case.
 */
export class AgentRouter {
  private sessions = new Map<string, SpaceEntry>();
  private modelRuntime: ModelRuntime | undefined;

  private constructor(
    private cwd: string,
    private sessionsDir: string,
  ) {}

  static async create(cwd: string, sessionsDir: string): Promise<AgentRouter> {
    const router = new AgentRouter(cwd, sessionsDir);
    router.modelRuntime = await ModelRuntime.create();
    return router;
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
    spaceName: string,
    text: string,
    onDelta?: (delta: string) => void,
  ): Promise<string | null> {
    let entry = this.sessions.get(spaceName);
    if (!entry) {
      entry = await this.openOrCreateSession(spaceName);
      this.sessions.set(spaceName, entry);
    }

    if (entry.session.isStreaming) {
      console.log(`[router] ${spaceName} busy, skipping message`);
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

  /** Whether the session for this space is currently streaming (busy). */
  isBusy(spaceName: string): boolean {
    return this.sessions.get(spaceName)?.session.isStreaming ?? false;
  }

  /** List session JSONL files available in the sessions dir. */
  listSessions(): SessionInfo[] {
    if (!fs.existsSync(this.sessionsDir)) return [];
    return fs
      .readdirSync(this.sessionsDir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort((a, b) => fs.statSync(path.join(this.sessionsDir, b)).mtimeMs - fs.statSync(path.join(this.sessionsDir, a)).mtimeMs)
      .map((f) => ({
        label: f.replace(/\.jsonl$/, ""),
        file: path.join(this.sessionsDir, f),
      }));
  }

  /**
   * Resume a different session file for a space: tear down the current
   * session and open the target JSONL (created if missing). Returns the
   * label of the session now active, or null if busy.
   */
  async switchSession(spaceName: string, file: string): Promise<string | null> {
    const entry = this.sessions.get(spaceName);
    if (entry?.session.isStreaming) {
      console.log(`[router] ${spaceName} busy, refusing session switch`);
      return null;
    }
    const label = path.basename(file).replace(/\.jsonl$/, "");
    const opened = await this.openOrCreateSession(spaceName, file);
    const prev = this.sessions.get(spaceName);
    this.sessions.set(spaceName, opened);
    prev?.session.dispose();
    console.log(`[router] ${spaceName} switched to session ${label} -> ${file}`);
    return label;
  }

  dispose(): void {
    for (const { session } of this.sessions.values()) {
      try {
        session.dispose();
      } catch {
        // best effort
      }
    }
    this.sessions.clear();
  }

  private async openOrCreateSession(spaceName: string, file?: string): Promise<SpaceEntry> {
    const target = file ?? this.sessionFileFor(spaceName);
    if (!fs.existsSync(target)) {
      fs.writeFileSync(target, SESSION_HEADER(this.cwd) + "\n");
    }
    const { session } = await createAgentSession({
      cwd: this.cwd,
      modelRuntime: this.modelRuntime,
      sessionManager: SessionManager.open(target),
    });
    console.log(`[router] opened session for ${spaceName} -> ${target}`);
    return { session };
  }

  private sessionFileFor(spaceName: string): string {
    const safe = spaceName.replace(/[^a-zA-Z0-9]/g, "_");
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
