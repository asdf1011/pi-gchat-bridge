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
  configure,
  createRegistry,
  Harness,
  type AgentChange,
  type Conversation,
  type ConversationId,
  type ModelRef,
  type Settings,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { logger } from "../logger.js";
import { BindingsDoc, type BindingsValue, type ConversationBinding } from "./bindings-doc.js";
import { harnessSettings } from "./settings.js";

export interface BridgeHostOptions {
  /** SQLite file. One process owns it (pi-durable has no cross-process locking). */
  dbPath: string;
  /** Working directory for tools; the conversation's `cwd` starts here. */
  cwd: string;
  /** Reuse an existing runtime (tests) or let the host create one from ~/.pi/agent. */
  modelRuntime?: ModelRuntime;
  settings?: Settings;
  context?: Context;
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
    private readonly cwd: string,
    /** Chord context for host calls (cancellation + telemetry). Exposed for adapters and tools. */
    readonly context: Context,
  ) {}

  static async open(options: BridgeHostOptions): Promise<BridgeHost> {
    const context = options.context ?? BACKGROUND_CONTEXT;
    const modelRuntime = options.modelRuntime ?? (await ModelRuntime.create());

    const registry = createRegistry();
    // The coding toolset the old bridge gave its sessions. Extension ports
    // (chat-format, tool policy) land on top of this in a later step.
    registry.install(CodingTools);

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
    );

    // Continue whatever a previous process left unfinished. Safe on a fresh
    // store, and the only thing that resumes a run interrupted by a restart.
    harness.resume();

    return new BridgeHost(harness, modelRuntime, options.cwd, context);
  }

  /** Current bindings, for `/sessions` and `/resume`. */
  async bindings(): Promise<BindingsValue> {
    return (await this.harness.snapshot(BindingsDoc, this.context)) ?? { byChatKey: {} };
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

  async close(): Promise<void> {
    await this.harness.close(this.context);
  }

  /** Where the SQLite file lives, resolved, for logs. */
  describeStorage(dbPath: string): string {
    return path.resolve(dbPath);
  }
}
