/**
 * `SessionHost` implemented over the live harness, in this process.
 *
 * This is the only file that knows both worlds: it takes the plain shapes from
 * `./api.ts` and translates them into pi-durable calls. Adapters imported this
 * module's *interface*, never this file — which is what makes the second
 * implementation (a link to another process) a transport change rather than an
 * adapter rewrite.
 *
 * Design notes worth keeping:
 *
 *   - Every view call disposes what it opened, in a `finally`. An attachment that
 *     leaks keeps a subscription alive for the life of the process, and a viewer
 *     that is opened and forgotten is the easiest leak to write.
 *   - Frames are whole projections, not deltas, so a slow or dropped consumer is
 *     correct on the next one. That is what lets a browser reconnect and a bridge
 *     restart pass unnoticed.
 *   - `content` parts that name a file are read *here*, at submit time, so a
 *     multi-megabyte image never has to travel across the seam as bytes.
 */
import type { Context } from "@earendil-works/chord";
import type { AgentChange, ConversationId, UserInput } from "@earendil-works/pi-durable";

import { deriveArtifacts, type ArtifactEntryLike, type ArtifactFile } from "../durable/artifacts.js";
import type { BridgeHost } from "../durable/host.js";
import { projectView, type ProjectedView, type ViewLike } from "./projection.js";
import type {
  AdapterEntry,
  AdapterVerdict,
  AgentConfig,
  ConversationState,
  ModelInfo,
  Settled,
  TranscriptMessage,
  MessageContent,
  NamedConversation,
  HostInfo,
  SessionHost,
  SubmitRequest,
  SubmitResult,
  ViewHandle,
} from "./api.js";

export interface InProcessOptions {
  host: BridgeHost;
  /**
   * Post `text` into the Chat thread behind a conversation, when there is one.
   *
   * Injected rather than implemented here: the Chat client is the session host's
   * business, and an adapter must never hold those credentials.
   */
  announce?: (conversationId: number, text: string) => Promise<boolean>;
  /** Directories an artifact path may resolve under. */
  roots: readonly string[];
  /** Chord context for host calls; defaults to the host's. */
  context?: Context;
}

/** `"provider/modelId"` → `{provider, modelId}`, splitting on the FIRST slash. */
function parseModel(model: string): { provider: string; modelId: string } {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    throw new Error(`model must be "provider/modelId", got "${model}"`);
  }
  return { provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
}

/** The seam's content → the harness's content. Both sides are already the same shape. */
function toUserInput(content: MessageContent): UserInput {
  if (typeof content === "string") return content;
  return content.map((part) =>
    part.type === "text"
      ? { type: "text" as const, text: part.text }
      : { type: "image" as const, data: part.data, mimeType: part.mimeType },
  );
}

export function inProcessSessionHost(options: InProcessOptions): SessionHost {
  const { host } = options;

  // The seam takes an `AbortSignal`; the harness takes a chord context. Until
  // the harness accepts a signal, it is accepted at the boundary and unused here,
  // rather than leaking `Context` into every adapter signature (decision D8).
  const conversationOf = (conversationId: number) =>
    host.harness.conversation(conversationId as unknown as ConversationId, host.context);

  const named = (name: string, binding: {
    conversationId: number;
    model: string;
    thinking?: string;
    name?: string;
    createdAt: number;
    updatedAt?: number;
  }): NamedConversation => ({
    conversationId: binding.conversationId,
    name,
    ...(binding.name === undefined ? {} : { label: binding.name }),
    model: binding.model,
    ...(binding.thinking === undefined ? {} : { thinking: binding.thinking }),
    createdAt: binding.createdAt,
    lastActivityAt: binding.updatedAt ?? binding.createdAt,
  });

  return {
    info(): HostInfo {
      return { dbPath: host.dbPath, cwd: host.cwdPath, startedAt: Date.now() };
    },

    async list(options?: { limit?: number; offset?: number }): Promise<NamedConversation[]> {
      // Ordered and paged by the host: "recently used" is a fact about the store,
      // and an adapter cannot see `updatedAt` without reading every binding.
      const rows = await host.recentConversations({
        ...(options?.limit === undefined ? {} : { limit: options.limit }),
        ...(options?.offset === undefined ? {} : { offset: options.offset }),
      });
      return rows.map((binding) => named(binding.chatKey, binding));
    },

    async resolve(name: string): Promise<NamedConversation | undefined> {
      const binding = await host.bindingFor(name);
      return binding === undefined ? undefined : named(name, binding);
    },

    async getOrCreate(name: string, agent: AgentConfig): Promise<NamedConversation> {
      const bound = await host.conversationFor(name, {
        model: agent.model,
        ...(agent.thinkingLevel === undefined
          ? {}
          : { thinkingLevel: agent.thinkingLevel as NonNullable<AgentChange["thinkingLevel"]> }),
        ...(agent.cwd === undefined ? {} : { cwd: agent.cwd }),
      });
      return named(name, bound.binding);
    },

    async history(conversationId: number, options?: { limit?: number }): Promise<readonly TranscriptMessage[] | undefined> {
      return host.history(conversationId, options?.limit);
    },

    async snapshot(conversationId: number): Promise<ProjectedView | undefined> {
      const conversation = await conversationOf(conversationId);
      if (!conversation) return undefined;
      const opened = await conversation.viewState(host.context);
      try {
        return projectView(opened.value as unknown as ViewLike);
      } finally {
        opened.dispose();
      }
    },

    async attach(
      conversationId: number,
      onFrame: (view: ProjectedView) => void,
    ): Promise<ViewHandle | undefined> {
      const conversation = await conversationOf(conversationId);
      if (!conversation) return undefined;
      const opened = await conversation.viewState(host.context);
      let attached = true;
      opened.subscribe((value: unknown) => {
        if (!attached) return;
        onFrame(projectView(value as unknown as ViewLike));
      });
      // The current state as the first frame, emitted after subscribing so it
      // cannot overwrite a newer commit: the subscription is installed before
      // this paint, and every later frame supersedes it.
      const snapshot = projectView(opened.value as unknown as ViewLike);
      onFrame(snapshot);
      return {
        snapshot,
        detach() {
          if (!attached) return;
          attached = false;
          opened.dispose();
        },
      };
    },

    async artifacts(conversationId: number): Promise<readonly ArtifactFile[] | undefined> {
      const conversation = await conversationOf(conversationId);
      if (!conversation) return undefined;
      const opened = await conversation.viewState(host.context);
      try {
        const entries = (opened.value as { entries?: unknown }).entries ?? [];
        return deriveArtifacts(entries as readonly ArtifactEntryLike[], options.roots);
      } finally {
        opened.dispose();
      }
    },

    async state(conversationId: number): Promise<ConversationState | undefined> {
      return host.conversationState(conversationId);
    },

    async models(): Promise<readonly ModelInfo[]> {
      return host.listModels();
    },

    async setModel(
      name: string,
      change: { provider: string; modelId: string; thinkingLevel?: string },
    ): Promise<{ model: string; thinkingLevel?: string }> {
      return host.setModel(name, change);
    },

    async create(name: string, agent: AgentConfig): Promise<NamedConversation> {
      const binding = await host.createNamed(name, {
        model: agent.model,
        ...(agent.thinkingLevel === undefined
          ? {}
          : { thinkingLevel: agent.thinkingLevel as NonNullable<AgentChange["thinkingLevel"]> }),
        ...(agent.cwd === undefined ? {} : { cwd: agent.cwd }),
      });
      return named(name, binding);
    },

    async bind(name: string, conversationId: number): Promise<NamedConversation | undefined> {
      const binding = await host.bind(name, conversationId);
      return binding === undefined ? undefined : named(name, binding);
    },

    async unbind(name: string): Promise<boolean> {
      return host.unbind(name);
    },

    async label(name: string, label: string): Promise<boolean> {
      return host.setLabel(name, label);
    },

    async awaitSubmission(submissionId: number): Promise<Settled> {
      return host.awaitSubmission(submissionId);
    },

    async write(conversationId: number, entry: AdapterEntry): Promise<number> {
      return host.writeEntry(conversationId, entry);
    },

    async claimAnswer(name: string, answerId: number): Promise<boolean> {
      return host.claimAnswer(name, answerId);
    },

    async releaseAnswer(name: string, answerId: number): Promise<void> {
      return host.releaseAnswer(name, answerId);
    },

    async lastPostedAnswer(name: string): Promise<{ answerId: number; at: number } | undefined> {
      return host.lastPostedAnswer(name);
    },

    async recordVerdict(name: string, verdict: AdapterVerdict): Promise<void> {
      return host.recordVerdict(name, verdict);
    },

    async verdict(name: string): Promise<AdapterVerdict | undefined> {
      return host.verdict(name);
    },

    async firstTurn(conversationId: number): Promise<{ userText: string; assistantText: string } | undefined> {
      return host.firstTurn(conversationId);
    },

    async announce(conversationId: number, text: string): Promise<boolean> {
      if (!options.announce) return false;
      return options.announce(conversationId, text);
    },

    async compact(conversationId: number, instructions?: string): Promise<void> {
      return host.compact(conversationId, instructions);
    },

    async abort(conversationId: number): Promise<boolean> {
      return host.abort(conversationId);
    },

    async usage(): Promise<{ models: Record<string, unknown>; tools: Record<string, unknown> }> {
      return host.usage();
    },

    async submit(conversationId: number, request: SubmitRequest): Promise<SubmitResult> {
      const conversation = await conversationOf(conversationId);
      if (!conversation) return { error: `no such conversation: ${conversationId}` };
      if (typeof request.content === "string" && request.content.trim() === "") {
        return { error: "empty message" };
      }
      const submission = await conversation.submit(
        {
          type: "input",
          content: toUserInput(request.content),
          whenBusy: request.whenBusy ?? "steer",
          ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
        },
        host.context,
      );
      // Remember that the conversation was used, for the recent list.
      await host.touch(conversationId).catch(() => {});
      return { submissionId: submission.id as unknown as number };
    },
  };
}

/** Re-exported so an adapter can name the model ref it passes, without the library. */
export type { AgentConfig, NamedConversation, SessionHost } from "./api.js";
export { parseModel };
