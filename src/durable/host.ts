/**
 * The bridge's harness: one open pi-durable storage, and the conversations the
 * Chat threads talk to.
 *
 * This is the piece that replaces `AgentRouter` from the SDK host. What used to
 * be hand-rolled here and is now the harness's job:
 *
 *   - creating a pi session per Chat thread, and re-opening it after a restart
 *     → `conversationFor()` + the bindings document
 *   - deduplicating redelivered Chat messages (`state.json`)
 *     → `submit({ requestId })`
 *   - steer queues, in-flight tool tracking, the stall watchdog, idle eviction
 *     → `whenBusy: "steer"`, task checkpoints, `resume()`
 *
 * What stays the bridge's job, deliberately: which Chat thread maps to which
 * conversation, and what a conversation's agent should be when it is created.
 */
import path from "node:path";
import {
  AssistantEntry,
  configure,
  createRegistry,
  Harness,
  type AgentChange,
  type AgentState,
  type Conversation,
  type ConversationId,
  type ModelRef,
  type Settings,
} from "@earendil-works/pi-durable";

import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { logger } from "../logger.js";
import type {
  AdapterEntry,
  ConversationState,
  ModelInfo,
  Settled,
  TranscriptMessage,
  UsageTotals,
} from "../session-host/api.js";
import { BindingsDoc, type BindingsValue, type ConversationBinding } from "./bindings-doc.js";
import { defineDoc } from "@earendil-works/pi-durable";
import { ChatFormat } from "./extensions/chat-format.js";
import { createCodingToolsWithDelivery } from "./extensions/coding-tools.js";
import { createSecretRedactor, secretsFromEnvironment } from "./extensions/secret-redactor.js";
import type { RegisteredSecret } from "./extensions/redact.js";
import type { SecretStore } from "../secret-store.js";
import { harnessSettings } from "./settings.js";
import { acquireBridgeLock, type BridgeLock } from "./lock.js";

export interface BridgeHostOptions {
  /** SQLite file. One process owns it (pi-durable has no cross-process locking). */
  dbPath: string;
  /** Working directory for tools; the conversation's `cwd` starts here. */
  cwd: string;
  /** Reuse an existing runtime (tests) or let the host create one from ~/.pi/agent. */
  modelRuntime?: ModelRuntime;
  settings?: Settings;
  context?: Context;
  /**
   * Secrets entered through `/secret`. Read once at startup to seed the
   * redaction registry; absent means "environment only".
   */
  secrets?: SecretStore;
}

/** A created conversation plus the binding that records it. */
export interface BoundConversation {
  conversation: Conversation;
  binding: ConversationBinding;
}

/**
 * "provider/modelId" → ModelRef. Splits on the FIRST slash only: model ids
 * legitimately contain slashes (`anthropic/claude-…`, `@cf/meta/…`).
 */
export function parseModelRef(value: string): ModelRef {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    throw new Error(`model must be "provider/modelId", got "${value}"`);
  }
  return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

export class BridgeHost {
  private readonly pending = new Map<string, Promise<BoundConversation>>();

  private constructor(
    readonly harness: Harness,
    readonly modelRuntime: ModelRuntime,
    /** SQLite file this harness owns. Exposed so commands can report it. */
    readonly dbPath: string,
    private readonly cwd: string,
    /** Chord context for host calls (cancellation + telemetry). Exposed for adapters and tools. */
    readonly context: Context,
    /** Pid file proving this process is the only one on `dbPath`. */
    private readonly lock: BridgeLock,
  ) {}

  static async open(options: BridgeHostOptions): Promise<BridgeHost> {
    const context = options.context ?? BACKGROUND_CONTEXT;
    const modelRuntime = options.modelRuntime ?? (await ModelRuntime.create());

    // Before the harness, and before the Pub/Sub subscription: a second bridge
    // on the same database would answer the same Chat messages from a fresh
    // in-memory harness, which `requestId` dedupe cannot see across processes.
    // Throws BridgeLockedError if another live process owns the file.
    const lock = acquireBridgeLock(options.dbPath);

    const registry = createRegistry();
    // The coding toolset the old bridge gave its sessions, plus the bridge's own
    // output rules. Tool policy is not ported: per-conversation tools are
    // `configure({ tools })` here, which is what the old extension enforced.
    // The tool set is rebuilt rather than installed from `CodingTools`, so `bash`
    // can carry the secret-delivery `prepare` hook. It is otherwise identical.
    registry.install(
      createCodingToolsWithDelivery({
        // Resolved per command, so a secret captured a moment ago is usable now.
        // Scoping is applied inside, against the call's own conversation id.
        secrets: () => options.secrets?.registrySecrets() ?? [],
      }),
    );
    registry.install(ChatFormat);
    // Installed last, deliberately: hooks compose, and redaction should see the
    // final tool output and the final request.
    //
    // Values come from two places. The store holds what `/secret` captured; the
    // environment holds what an operator exported (and what a child pi process
    // inherited via PI_SECRETS_NAMES). The store wins on a name collision: it is
    // the entry point a human used deliberately, and it is the one the card
    // showed a confirmation for.
    //
    // Resolved per call rather than once, because `/secret set` must take effect
    // in a running bridge. A snapshot taken at startup meant a captured secret
    // was stored but neither redacted nor usable until a restart — which reads
    // as "the card did nothing". The cost is one small JSON read per request and
    // per command.
    const resolveSecrets = (): RegisteredSecret[] => {
      const stored = options.secrets?.registrySecrets() ?? [];
      const storedNames = new Set(stored.map((secret) => secret.name));
      // Environment values are additive and lower priority: a stored name wins.
      return [...stored, ...secretsFromEnvironment().filter((secret) => !storedNames.has(secret.name))];
    };
    registry.install(createSecretRedactor({ secrets: resolveSecrets }));

    const harness = await Harness.open(
      await openNodeSqliteStorage(options.dbPath),
      {
        models: modelRuntime,
        registry,
        settings: options.settings ?? harnessSettings(),
        // A fresh environment per call, built from the conversation's cwd at
        // each use — so a conversation that changes cwd sees the change.
        env: ({ cwd }: { cwd?: string }) =>
          new NodeExecutionEnv({ cwd: cwd ?? options.cwd }),
        onReport: (error: unknown, info: { type?: string; task?: { kind?: string } }) => {
          // Storage errors end the harness by design; everything else is a
          // faulted task, hook, tool or host callback. Neither is fatal to the
          // process, so both are logged rather than thrown.
          logger.error(
            `[harness] ${info?.type ?? "report"}${info?.task?.kind ? ` (${info.task.kind})` : ""}:`,
            error instanceof Error ? error.message : String(error),
          );
        },
      },
      context,
    ).catch((error: unknown) => {
      // Opening failed, so this process will never serve: release the lock or a
      // crash-restart loop would keep colliding with a lock nobody holds.
      lock.release();
      throw error;
    });

    // Continue whatever a previous process left unfinished. Safe on a fresh
    // store, and the only thing that resumes a run interrupted by a restart.
    harness.resume();

    return new BridgeHost(harness, modelRuntime, options.dbPath, options.cwd, context, lock);
  }

  /** Current bindings, for `/sessions` and `/resume`. */
  async bindings(): Promise<BindingsValue> {
    return (await this.harness.snapshot(BindingsDoc, this.context)) ?? { byChatKey: {} };
  }

  /**
   * Conversations ordered by last use, newest first, optionally paged.
   *
   * Sorting is here rather than in an adapter because "recently used" is a fact
   * about the store: the binding carries `updatedAt` (written on every
   * submission) and falls back to `createdAt` for threads that predate it.
   */
  async recentConversations(
    options: { limit?: number; offset?: number } = {},
  ): Promise<(ConversationBinding & { chatKey: string })[]> {
    const all = await this.bindings();
    const entries = Object.entries(all.byChatKey).map(([chatKey, binding]) => ({ ...binding, chatKey }));
    entries.sort(
      (a, b) =>
        (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt) || b.createdAt - a.createdAt,
    );
    const offset = Math.max(0, options.offset ?? 0);
    const limit = options.limit === undefined ? entries.length : Math.max(0, options.limit);
    return entries.slice(offset, offset + limit);
  }

  /**
   * Record that a conversation was used just now.
   *
   * Called on every submission, from either surface. One small commit per
   * message, which is the price of a recent-conversations list that means
   * something; without it the list can only be ordered by when each thread was
   * created, which is not the same thing at all.
   */
  async touch(conversationId: number): Promise<void> {
    const existing = await this.harness.snapshot(BindingsDoc, this.context);
    const key = Object.entries(existing?.byChatKey ?? {}).find(
      ([, binding]) => binding.conversationId === conversationId,
    )?.[0];
    if (!key) return; // a conversation nobody has named (a validation thread)
    await this.harness.commit(async (tx) => {
      const doc = await tx.doc(BindingsDoc);
      const current = doc.byChatKey[key];
      if (!current) return;
      doc.byChatKey[key] = { ...current, updatedAt: Date.now() };
    }, this.context);
  }

  /** The binding for a Chat conversation key, if it has one. */
  async bindingFor(chatKey: string): Promise<ConversationBinding | undefined> {
    return (await this.bindings()).byChatKey[chatKey];
  }

  /**
   * The conversation a Chat key talks to, created on first use.
   *
   * `agent` is applied only when the conversation is created — later changes go
   * through `conversation.configure()`, which is what `/model` will use. The
   * binding and the conversation are written in one commit, so a crash cannot
   * leave a conversation no thread points at (or a binding pointing nowhere).
   */
  async conversationFor(
    chatKey: string,
    agent: AgentChange & { model: ModelRef },
  ): Promise<BoundConversation> {
    const existing = await this.bindingFor(chatKey);
    if (existing) {
      const conversation = await this.harness.conversation(
        existing.conversationId as ConversationId,
        this.context,
      );
      if (conversation) return { conversation, binding: existing };
      // Binding points at a conversation that is gone (only possible if storage
      // was replaced under us). Fall through and re-create rather than wedging.
      logger.error(`[harness] stale binding for ${chatKey} → ${existing.conversationId}`);
    }

    // Two Chat messages can arrive for the same thread concurrently; recover
    // the same creation rather than racing two conversations into existence.
    const inFlight = this.pending.get(chatKey);
    if (inFlight) return inFlight;

    const created = this.create(chatKey, agent).finally(() => this.pending.delete(chatKey));
    this.pending.set(chatKey, created);
    return created;
  }

  private async create(
    chatKey: string,
    agent: AgentChange & { model: ModelRef },
  ): Promise<BoundConversation> {
    const cwd = agent.cwd ?? this.cwd;
    const binding = await this.harness.commit(async (tx) => {
      const record = await tx.createConversation({ ownership: { kind: "ownerless" } });
      // configure() in the same commit: the conversation has its agent from the
      // moment it exists, so the first request never runs with defaults.
      await configure(tx, record.id, { ...agent, cwd });
      const doc = await tx.doc(BindingsDoc);
      const value: ConversationBinding = {
        conversationId: record.id as number,
        model: `${agent.model.provider}/${agent.model.modelId}`,
        ...(agent.thinkingLevel ? { thinking: String(agent.thinkingLevel) } : {}),
        createdAt: Date.now(),
      };
      doc.byChatKey[chatKey] = value;
      return value;
    }, this.context);

    const conversation = await this.harness.conversation(
      binding.conversationId as ConversationId,
      this.context,
    );
    if (!conversation) throw new Error(`conversation ${binding.conversationId} vanished`);
    logger.info(`[harness] ${chatKey} → conversation ${binding.conversationId} (${binding.model})`);
    return { conversation, binding };
  }

  /** Forget a Chat key's binding (does not delete the transcript). */
  async unbind(chatKey: string): Promise<boolean> {
    return this.harness.commit(async (tx) => {
      const doc = await tx.doc(BindingsDoc);
      if (!doc.byChatKey[chatKey]) return false;
      delete doc.byChatKey[chatKey];
      return true;
    }, this.context);
  }

  // --- Host-side operations the seam exposes --------------------------------
  //
  // These live here, next to the storage, rather than in the seam's in-process
  // adapter: each is a commit or a model-runtime query, and splitting the
  // transaction (agent change here, binding there) is exactly the bug the
  // single-commit ops below exist to prevent.

  /** Models a picker may offer, with the thinking levels each supports. */
  async listModels(): Promise<ModelInfo[]> {
    const available = await this.modelRuntime.getAllAvailable();
    return available
      .filter(
        (model) =>
          model.type === undefined ||
          model.type === "chat" ||
          (model as { output?: string[] }).output?.includes("text"),
      )
      .map((model) => {
        const levels = thinkingLevelsOf(this.modelRuntime, model.provider, model.id);
        return {
          provider: model.provider,
          id: model.id,
          label: model.name ?? model.id,
          ...(levels === undefined ? {} : { thinkingLevels: levels }),
        };
      });
  }

  /** What a status card needs about one conversation. */
  async conversationState(conversationId: number): Promise<ConversationState | undefined> {
    const conversation = await this.harness.conversation(
      conversationId as ConversationId,
      this.context,
    );
    if (!conversation) return undefined;

    const agent = await conversation.agent(this.context);
    const view = await conversation.viewState(this.context);
    const value = view.value as unknown as { entries?: readonly unknown[]; docs?: Record<string, unknown> };
    view.dispose();

    const model = agent.model;
    if (!model) return undefined;
    const usage = totalUsage(value.docs?.["pi.usage"]);
    return {
      conversationId,
      model: `${model.provider}/${model.modelId}`,
      provider: model.provider,
      modelId: model.modelId,
      ...(agent.thinkingLevel ? { thinkingLevel: String(agent.thinkingLevel) } : {}),
      supportedLevels: thinkingLevelsOf(this.modelRuntime, model.provider, model.modelId),
      ...(usage === undefined ? {} : { usage }),
      entries: value.entries?.length ?? 0,
    };
  }

  /**
   * Change a named conversation's model. One commit: agent and binding together.
   */
  async setModel(
    chatKey: string,
    change: { provider: string; modelId: string; thinkingLevel?: string },
  ): Promise<{ model: string; thinkingLevel?: string }> {
    const binding = await this.bindingFor(chatKey);
    if (!binding) throw new Error(`no conversation for ${chatKey}`);
    const model = `${change.provider}/${change.modelId}`;

    await this.harness.commit(async (tx) => {
      await configure(tx, binding.conversationId as ConversationId, {
        model: { provider: change.provider, modelId: change.modelId },
        ...(change.thinkingLevel === undefined
          ? {}
          : { thinkingLevel: change.thinkingLevel as AgentState["thinkingLevel"] }),
      });
      const doc = await tx.doc(BindingsDoc);
      const current = doc.byChatKey[chatKey];
      if (current) {
        doc.byChatKey[chatKey] = {
          ...current,
          model,
          ...(change.thinkingLevel === undefined ? {} : { thinking: change.thinkingLevel }),
        };
      }
    }, this.context);

    return {
      model,
      ...(change.thinkingLevel === undefined ? {} : { thinkingLevel: change.thinkingLevel }),
    };
  }

  /** Start a name on a fresh conversation, leaving the old transcript alone. */
  async createNamed(
    chatKey: string,
    agent: { model: ModelRef; thinkingLevel?: AgentState["thinkingLevel"]; cwd?: string },
  ): Promise<ConversationBinding> {
    const bound = await this.create(chatKey, agent);
    return bound.binding;
  }

  /**
   * Point a name at an existing conversation.
   *
   * The previous label is kept (it described the thread, not the transcript);
   * model and thinking level come from the target's own agent, so a card and
   * `/status` describe what will actually run.
   */
  async bind(chatKey: string, conversationId: number): Promise<ConversationBinding | undefined> {
    const conversation = await this.harness.conversation(
      conversationId as ConversationId,
      this.context,
    );
    if (!conversation) return undefined;
    const agent = await conversation.agent(this.context);
    const target = agent.model;
    if (!target) return undefined;
    const level = agent.thinkingLevel;

    return this.harness.commit(async (tx) => {
      const doc = await tx.doc(BindingsDoc);
      const previous = doc.byChatKey[chatKey];
      const binding: ConversationBinding = {
        conversationId,
        model: `${target.provider}/${target.modelId}`,
        ...(level ? { thinking: String(level) } : {}),
        createdAt: Date.now(),
        ...(previous?.name ? { name: previous.name } : {}),
      };
      doc.byChatKey[chatKey] = binding;
      return binding;
    }, this.context);
  }

  /** Set a conversation's display label. Adapter-facing text only. */
  async setLabel(chatKey: string, name: string): Promise<boolean> {
    return this.harness.commit(async (tx) => {
      const doc = await tx.doc(BindingsDoc);
      const current = doc.byChatKey[chatKey];
      if (!current) return false;
      doc.byChatKey[chatKey] = { ...current, name };
      return true;
    }, this.context);
  }

  /**
   * Wait for a submission, and resolve its answer text.
   *
   * The submission is looked up by id rather than held as a handle, so this works
   * after a restart: the turn resumes and the wait still resolves.
   */
  async awaitSubmission(submissionId: number): Promise<Settled> {
    const submission = await this.harness.submission(submissionId as never, this.context);
    if (!submission) return { status: "unanswered", reason: "unknown submission" };
    const settled = await submission.wait(this.context);
    if (settled.status !== "done" || settled.answer === undefined) {
      return {
        status: "unanswered",
        ...(settled.reason === undefined ? {} : { reason: settled.reason }),
        ...(settled.detail === undefined ? {} : { detail: settled.detail }),
      };
    }
    const answerId = settled.answer as unknown as number;
    const text = await this.answerText(settled.conversationId as unknown as number, answerId);
    return { status: "done", answerId, text };
  }

  /** The text of one assistant entry, concatenated from its content blocks. */
  async answerText(conversationId: number, answerId: number): Promise<string> {
    const conversation = await this.harness.conversation(
      conversationId as ConversationId,
      this.context,
    );
    if (!conversation) return "";
    const entry = await conversation.commit(
      (tx) => tx.entry(AssistantEntry, answerId as never),
      this.context,
    );
    const content = (entry?.model?.[0] as { content?: readonly { type?: string; text?: string }[] } | undefined)
      ?.content;
    return (content ?? [])
      .flatMap((block) => (block.type === "text" && block.text ? [block.text] : []))
      .join("")
      .trim();
  }

  /** Write an adapter-authored entry (a notice) into a conversation. */
  async writeEntry(conversationId: number, entry: AdapterEntry): Promise<number> {
    const conversation = await this.harness.conversation(
      conversationId as ConversationId,
      this.context,
    );
    if (!conversation) throw new Error(`no such conversation: ${conversationId}`);
    const submission = await conversation.submit(
      {
        type: "write",
        entry: {
          kind: entry.kind,
          data: entry.data as never,
          ...(entry.model === undefined ? {} : { model: entry.model as never }),
        },
      } as never,
      this.context,
    );
    return submission.id as unknown as number;
  }

  /** Compact a conversation's context. */
  async compact(conversationId: number, instructions?: string): Promise<void> {
    const conversation = await this.harness.conversation(
      conversationId as ConversationId,
      this.context,
    );
    if (!conversation) throw new Error(`no such conversation: ${conversationId}`);
    await conversation.compact(instructions, this.context);
  }

  /** Stop whatever a conversation is doing. */
  async abort(conversationId: number): Promise<boolean> {
    const conversation = await this.harness.conversation(
      conversationId as ConversationId,
      this.context,
    );
    if (!conversation) return false;
    await conversation.abort(this.context);
    return true;
  }

  /** Store-wide token and cost totals. */
  async usage(): Promise<{ models: Record<string, unknown>; tools: Record<string, unknown> }> {
    return (await this.harness.usage(this.context)) as {
      models: Record<string, unknown>;
      tools: Record<string, unknown>;
    };
  }

  // --- Adapter-owned durable state ------------------------------------------
  //
  // These two documents predate the seam (they were the bridge's own durable
  // state), so the operations below are typed claims over them rather than a
  // generic key/value store. That keeps live claims across the move and keeps
  // the semantics in the name: "claim the last answer" is not "set a key".

  /** Claim the right to post one answer. See `SessionHost.claimAnswer`. */
  async claimAnswer(chatKey: string, answerId: number): Promise<boolean> {
    if (!Number.isFinite(answerId)) return true; // nothing to key on: better twice than never
    return this.harness.commit(async (tx) => {
      const doc = await tx.doc(PostedAnswersDoc);
      const last = doc.byChatKey[chatKey];
      if (last && answerId <= last.answerId) return false;
      doc.byChatKey[chatKey] = { answerId, at: Date.now() };
      return true;
    }, this.context);
  }

  /** Give a claim back, if it is still this answer's. */
  async releaseAnswer(chatKey: string, answerId: number): Promise<void> {
    if (!Number.isFinite(answerId)) return;
    await this.harness.commit(async (tx) => {
      const doc = await tx.doc(PostedAnswersDoc);
      if (doc.byChatKey[chatKey]?.answerId !== answerId) return;
      delete doc.byChatKey[chatKey];
    }, this.context);
  }

  /** The answer last claimed for a name. */
  async lastPostedAnswer(chatKey: string): Promise<{ answerId: number; at: number } | undefined> {
    return (await this.harness.snapshot(PostedAnswersDoc, this.context))?.byChatKey[chatKey];
  }

  /** Record a validation verdict for a name. */
  async recordVerdict(chatKey: string, verdict: VerdictEntry): Promise<void> {
    await this.harness.commit(async (tx) => {
      const doc = await tx.doc(VerdictsDoc);
      doc.byThreadKey[chatKey] = verdict;
    }, this.context);
  }

  /** The last verdict recorded for a name. */
  async verdict(chatKey: string): Promise<VerdictEntry | undefined> {
    return (await this.harness.snapshot(VerdictsDoc, this.context))?.byThreadKey[chatKey];
  }

  /** The last `limit` messages with text, newest last. See `SessionHost.history`. */
  async history(conversationId: number, limit = 20): Promise<TranscriptMessage[] | undefined> {
    const conversation = await this.harness.conversation(
      conversationId as ConversationId,
      this.context,
    );
    if (!conversation) return undefined;
    const view = await conversation.viewState(this.context);
    const entries = (view.value as { entries?: readonly unknown[] }).entries ?? [];
    view.dispose();

    const messages: TranscriptMessage[] = [];
    for (const raw of entries) {
      const model = (raw as { model?: readonly { role?: string; content?: unknown }[] }).model ?? [];
      for (const message of model) {
        if (message.role !== "user" && message.role !== "assistant") continue;
        const text = textOf(message);
        const images = imagesOf(message);
        // A message with only an image is still a message: dropping it would hide
        // the photo someone sent from the transcript.
        if (!text && images.length === 0) continue;
        const at = (message as { timestamp?: unknown }).timestamp;
        const entryId = (raw as { id?: unknown }).id;
        messages.push({
          role: message.role,
          text: text.slice(0, TRANSCRIPT_MESSAGE_CHARS),
          ...(typeof at === "number" && Number.isFinite(at) ? { at } : {}),
          ...(typeof entryId === "number" ? { entryId } : {}),
          ...(images.length === 0 ? {} : { images }),
        });
      }
    }
    return messages.slice(-limit);
  }

  /** One image's bytes from a transcript entry. */
  async image(
    conversationId: number,
    entryId: number,
    index: number,
  ): Promise<{ mimeType: string; data: string } | undefined> {
    const conversation = await this.harness.conversation(
      conversationId as ConversationId,
      this.context,
    );
    if (!conversation) return undefined;
    // The plain entry, not a typed one: an image can be in a notice or a user
    // message as easily as in an answer, and the typed accessor decodes one kind.
    const entry = await conversation
      .commit((tx) => tx.entry(entryId as never), this.context)
      .catch(() => undefined);
    const messages = (entry as { model?: readonly { content?: unknown }[] } | undefined)?.model ?? [];
    for (const message of messages) {
      const images = imageBlocks(message);
      const found = images[index];
      if (found) return found;
    }
    return undefined;
  }

  /** The first user/assistant exchange, for a title. */
  async firstTurn(conversationId: number): Promise<{ userText: string; assistantText: string } | undefined> {
    const conversation = await this.harness.conversation(
      conversationId as ConversationId,
      this.context,
    );
    if (!conversation) return undefined;
    const view = await conversation.viewState(this.context);
    const entries = (view.value as { entries?: readonly unknown[] }).entries ?? [];
    view.dispose();
    return firstTurnOf(entries);
  }

  async close(): Promise<void> {
    await this.harness.close(this.context);
    this.lock.release();
  }

  /** Working directory conversations start in. */
  get cwdPath(): string {
    return this.cwd;
  }

  /** Where the SQLite file lives, resolved, for logs. */
  describeStorage(dbPath: string): string {
    return path.resolve(dbPath);
  }
}

/** The thinking levels a model supports, using pi's own rule. */
function thinkingLevelsOf(
  models: ModelRuntime,
  provider: string,
  modelId: string,
): string[] | undefined {
  const model = models.getModel(provider, modelId);
  if (!model) return undefined;
  // A non-reasoning model is "off" only; getSupportedThinkingLevels already
  // applies the model's thinkingLevelMap, so this matches what the TUI offers.
  return model.reasoning ? getSupportedThinkingLevels(model) : ["off"];
}

/** The counters one `pi.usage.models` bucket may carry (`totalTokens` is the billed sum). */
interface UsageCounters {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: { total?: number };
}

/** Sum `docs["pi.usage"]` into the totals a status card shows. */
export function totalUsage(usageDoc: unknown): UsageTotals | undefined {
  const models = (usageDoc as { models?: Record<string, UsageCounters> } | undefined)?.models;
  if (!models) return undefined;
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
  for (const usage of Object.values(models)) {
    totals.input += usage.input ?? 0;
    totals.output += usage.output ?? 0;
    // Cache tokens are billed (cheaply) and counted in totalTokens, so they are
    // summed too: dropping them made `/status` show a cache column of 0 while
    // the ledger held real cache reads.
    totals.cacheRead += usage.cacheRead ?? 0;
    totals.cacheWrite += usage.cacheWrite ?? 0;
    totals.total += usage.totalTokens ?? 0;
    totals.cost += usage.cost?.total ?? 0;
  }
  return totals.total > 0 ? totals : undefined;
}

/** Chat answers already delivered, keyed by conversation name. */
export type PostedAnswersValue = { byChatKey: Record<string, { answerId: number; at: number }> };

const PostedAnswersDoc = defineDoc<PostedAnswersValue>({
  kind: "gchat.posted-answers",
  version: 1,
  scope: "session",
  initial: () => ({ byChatKey: {} }),
  checkpointWhen: () => true,
});

/** One notification verdict, as `notify.ts` writes it. */
export type VerdictEntry = {
  verdict: "YES" | "NO";
  reason: string;
  notificationPosted?: boolean;
  postFailed?: boolean;
  error?: string;
  at: number;
};

/** Notification verdicts, keyed by conversation name. */
export type VerdictsValue = { byThreadKey: Record<string, VerdictEntry> };

const VerdictsDoc = defineDoc<VerdictsValue>({
  kind: "gchat.verdicts",
  version: 1,
  scope: "session",
  initial: () => ({ byThreadKey: {} }),
  checkpointWhen: () => true,
});

/** How much of one message the pane shows. Long tool output would swamp it. */
const TRANSCRIPT_MESSAGE_CHARS = 4000;

/** The first user message and the assistant reply that followed it. */
function firstTurnOf(entries: readonly unknown[]): { userText: string; assistantText: string } | undefined {
  let userText = "";
  let assistantText = "";
  for (const raw of entries) {
    const messages = (raw as { model?: readonly { role?: string; content?: unknown }[] }).model ?? [];
    for (const message of messages) {
      const text = textOf(message);
      if (!text) continue;
      if (message.role === "user" && !userText) userText = text;
      else if (message.role === "assistant" && userText && !assistantText) {
        assistantText = text;
        return { userText, assistantText };
      }
    }
  }
  return userText ? { userText, assistantText } : undefined;
}

/** Image blocks of one message, as `{mimeType, data}`. */
function imageBlocks(message: { content?: unknown }): { mimeType: string; data: string }[] {
  const content = message.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    const typed = block as { type?: string; data?: string; mimeType?: string };
    return typed.type === "image" && typeof typed.data === "string"
      ? [{ mimeType: typed.mimeType ?? "image/png", data: typed.data }]
      : [];
  });
}

/** What a viewer needs to know about one message's images. */
function imagesOf(message: { content?: unknown }): { mimeType: string }[] {
  return imageBlocks(message).map((image) => ({ mimeType: image.mimeType }));
}

/** Concatenated text blocks of one message. */
function textOf(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => {
      const typed = block as { type?: string; text?: string };
      return typed.type === "text" && typed.text ? [typed.text] : [];
    })
    .join("")
    .trim();
}
