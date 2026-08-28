import fs from "node:fs";

/**
 * Persists per-space dedupe state: which messages we have already handed to
 * pi. Plus persistent /resume overrides.
 */
interface SpaceState {
  processed: string[];
}

interface StateFile {
  spaces: Record<string, SpaceState>;
  /** Persistent /resume overrides: conversation sessionKey -> session file path. */
  resumeMap: Record<string, string>;
}

const MAX_PROCESSED_PER_SPACE = 1000;

export class StateStore {
  private state: StateFile;

  constructor(private file: string) {
    this.state = this.load();
  }

  private load(): StateFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as StateFile;
      return { spaces: parsed.spaces ?? {}, resumeMap: parsed.resumeMap ?? {} };
    } catch {
      return { spaces: {}, resumeMap: {} };
    }
  }

  getSpaceState(spaceName: string): SpaceState {
    const existing = this.state.spaces[spaceName];
    if (existing) return existing;
    const fresh: SpaceState = { processed: [] };
    this.state.spaces[spaceName] = fresh;
    return fresh;
  }

  markProcessed(spaceName: string, messageName: string): void {
    const st = this.getSpaceState(spaceName);
    st.processed.push(messageName);
    if (st.processed.length > MAX_PROCESSED_PER_SPACE) {
      st.processed.splice(0, st.processed.length - MAX_PROCESSED_PER_SPACE);
    }
  }

  /** Durable /resume override for a conversation (undefined = use derived path). */
  getResumeTarget(sessionKey: string): string | undefined {
    return this.state.resumeMap[sessionKey];
  }

  setResumeTarget(sessionKey: string, file: string): void {
    this.state.resumeMap[sessionKey] = file;
  }

  clearResumeTarget(sessionKey: string): void {
    delete this.state.resumeMap[sessionKey];
  }

  save(): void {
    // Write-then-rename: a crash mid-write can't leave a truncated state.json
    // (whose load() failure would silently reset dedupe + /resume state).
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }
}
