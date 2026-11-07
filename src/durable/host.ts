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
  LiveDoc,
  type AgentChange,
  type AgentState,
  type Conversation,
  type ConversationId,
  type ModelRef,
  type Settings,
  type TaskId,
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
import { mergeObserved, type ObservedFile } from "./observed-files.js";
import { mergeRevisions, type ArtifactRevision } from "./artifact-revisions.js";
import { originForSubmission, OriginsDoc, withOrigin, type EntryOrigin } from "./origins-doc.js";
import {
  addComment as addCommentTo,
  appendReply,
  appendSubmission,
  CommentsDoc,
  commentsOf,
  findByShortId,
  setResolved,
  type StoredComment,
  type StoredReply,
} from "./comments-doc.js";
import { defineDoc } from "@earendil-works/pi-durable";
import { ChatFormat } from "./extensions/chat-format.js";
import { artifactGuidance } from "./extensions/artifact-guidance.js";
import { createCodingToolsWithDelivery } from "./extensions/coding-tools.js";
import { createCommentTools } from "./extensions/comment-tools.js";
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
  /**
   * Root of the per-conversation artifact repositories, or empty to leave the
   * prompt alone. Only used to tell the model where to write; the commits happen
   * in the session host.
   */
  artifactsDir?: string;
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
    /** Set once the instance exists (see the comment-tools install below). */
    let self: { host?: BridgeHost } = {};
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
    // Where to put files worth reviewing. Skipped entirely when artifacts are not
    // tracked, so the model is never told about a directory nothing commits.
    if (options.artifactsDir) registry.install(artifactGuidance(options.artifactsDir));
    // Only when there is something to reply to. The tool writes to the comments
    // document, never to the transcript: a review reply is plumbing.
    //
    // The registry is built before the instance exists, so the tool reaches it
    // through a reference that is set the moment the host is constructed. A tool
    // call can only happen inside a conversation, which cannot exist before that.
    if (options.artifactsDir) {
      const target: { host?: BridgeHost } = {};
      self = target;
      registry.install(
        createCommentTools({
          reply: (conversationId, commentId, text) =>
            target.host
              ? target.host.addCommentReply(conversationId, commentId, text)
              : Promise.resolve({ error: "the session host is not ready" }),
        }),
      );
    }
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

    const host = new BridgeHost(harness, modelRuntime, options.dbPath, options.cwd, context, lock);
    // Hand the tools a way back in, now that there is something to hand them.
    self.host = host;
    return host;
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
   * Remember the opening words of a conversation, if it has none yet.
   *
   * Written once, from the first message with text in it. Cheap (one commit) and
   * it is what the list shows until a title exists.
   */
  async setPreview(conversationId: number, text: string): Promise<void> {
    const preview = firstWords(text, PREVIEW_WORDS);
    if (!preview) return;
    const existing = await this.harness.snapshot(BindingsDoc, this.context);
    const key = Object.entries(existing?.byChatKey ?? {}).find(
      ([, binding]) => binding.conversationId === conversationId,
    )?.[0];
    if (!key) return;
    if (existing?.byChatKey[key]?.preview) return;
    await this.harness.commit(async (tx) => {
      const doc = await tx.doc(BindingsDoc);
      const current = doc.byChatKey[key];
      if (!current || current.preview) return;
      doc.byChatKey[key] = { ...current, preview };
    }, this.context);
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

  /**
   * Remember files the filesystem showed changing during a turn.
   *
   * Kept on the binding, which is the only per-conversation index this store
   * has. Silently does nothing for a conversation with no binding — a validation
   * thread has no drawer to show them in.
   */
  async recordObservedFiles(conversationId: number, files: readonly ObservedFile[]): Promise<void> {
    if (files.length === 0) return;
    const existing = await this.harness.snapshot(BindingsDoc, this.context);
    const key = Object.entries(existing?.byChatKey ?? {}).find(
      ([, binding]) => binding.conversationId === conversationId,
    )?.[0];
    if (!key) return;
    await this.harness.commit(async (tx) => {
      const doc = await tx.doc(BindingsDoc);
      const current = doc.byChatKey[key];
      if (!current) return;
      doc.byChatKey[key] = { ...current, files: mergeObserved(current.files, files) };
    }, this.context);
  }

  /**
   * Remember which revision of each artifact a turn produced.
   *
   * Best-effort like the rest of the artifact bookkeeping: a conversation with no
   * binding (a validation thread) has no drawer to show them in, and a failed pin
   * costs a "view as it was" link, not an answer.
   */
  async recordRevisions(conversationId: number, revisions: readonly ArtifactRevision[]): Promise<void> {
    if (revisions.length === 0) return;
    const existing = await this.harness.snapshot(BindingsDoc, this.context);
    const key = Object.entries(existing?.byChatKey ?? {}).find(
      ([, binding]) => binding.conversationId === conversationId,
    )?.[0];
    if (!key) return;
    await this.harness.commit(async (tx) => {
      const doc = await tx.doc(BindingsDoc);
      const current = doc.byChatKey[key];
      if (!current) return;
      doc.byChatKey[key] = { ...current, revisions: mergeRevisions(current.revisions, revisions) };
    }, this.context);
  }

  /** Revisions this conversation pinned for its artifacts, newest first. */
  async revisions(conversationId: number): Promise<readonly ArtifactRevision[]> {
    const all = await this.bindings();
    const binding = Object.values(all.byChatKey).find(
      (candidate) => candidate.conversationId === conversationId,
    );
    return binding?.revisions ?? [];
  }

  /** Every comment recorded against a conversation, oldest first. */
  async comments(conversationId: number): Promise<readonly StoredComment[]> {
    const value = await this.harness.snapshot(CommentsDoc, this.context);
    return commentsOf(value ?? undefined, conversationId);
  }

  /** Record one comment. Returns false only when the write itself failed. */
  async addComment(conversationId: number, comment: StoredComment): Promise<boolean> {
    await this.harness.commit(async (tx) => {
      const doc = await tx.doc(CommentsDoc);
      const key = String(conversationId);
      const current = doc.byConversation[key]?.comments ?? [];
      doc.byConversation[key] = { comments: addCommentTo(current, comment) };
    }, this.context);
    return true;
  }

  /** Resolve, or reopen, one comment. True when it changed something. */
  async setCommentResolved(conversationId: number, id: string, resolved: boolean): Promise<boolean> {
    let changed = false;
    await this.harness.commit(async (tx) => {
      const doc = await tx.doc(CommentsDoc);
      const key = String(conversationId);
      const current = doc.byConversation[key]?.comments ?? [];
      const next = setResolved(current, id, resolved);
      if (!next.changed) return;
      changed = true;
      doc.byConversation[key] = { comments: next.comments };
    }, this.context);
    return changed;
  }

  /**
   * Append an agent's reply to a comment's thread.
   *
   * Returns the id it wrote to, or a reason it could not — a model calling a tool
   * gets a result either way, and "no comment with that id" is a better answer
   * than silently doing nothing.
   */
  async addCommentReply(
    conversationId: number,
    shortId: string,
    text: string,
    author = "agent",
  ): Promise<{ id: string } | { error: string }> {
    const trimmed = text.trim();
    if (trimmed === "") return { error: "a reply needs text" };
    const existing = await this.comments(conversationId);
    const found = findByShortId(existing, shortId);
    if (found === undefined) return { error: `no comment with id ${shortId}` };
    if ("ambiguous" in found) return { error: `more than one comment starts with ${shortId}` };

    const reply: StoredReply = { text: trimmed, at: Date.now(), author };
    await this.harness.commit(async (tx) => {
      const doc = await tx.doc(CommentsDoc);
      const key = String(conversationId);
      const current = doc.byConversation[key]?.comments ?? [];
      const next = appendReply(current, found.id, reply);
      if (!next.changed) return;
      doc.byConversation[key] = { comments: next.comments };
    }, this.context);
    return { id: found.id };
  }

  /** Note a submission a comment started, so its answer can be joined later. */
  async appendCommentSubmission(conversationId: number, id: string, submissionId: number): Promise<void> {
    await this.harness.commit(async (tx) => {
      const doc = await tx.doc(CommentsDoc);
      const key = String(conversationId);
      const current = doc.byConversation[key]?.comments ?? [];
      doc.byConversation[key] = { comments: appendSubmission(current, id, submissionId) };
    }, this.context);
  }

  /** Files the filesystem saw change in this conversation, newest first. */
  async observedFiles(conversationId: number): Promise<readonly ObservedFile[]> {
    const all = await this.bindings();
    const binding = Object.values(all.byChatKey).find(
      (candidate) => candidate.conversationId === conversationId,
    );
    return binding?.files ?? [];
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
    const conversationId = settled.conversationId as unknown as number;
    // The answer inherits the prompt's surface. Best-effort: an unstamped answer is
    // an unknown origin, which readers already handle, and this must never delay a
    // turn's completion.
    await this.recordAnswerOrigin(conversationId, answerId, submissionId).catch(() => {});
    const text = await this.answerText(conversationId, answerId);
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

  /**
   * Tool tasks of a conversation's current tool round that are still running.
   *
   * Read from `pi.live`, which is the round's presentation: a slot with a `taskId`
   * and a status other than `done` is a call the round is still waiting for, and
   * `finishToolRound` waits for all of them. Nested calls are not listed — they
   * belong to their parent, so ending the parent ends them.
   *
   * A `snapshot` rather than a view mount: this is one committed read on a timer's
   * path, and a mount that was opened and forgotten is the leak the session host's
   * notes warn about.
   */
  async runningToolTasks(conversationId: number): Promise<number[]> {
    const live = await this.harness.snapshot(
      LiveDoc,
      conversationId as ConversationId,
      this.context,
    );
    return (live?.tools ?? []).flatMap((slot) =>
      slot.taskId !== undefined && slot.status !== "done"
        ? [slot.taskId as unknown as number]
        : [],
    );
  }

  /**
   * Abort one tool task, leaving the conversation's queued input alone.
   *
   * `abort()` above stops the whole conversation, and a stop withdraws queued
   * inputs and settles them `unanswered`. A caller that only wants a stuck tool to
   * end — a steer waiting behind it, say — must not take the message down with it.
   * The tool settles as `aborted`, which the model reads as an ordinary result, and
   * the round's boundary then places what was queued.
   */
  async abortTask(taskId: number): Promise<"marked" | "terminal"> {
    return this.harness.abortTask(taskId as unknown as TaskId, this.context);
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

  /**
   * Stamp which surface produced a submission's user entry.
   *
   * Called after `submit` returns, and it finds the entry rather than being told:
   * the submission that was just made is the newest user entry with no stamp yet.
   * That keeps the knowledge of *how a submission becomes an entry* in one place
   * (this one) instead of in every adapter, and it self-heals — a stamp missed on a
   * restart is picked up by the next submission in that conversation rather than
   * leaving a permanent hole.
   *
   * Best-effort by design: a conversation whose entry cannot be found is logged and
   * left unstamped, because an unknown origin is handled conservatively by every
   * reader and a lost stamp must never fail a turn.
   */
  async recordOrigin(conversationId: number, submission: number, origin: string): Promise<boolean> {
    const ids = await this.userEntryIds(conversationId);
    if (ids.length === 0) {
      logger.warn(`[origins] conversation ${conversationId}: no user entry to stamp (submission ${submission})`);
      return false;
    }
    const current = (await this.harness.snapshot(OriginsDoc, this.context)) ?? { byEntry: {} };
    const entryId = [...ids].reverse().find((id) => current.byEntry[`${conversationId}:${id}`] === undefined);
    if (entryId === undefined) {
      logger.warn(`[origins] conversation ${conversationId}: every user entry is stamped (submission ${submission})`);
      return false;
    }
    const stamp: EntryOrigin = { origin, submission, at: Date.now() };
    await this.harness.commit(async (tx) => {
      // The draft is mutated in place, like every other document write here; the
      // pure `withOrigin` is what decides the new map (and the pruning), so the
      // rule is testable without a store.
      const doc = await tx.doc(OriginsDoc);
      doc.byEntry = withOrigin(doc, conversationId, entryId, stamp).byEntry;
    }, this.context);
    return true;
  }

  /**
   * Stamp the answer of a settled submission with the surface that asked for it.
   *
   * The answer belongs to whoever started the turn, which is not the same question
   * as "which surface is reading" — a browser turn's answer is still the browser's,
   * even when Chat is the thing that displays it.
   */
  async recordAnswerOrigin(conversationId: number, answerId: number, submission: number): Promise<boolean> {
    const current = await this.harness.snapshot(OriginsDoc, this.context);
    const prompt = originForSubmission(current, submission);
    await this.harness.commit(async (tx) => {
      const doc = await tx.doc(OriginsDoc);
      // Stamped *unconditionally*, because the stamp is doing two jobs: it says which
      // surface asked, and it says that this entry **is an answer**. A turn's
      // intermediate messages carry text as well (an agent says "checking now" before
      // calling a tool), and they are transcript entries all the same — so "is this an
      // answer" has to be recorded rather than inferred, or a painter would post a
      // turn's running commentary into the thread. When the prompt's surface was never
      // recorded the origin is the literal `unknown`: still an answer, of unknown
      // provenance, and a reader can say both.
      doc.byEntry = withOrigin(doc, conversationId, answerId, {
        origin: prompt?.origin ?? "unknown",
        ...(prompt?.submission === undefined ? { submission } : { submission: prompt.submission }),
        at: Date.now(),
      }).byEntry;
    }, this.context);
    return true;
  }

  /** Entry ids of the user messages in a conversation, oldest first. */
  private async userEntryIds(conversationId: number): Promise<number[]> {
    const conversation = await this.harness.conversation(conversationId as ConversationId, this.context);
    if (!conversation) return [];
    const view = await conversation.viewState(this.context);
    try {
      const entries = (view.value as { entries?: readonly unknown[] }).entries ?? [];
      const ids: number[] = [];
      for (const raw of entries) {
        const id = (raw as { id?: unknown }).id;
        if (typeof id !== "number") continue;
        const model = (raw as { model?: readonly { role?: string }[] }).model ?? [];
        if (model.some((message) => message.role === "user")) ids.push(id);
      }
      return ids;
    } finally {
      view.dispose();
    }
  }

  /**
   * A window of the transcript, newest last. See `SessionHost.history`.
   *
   * `offset` counts back from the newest message, so "the page before this one"
   * is `offset: limit`. Sliced with explicit indices rather than `slice(-offset)`
   * because the message list is built first: computing the window against the
   * length is what lets a short final page signal the beginning.
   */
  async history(conversationId: number, limit = 20, offset = 0): Promise<TranscriptMessage[] | undefined> {
    const conversation = await this.harness.conversation(
      conversationId as ConversationId,
      this.context,
    );
    if (!conversation) return undefined;
    const view = await conversation.viewState(this.context);
    const entries = (view.value as { entries?: readonly unknown[] }).entries ?? [];
    view.dispose();

    const origins = (await this.harness.snapshot(OriginsDoc, this.context))?.byEntry;
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
        // The surface that produced the entry, when it was stamped at submit time.
        // Absent for anything older than the stamp, which readers must treat as
        // unknown rather than as "mine".
        const stamped =
          typeof entryId === "number" ? origins?.[`${conversationId}:${entryId}`]?.origin : undefined;
        messages.push({
          role: message.role,
          text: text.slice(0, TRANSCRIPT_MESSAGE_CHARS),
          ...(typeof at === "number" && Number.isFinite(at) ? { at } : {}),
          ...(typeof entryId === "number" ? { entryId } : {}),
          ...(stamped === undefined ? {} : { origin: stamped }),
          ...(images.length === 0 ? {} : { images }),
        });
      }
    }
    // The window, counted back from the end. `end` is exclusive.
    const end = Math.max(0, messages.length - Math.max(0, offset));
    const start = Math.max(0, end - limit);
    return messages.slice(start, end);
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
// `gchat.posted-answers` is gone: the painter is the only poster, so "has this answer
// been posted" is answered by the bridge's own cursor rather than by a durable claim.
// Existing documents are left in place and simply never read again — deleting them
// would be a migration, and a document nobody reads costs nothing.

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

/** How many words of the first message stand in for a missing title. */
const PREVIEW_WORDS = 15;

/** The first `count` words of some text, on one line. */
export function firstWords(text: string, count = PREVIEW_WORDS): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter((word) => word !== "");
  if (words.length === 0) return "";
  const head = words.slice(0, count).join(" ");
  return words.length > count ? `${head}…` : head;
}

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
