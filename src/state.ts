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
  /** /model confirm cards still waiting for a conversation-topic title. */
  topicCards?: Record<string, TopicCard>;
}

/**
 * The gchat-only card that started a conversation, so it can be re-titled once
 * we know what the conversation is about. Deliberately NOT stored in the
 * session file: this is display polish for the Chat thread list, not part of
 * the conversation pi sees.
 */
export interface TopicCard {
  /** Chat resource name of the message to patch (`spaces/…/messages/…`). */
  messageName: string;
  /** Model label to keep in the card's body, e.g. "LFM3-VL-2B Q8 (local CPU, free)". */
  modelLabel: string;
}

const MAX_TOPIC_CARDS = 200;

const MAX_PROCESSED_PER_SPACE = 1000;

export class StateStore {
  private state: StateFile;

  constructor(private file: string) {
    this.state = this.load();
  }

  private load(): StateFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as StateFile;
      return {
        spaces: parsed.spaces ?? {},
        resumeMap: parsed.resumeMap ?? {},
        topicCards: parsed.topicCards ?? {},
      };
    } catch {
      return { spaces: {}, resumeMap: {}, topicCards: {} };
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

  /**
   * Remember a card that should be re-titled once the conversation has a topic.
   * Survives a bridge restart (the title job may run several minutes later on
   * slow local hardware, or not at all if the bridge exits first).
   */
  setTopicCard(sessionKey: string, card: TopicCard): void {
    const cards = (this.state.topicCards ??= {});
    cards[sessionKey] = card;
    const keys = Object.keys(cards);
    if (keys.length > MAX_TOPIC_CARDS) {
      for (const key of keys.slice(0, keys.length - MAX_TOPIC_CARDS)) delete cards[key];
    }
    this.save();
  }

  /**
   * Claim a pending card for `sessionKey` (removing it, so a second turn can't
   * re-title it). Removing BEFORE the summarize attempt is intentional: on
   * failure the card simply keeps today's wording instead of being retried
   * forever on every later turn.
   */
  takeTopicCard(sessionKey: string): TopicCard | undefined {
    const card = this.state.topicCards?.[sessionKey];
    if (!card) return undefined;
    delete this.state.topicCards![sessionKey];
    this.save();
    return card;
  }

  save(): void {
    // Write-then-rename: a crash mid-write can't leave a truncated state.json
    // (whose load() failure would silently reset dedupe + /resume state).
    // Trade-offs (both negligible at this call rate): if renameSync itself
    // fails the .tmp file is left behind, and each save does two syscalls
    // instead of one.
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }
}
