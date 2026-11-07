/**
 * `SessionHost` over a chord link: the session host in one process, adapters in
 * others.
 *
 * Two halves, both thin:
 *
 *   - `serveSessionHost(seam)` publishes an *existing* in-process `SessionHost` as
 *     chord objects. Nothing about the host changes; the objects are an adapter
 *     over it.
 *   - `linkSessionHost(clientHost)` is the same interface, implemented by calls
 *     and state subscriptions on the other side of the link.
 *
 * The two spikes behind this (`docs/session-host-api.md`, S5) settled the design:
 * a conversation's *view* is replicated state — snapshot then deltas, one
 * reference per viewer, disposed when the last one releases — and actions are
 * ordinary method calls. That is why `attach` needs no callback plumbing: chord
 * has been doing it all along.
 *
 * Deliberately not published yet: everything the two live adapters never call.
 * `state`, `models`, `setModel`, `create`, `bind`, `unbind`, `label`, `compact`,
 * `abort`, `usage`, `awaitSubmission`, `write`, the claim/verdict operations,
 * `firstTurn` and the comment operations throw `notImplemented` over the link, and
 * each becomes a contract method the day an adapter in another process needs it.
 * The comment operations are the next candidates: an artifact origin in its own
 * process would read them, and `BRIDGE_WEB_ENGINE=link` would need them to create
 * one. Until then comments work in the default `inprocess` engine only, which is
 * what `main.ts` runs.
 *
 * Two constraints that cost real debugging and are easy to walk into again:
 *
 *   1. **The two libraries' contexts are not interchangeable.** pi-durable wants
 *      a context carrying its telemetry adapter; chord wants one carrying a span.
 *      Every pi-durable call here uses `BACKGROUND_CONTEXT`; every chord state
 *      write uses the call's own `ctx`.
 *   2. **The IPC channel belongs to `ipcLink`.** Anything else written to
 *      `process.send` is parsed as link frames.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createHost, type Host } from "@earendil-works/chord";

import type {
  AgentConfig,
  CommentInput,
  CommentReply,
  CommentView,
  TranscriptMessage,
  AdapterEntry,
  AdapterVerdict,
  ConversationState,
  HostInfo,
  ModelInfo,
  NamedConversation,
  SessionHost,
  Settled,
  SubmitRequest,
  SubmitResult,
  ViewHandle,
} from "./api.js";
import type { ArtifactFile } from "../durable/artifacts.js";
import type { ProjectedView } from "./projection.js";
import { ConversationContract, SessionContract, ViewSchema } from "./link-contract.js";

/** Thrown by the operations this first cut does not publish. */
function notImplemented(operation: string): Error {
  return new Error(`${operation} is not published over the link yet (see docs/session-host-api.md, S5)`);
}

/** The chord host name every contract in `link-contract.ts` points at. */
export const SESSION_HOST_NAME = "session-host";

/**
 * Publish an in-process `SessionHost` as chord objects.
 *
 * The returned host is a plain chord host: accept links on it however the
 * deployment prefers (memory pair in tests, `ipcLink` for a child process,
 * `webSocketLink` for a browser-ish client).
 */
export function serveSessionHost(seam: SessionHost): Host {
  const host = createHost({ self: SESSION_HOST_NAME, name: SESSION_HOST_NAME });

  host.serve(SessionContract, (_input, _principal, self) => ({
    variant: "default" as const,
    list: ({ limit, offset }: { limit?: number; offset?: number }) =>
      seam.list({
        ...(limit === undefined ? {} : { limit }),
        ...(offset === undefined ? {} : { offset }),
      }),
    create: ({ name, agent }: { name: string; agent: AgentConfig }) => seam.create(name, agent),
    resolve: async ({ name }) => (await seam.resolve(name)) ?? null,
    getOrCreate: async ({ name, agent }) => seam.getOrCreate(name, agent),
    has: async ({ conversation }) => (await seam.snapshot(conversation)) !== undefined,
  }));

  // The factory is synchronous by contract; the wiring it needs is asynchronous,
  // so it lives in a task — which is also the right lifetime (see below).
  host.serve(ConversationContract, ({ conversation }, _principal, self) => {
    const view = self.state("view", ViewSchema, {
      liveText: "",
      busy: false,
      lastAssistantText: "",
      tools: [],
    });

    // The conversation's view is the object's state: a task owns the pi-durable
    // subscription and its abort signal is the last viewer letting go.
    //
    // ONE subscription per conversation, opened lazily and kept for the object's
    // lifetime. The first version opened a new one on every attach and closed it
    // when the viewer went away — which left the session host holding hundreds of
    // chord watches over a day of traffic, and new attaches queued behind them.
    // A subscription that nobody is watching costs almost nothing; a stampede of
    // them costs the event loop.
    self.task(async (ctx) => {
      const handle = await seam.attach(conversation, (frame) => {
        try {
          view.change(ctx, () => frame);
        } catch {
          // The object was released; nothing left to publish to.
        }
      });
      if (handle) view.change(ctx, () => handle.snapshot);
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) resolve();
        else ctx.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      handle?.detach();
    });

    return {
      variant: "default" as const,
      view,
      // The wire shape is deliberately loose (TypeBox cannot express a
      // discriminated union of content parts cheaply), so the cast back to the
      // seam's `MessageContent` is where the two meet.
      submit: ({
        requestId,
        content,
        whenBusy,
      }: {
        requestId?: string;
        content: unknown;
        whenBusy?: string;
      }): Promise<SubmitResult> =>
        seam.submit(conversation, {
          ...(requestId === undefined ? {} : { requestId }),
          content: content as SubmitRequest["content"],
          ...(whenBusy === undefined ? {} : { whenBusy: whenBusy as SubmitRequest["whenBusy"] }),
        }),
      artifacts: async () => [...((await seam.artifacts(conversation)) ?? [])],
      history: async ({ limit, offset }: { limit: number; offset: number }) => [
        ...((await seam.history(conversation, { limit, offset })) ?? []),
      ],
      image: async ({ entryId, index }: { entryId: number; index: number }) =>
        (await seam.image(conversation, entryId, index)) ?? null,
      comments: async () => [...((await seam.comments(conversation)) ?? [])],
      addComment: async (input: {
        file: string;
        line?: number;
        endLine?: number;
        charStart?: number;
        charEnd?: number;
        quote?: string;
        occurrence?: number;
        text: string;
        author?: string;
      }) => {
        const result = await seam.addComment(conversation, {
          file: input.file,
          selection: {
            ...(input.line === undefined ? {} : { line: input.line }),
            ...(input.quote === undefined ? {} : { quote: input.quote }),
            ...(input.occurrence === undefined ? {} : { occurrence: input.occurrence }),
            ...(input.endLine === undefined ? {} : { endLine: input.endLine }),
            ...(input.charStart === undefined ? {} : { charStart: input.charStart }),
            ...(input.charEnd === undefined ? {} : { charEnd: input.charEnd }),
          },
          text: input.text,
          ...(input.author === undefined ? {} : { author: input.author }),
        });
        // The wire shape is two optional fields; the seam's is a union. This is
        // where they meet, and a "neither" answer is turned into a refusal rather
        // than a lie about which one it was.
        if ("error" in result) return { error: result.error };
        return { comment: result.comment };
      },
      resolveComment: async ({ commentId, resolved }: { commentId: string; resolved: boolean }) =>
        seam.resolveComment(conversation, commentId, resolved),
      noteCommentSubmission: async ({
        commentId,
        submissionId,
      }: {
        commentId: string;
        submissionId: number;
      }) => {
        await seam.noteCommentSubmission(conversation, commentId, submissionId);
        return null;
      },
      commentThread: async ({ commentId }: { commentId: string }) => [
        ...((await seam.commentThread(conversation, commentId)) ?? []),
      ],
      replyToComment: async ({ commentId, text }: { commentId: string; text: string }) => {
        const result = await seam.replyToComment(conversation, commentId, text);
        return "error" in result ? { error: result.error } : { id: result.id };
      },
    };
  });

  return host;
}

export interface LinkSessionHostOptions {
  /** A chord host on the *client* side, already connected upstream. */
  host: Host;
}

/** The seam, from the far side of a link. */
export function linkSessionHost(options: LinkSessionHostOptions): SessionHost {
  const { host } = options;

  const session = once(async () => host.get(SessionContract, {}));

  return {
    info(): HostInfo {
      // Not published: an adapter in another process has no business knowing the
      // storage path, and the two live adapters never ask.
      throw notImplemented("info");
    },

    list: async (options?: { limit?: number; offset?: number }) => {
      const ref = await session();
      return host.root((ctx) =>
        ref.list(
          {
            ...(options?.limit === undefined ? {} : { limit: options.limit }),
            ...(options?.offset === undefined ? {} : { offset: options.offset }),
          },
          ctx,
        ),
      );
    },

    resolve: async (name: string) => {
      const ref = await session();
      const found = await host.root((ctx) => ref.resolve({ name }, ctx));
      return found ?? undefined;
    },

    getOrCreate: async (name: string, agent: AgentConfig) => {
      const ref = await session();
      return host.root((ctx) => ref.getOrCreate({ name, agent }, ctx));
    },

    snapshot: async (conversationId: number) => {
      const ref = await conversationRef(host, conversationId, session);
      if (!ref) return undefined;
      try {
        return ref.view.value as ProjectedView;
      } finally {
        ref.release();
      }
    },


    attach: async (conversationId: number, onFrame: (view: ProjectedView) => void): Promise<ViewHandle | undefined> => {
      const ref = await conversationRef(host, conversationId, session);
      if (!ref) return undefined;
      const snapshot = ref.view.value as ProjectedView;
      // The seam's contract: the current state arrives as the first frame, so a
      // caller never paints a stale snapshot over a newer one.
      onFrame(snapshot);
      const stop = ref.view.subscribe((value) => onFrame(value as ProjectedView));
      let detached = false;
      return {
        snapshot,
        detach() {
          if (detached) return;
          detached = true;
          stop();
          ref.release();
        },
      };
    },

    artifacts: async (conversationId: number) => {
      const ref = await conversationRef(host, conversationId, session);
      if (!ref) return undefined;
      try {
        return (await host.root((ctx) => ref.artifacts({}, ctx))) as readonly ArtifactFile[];
      } finally {
        ref.release();
      }
    },

    submit: async (conversationId: number, request: SubmitRequest): Promise<SubmitResult> => {
      const ref = await conversationRef(host, conversationId, session);
      if (!ref) return { error: `no such conversation: ${conversationId}` };
      try {
        const result = await host.root((ctx) =>
          ref.submit(
            {
              ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
              content: request.content as never,
              ...(request.whenBusy === undefined ? {} : { whenBusy: request.whenBusy }),
            },
            ctx,
          ),
        );
        return ("submissionId" in result && result.submissionId !== undefined
          ? { submissionId: result.submissionId }
          : { error: result.error ?? "submit failed" }) as SubmitResult;
      } finally {
        ref.release();
      }
    },

    history: async (conversationId: number, options?: { limit?: number; offset?: number }) => {
      const ref = await conversationRef(host, conversationId, session);
      if (!ref) return undefined;
      try {
        return (await host.root((ctx) =>
          ref.history({ limit: options?.limit ?? 20, offset: options?.offset ?? 0 }, ctx),
        )) as readonly TranscriptMessage[];
      } finally {
        ref.release();
      }
    },

    image: async (conversationId: number, entryId: number, index: number) => {
      const ref = await conversationRef(host, conversationId, session);
      if (!ref) return undefined;
      try {
        const found = await host.root((ctx) => ref.image({ entryId, index }, ctx));
        return found ?? undefined;
      } finally {
        ref.release();
      }
    },

    comments: async (conversationId: number) => {
      const ref = await conversationRef(host, conversationId, session);
      if (!ref) return undefined;
      try {
        return (await host.root((ctx) => ref.comments({}, ctx))) as readonly CommentView[];
      } finally {
        ref.release();
      }
    },

    addComment: async (conversationId: number, input: CommentInput) => {
      const ref = await conversationRef(host, conversationId, session);
      if (!ref) return { error: `no such conversation: ${conversationId}` };
      try {
        const result = (await host.root((ctx) =>
          ref.addComment(
            {
              file: input.file,
              ...(input.selection.line === undefined ? {} : { line: input.selection.line }),
              ...(input.selection.quote === undefined ? {} : { quote: input.selection.quote }),
              ...(input.selection.occurrence === undefined ? {} : { occurrence: input.selection.occurrence }),
              ...(input.selection.endLine === undefined ? {} : { endLine: input.selection.endLine }),
              ...(input.selection.charStart === undefined ? {} : { charStart: input.selection.charStart }),
              ...(input.selection.charEnd === undefined ? {} : { charEnd: input.selection.charEnd }),
              text: input.text,
              ...(input.author === undefined ? {} : { author: input.author }),
            },
            ctx,
          ),
        )) as { comment?: CommentView; error?: string };
        if (result.comment === undefined) {
          return { error: result.error ?? "the host declined the comment" };
        }
        return { comment: result.comment };
      } finally {
        ref.release();
      }
    },

    resolveComment: async (conversationId: number, commentId: string, resolved: boolean) => {
      const ref = await conversationRef(host, conversationId, session);
      if (!ref) return false;
      try {
        return Boolean(await host.root((ctx) => ref.resolveComment({ commentId, resolved }, ctx)));
      } finally {
        ref.release();
      }
    },

    noteCommentSubmission: async (conversationId: number, commentId: string, submissionId: number) => {
      const ref = await conversationRef(host, conversationId, session);
      if (!ref) return;
      try {
        await host.root((ctx) => ref.noteCommentSubmission({ commentId, submissionId }, ctx));
      } finally {
        ref.release();
      }
    },

    replyToComment: async (conversationId: number, commentId: string, text: string) => {
      const ref = await conversationRef(host, conversationId, session);
      if (!ref) return { error: `no such conversation: ${conversationId}` };
      try {
        const result = (await host.root((ctx) => ref.replyToComment({ commentId, text }, ctx))) as {
          id?: string;
          error?: string;
        };
        return result.id === undefined
          ? { error: result.error ?? "the host declined the reply" }
          : { id: result.id };
      } finally {
        ref.release();
      }
    },

    commentThread: async (conversationId: number, commentId: string) => {
      const ref = await conversationRef(host, conversationId, session);
      if (!ref) return undefined;
      try {
        return (await host.root((ctx) => ref.commentThread({ commentId }, ctx))) as readonly CommentReply[];
      } finally {
        ref.release();
      }
    },
    state: () => {
      throw notImplemented("state");
    },
    models: () => {
      throw notImplemented("models");
    },
    setModel: () => {
      throw notImplemented("setModel");
    },
    create: async (name: string, agent: AgentConfig) => {
      const root = await session();
      return host.root((ctx) => root.create({ name, agent }, ctx));
    },
    bind: () => {
      throw notImplemented("bind");
    },
    unbind: () => {
      throw notImplemented("unbind");
    },
    label: () => {
      throw notImplemented("label");
    },
    compact: () => {
      throw notImplemented("compact");
    },
    abort: () => {
      throw notImplemented("abort");
    },
    usage: () => {
      throw notImplemented("usage");
    },
    awaitSubmission: (): Promise<Settled> => {
      throw notImplemented("awaitSubmission");
    },
    write: (_id: number, _entry: AdapterEntry): Promise<number> => {
      throw notImplemented("write");
    },
    claimAnswer: () => {
      throw notImplemented("claimAnswer");
    },
    releaseAnswer: () => {
      throw notImplemented("releaseAnswer");
    },
    lastPostedAnswer: () => {
      throw notImplemented("lastPostedAnswer");
    },
    recordVerdict: (_name: string, _verdict: AdapterVerdict) => {
      throw notImplemented("recordVerdict");
    },
    verdict: () => {
      throw notImplemented("verdict");
    },
    firstTurn: () => {
      throw notImplemented("firstTurn");
    },
  };
}

/** A conversation reference, or `undefined` when the host has no such conversation. */
async function conversationRef(host: Host, conversationId: number, session: () => Promise<any>) {
  try {
    const root = await session();
    // One extra round trip per open, not per frame: a chord object would
    // otherwise spring into existence for a conversation that does not exist.
    const exists = await host.root((ctx) => root.has({ conversation: conversationId }, ctx));
    if (!exists) return undefined;
    const ref = await host.get(ConversationContract, { conversation: conversationId });
    return ref as { view: { value: unknown; subscribe(fn: (value: unknown) => void): () => void }; release(): void } & Record<string, any>;
  } catch {
    return undefined;
  }
}

/** Resolve once, then reuse: the session object is a singleton per client host. */
function once<T>(factory: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined;
  return () => {
    value ??= factory();
    return value;
  };
}
