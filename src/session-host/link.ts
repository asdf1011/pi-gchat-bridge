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
 * **What crosses is what a running adapter calls**, and this file is the record of that rule working
 * in both directions. The settings group — `state`, `models`, `setModel`, `bind`, `label`, `compact`,
 * `abort` — was published the day the command surface started calling it, because a `/status` or
 * `/model` typed into a web conversation is an adapter calling the seam. `unbind`, which nothing
 * called, was deleted rather than published. `awaitSubmission` was on the wrong side of the same line
 * for a while: the Chat adapter words its failure notices from a settled turn, so it crosses.
 *
 * Nothing in this module throws "not published over the link yet" any more, and there is no list of
 * operations waiting for a consumer here — `api.ts` is the whole contract, and a method on it that
 * this file does not implement would not compile.
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
  CommentRegion,
  CommentReply,
  CommentView,
  CroppedImage,
  TranscriptMessage,
  AdapterEntry,
  AdapterVerdict,
  ConversationState,
  HostInfo,
  ModelInfo,
  NamedConversation,
  ProviderFailure,
  ProviderQuota,
  SessionHost,
  Settled,
  SubmissionState,
  SubmitRequest,
  SubmitResult,
  ViewHandle,
} from "./api.js";
import type { ArtifactFile } from "../durable/artifacts.js";
import type { ProjectedView } from "./projection.js";
import { ConversationContract, SessionContract, ViewSchema } from "./link-contract.js";

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
    has: async ({ conversation }) => seam.exists(conversation),
    models: () => seam.models() as Promise<ModelInfo[]>,
    setModel: ({ name, provider, modelId, thinkingLevel }) =>
      seam.setModel(name, {
        provider,
        modelId,
        ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
      }),
    bind: async ({ name, conversation }) => (await seam.bind(name, conversation)) ?? null,
    label: ({ name, label }) => seam.label(name, label),
    quota: () => seam.quota() as Promise<ProviderQuota[]>,
    modelFailures: () => seam.modelFailures() as Promise<ProviderFailure[]>,
    secrets: () => seam.secrets() as Promise<{ name: string; addedBy?: string }[]>,
    setSecret: ({ name, value, addedBy }: { name: string; value: string; addedBy: string }) =>
      seam.setSecret(name, value, addedBy),
    removeSecret: ({ name }: { name: string }) => seam.removeSecret(name),
    info: () => seam.info(),
    awaitSubmission: ({ submissionId }: { submissionId: number }) => seam.awaitSubmission(submissionId),
    submission: ({ submissionId }: { submissionId: number }) => seam.submission(submissionId),
    recordVerdict: async ({ name, verdict }: { name: string; verdict: AdapterVerdict }) => {
      await seam.recordVerdict(name, verdict);
      return null;
    },
    verdict: async ({ name }: { name: string }) => (await seam.verdict(name)) ?? null,
  }));

  // The factory is synchronous by contract; the wiring it needs is asynchronous,
  // so it lives in a task — which is also the right lifetime (see below).
  host.serve(ConversationContract, ({ conversation }, _principal, self) => {
    const view = self.state("view", ViewSchema, {
      liveText: "",
      turnText: "",
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
      // `state` is the word for the replicated view above, so the seam's `state` travels as
      // `settings`: one word for two things inside one object is how a reader loses an afternoon.
      settings: async () => (await seam.state(conversation)) ?? null,
      busy: () => seam.busy(conversation),
      compact: async ({ instructions }: { instructions?: string }) => {
        await seam.compact(conversation, instructions);
        return null;
      },
      abort: () => seam.abort(conversation),
      write: ({ kind, data, model }: { kind: string; data: unknown; model?: readonly unknown[] }) =>
        seam.write(conversation, {
          kind,
          data,
          ...(model === undefined ? {} : { model }),
        }),
      firstTurn: async () => (await seam.firstTurn(conversation)) ?? null,
      // The wire shape is deliberately loose (TypeBox cannot express a
      // discriminated union of content parts cheaply), so the cast back to the
      // seam's `MessageContent` is where the two meet.
      submit: ({
        requestId,
        content,
        whenBusy,
        origin,
      }: {
        requestId?: string;
        content: unknown;
        whenBusy?: string;
        origin?: string;
      }): Promise<SubmitResult> =>
        seam.submit(conversation, {
          ...(requestId === undefined ? {} : { requestId }),
          content: content as SubmitRequest["content"],
          ...(whenBusy === undefined ? {} : { whenBusy: whenBusy as SubmitRequest["whenBusy"] }),
          ...(origin === undefined ? {} : { origin }),
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
        region?: CommentRegion;
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
            ...(input.region === undefined ? {} : { region: input.region }),
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
      cropArtifactRegion: async ({ file, region }: { file: string; region: CommentRegion }) =>
        (await seam.cropArtifactRegion(conversation, file, region)) ?? null,
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
    info: async () => {
      const root = await session();
      return (await host.root((ctx) => root.info({}, ctx))) as HostInfo;
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
      return host.root((ctx) => ref.getOrCreate({ name, agent: wireAgent(agent) }, ctx));
    },

    exists: async (conversationId: number) => {
      const root = await session();
      // The session-level `has` rather than a conversation reference: the whole point is not to open
      // one for a conversation that may not exist.
      return Boolean(await host.root((ctx) => root.has({ conversation: conversationId }, ctx)));
    },

    snapshot: (conversationId: number) =>
      withRef(host, session, conversationId, undefined, async (ref) => ref.view.value as ProjectedView),


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

    artifacts: (conversationId: number) =>
      withRef(host, session, conversationId, undefined, async (ref) =>
        (await host.root((ctx) => ref.artifacts({}, ctx))) as readonly ArtifactFile[],
      ),

    submit: (conversationId: number, request: SubmitRequest): Promise<SubmitResult> =>
      withRef(host, session, conversationId, { error: `no such conversation: ${conversationId}` }, async (ref) => {
        const result = await host.root((ctx) =>
          ref.submit(
            {
              ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
              content: request.content as never,
              ...(request.whenBusy === undefined ? {} : { whenBusy: request.whenBusy }),
              // The surface that asked. Without it the host cannot stamp the prompt, and a painter
              // on another surface cannot tell its own messages from a browser's — which is exactly
              // what silently stopped the "quoted prompt" above an answer: every submission arrived
              // unstamped, so an answer no longer knew what it was replying to.
              ...(request.origin === undefined ? {} : { origin: request.origin }),
            },
            ctx,
          ),
        );
        return ("submissionId" in result && result.submissionId !== undefined
          ? { submissionId: result.submissionId }
          : { error: result.error ?? "submit failed" }) as SubmitResult;
      }),

    history: (conversationId: number, options?: { limit?: number; offset?: number }) =>
      withRef(host, session, conversationId, undefined, async (ref) =>
        (await host.root((ctx) =>
          ref.history({ limit: options?.limit ?? 20, offset: options?.offset ?? 0 }, ctx),
        )) as readonly TranscriptMessage[],
      ),

    image: (conversationId: number, entryId: number, index: number) =>
      withRef(host, session, conversationId, undefined, async (ref) =>
        (await host.root((ctx) => ref.image({ entryId, index }, ctx))) ?? undefined,
      ),

    comments: (conversationId: number) =>
      withRef(host, session, conversationId, undefined, async (ref) =>
        (await host.root((ctx) => ref.comments({}, ctx))) as readonly CommentView[],
      ),

    addComment: (conversationId: number, input: CommentInput) =>
      withRef(host, session, conversationId, { error: `no such conversation: ${conversationId}` }, async (ref) => {
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
      }),

    cropArtifactRegion: (conversationId: number, file: string, region: CommentRegion) =>
      withRef(host, session, conversationId, undefined, async (ref) =>
        (await host.root((ctx) => ref.cropArtifactRegion({ file, region }, ctx))) ?? undefined,
      ),

    resolveComment: (conversationId: number, commentId: string, resolved: boolean) =>
      withRef(host, session, conversationId, false, async (ref) =>
        Boolean(await host.root((ctx) => ref.resolveComment({ commentId, resolved }, ctx))),
      ),

    noteCommentSubmission: (conversationId: number, commentId: string, submissionId: number) =>
      withRef(host, session, conversationId, undefined, async (ref) => {
        await host.root((ctx) => ref.noteCommentSubmission({ commentId, submissionId }, ctx));
      }),


    commentThread: (conversationId: number, commentId: string) =>
      withRef(host, session, conversationId, undefined, async (ref) =>
        (await host.root((ctx) => ref.commentThread({ commentId }, ctx))) as readonly CommentReply[],
      ),
    busy: (conversationId: number) =>
      withRef(host, session, conversationId, false, async (ref) =>
        Boolean(await host.root((ctx) => ref.busy({}, ctx))),
      ),
    state: (conversationId: number) =>
      withRef(host, session, conversationId, undefined, async (ref) =>
        ((await host.root((ctx) => ref.settings({}, ctx))) as ConversationState | null) ?? undefined,
      ),
    models: async () => {
      const root = await session();
      return (await host.root((ctx) => root.models({}, ctx))) as readonly ModelInfo[];
    },
    setModel: async (name: string, change: { provider: string; modelId: string; thinkingLevel?: string }) => {
      const root = await session();
      return host.root((ctx) =>
        root.setModel(
          {
            name,
            provider: change.provider,
            modelId: change.modelId,
            ...(change.thinkingLevel === undefined ? {} : { thinkingLevel: change.thinkingLevel }),
          },
          ctx,
        ),
      );
    },
    create: async (name: string, agent: AgentConfig) => {
      const root = await session();
      return host.root((ctx) => root.create({ name, agent: wireAgent(agent) }, ctx));
    },
    bind: async (name: string, conversationId: number) => {
      const root = await session();
      const bound = await host.root((ctx) => root.bind({ name, conversation: conversationId }, ctx));
      return bound ?? undefined;
    },
    quota: async () => {
      const root = await session();
      return (await host.root((ctx) => root.quota({}, ctx))) as readonly ProviderQuota[];
    },
    modelFailures: async () => {
      const root = await session();
      return (await host.root((ctx) => root.modelFailures({}, ctx))) as readonly ProviderFailure[];
    },
    secrets: async () => {
      const root = await session();
      return (await host.root((ctx) => root.secrets({}, ctx))) as readonly { name: string; addedBy?: string }[];
    },
    setSecret: async (name: string, value: string, addedBy: string) => {
      const root = await session();
      const result = (await host.root((ctx) => root.setSecret({ name, value, addedBy }, ctx))) as {
        ok?: boolean;
        error?: string;
      };
      return result.ok === true ? { ok: true as const } : { error: result.error ?? "the host declined" };
    },
    removeSecret: async (name: string) => {
      const root = await session();
      return Boolean(await host.root((ctx) => root.removeSecret({ name }, ctx)));
    },
    label: async (name: string, text: string) => {
      const root = await session();
      return Boolean(await host.root((ctx) => root.label({ name, label: text }, ctx)));
    },
    compact: (conversationId: number, instructions?: string) =>
      withRef(host, session, conversationId, undefined, async (ref) => {
        await host.root((ctx) => ref.compact(instructions === undefined ? {} : { instructions }, ctx));
      }),
    // A conversation that is gone is not running anything, which is what `false` already means.
    abort: (conversationId: number) =>
      withRef(host, session, conversationId, false, async (ref) =>
        Boolean(await host.root((ctx) => ref.abort({}, ctx))),
      ),

    awaitSubmission: async (submissionId: number) => {
      const root = await session();
      return (await host.root((ctx) => root.awaitSubmission({ submissionId }, ctx))) as Settled;
    },
    submission: async (submissionId: number) => {
      const root = await session();
      return (await host.root((ctx) => root.submission({ submissionId }, ctx))) as SubmissionState;
    },
    write: async (conversationId: number, entry: AdapterEntry) => {
      // The one operation that throws for a missing conversation rather than reporting it: a notice
      // that could not be written is not a value any caller switches on, and `write` is called from
      // places that would have to invent an answer.
      const written = await withRef(host, session, conversationId, undefined, async (ref) =>
        (await host.root((ctx) =>
          ref.write(
            {
              kind: entry.kind,
              data: entry.data,
              ...(entry.model === undefined ? {} : { model: entry.model }),
            },
            ctx,
          ),
        )) as number,
      );
      if (written === undefined) throw new Error(`no such conversation: ${conversationId}`);
      return written;
    },
    recordVerdict: async (name: string, verdict: AdapterVerdict) => {
      const root = await session();
      await host.root((ctx) => root.recordVerdict({ name, verdict }, ctx));
    },
    verdict: async (name: string) => {
      const root = await session();
      return ((await host.root((ctx) => root.verdict({ name }, ctx))) as AdapterVerdict | null) ?? undefined;
    },
    firstTurn: (conversationId: number) =>
      withRef(host, session, conversationId, undefined, async (ref) =>
        ((await host.root((ctx) => ref.firstTurn({}, ctx))) as {
          userText: string;
          assistantText: string;
        } | null) ?? undefined,
      ),
  };
}

/**
 * Open one conversation reference, run one call, and release it whatever happens.
 *
 * Every operation needs the same three steps — open, call, release — and the release is the one that
 * matters. A reference that is not released keeps a chord object alive, and with it the host-side
 * task holding that conversation's `state("view")` subscription: a leak with no symptom until the
 * process is carrying hundreds of watches over a day of traffic.
 *
 * Written out by hand, "forgot the `finally`" was one copied block away, twenty-five times. `attach`
 * is the single exception and says so in place, because its reference has to outlive the call.
 */
async function withRef<T>(
  host: Host,
  session: () => Promise<Record<string, any>>,
  conversationId: number,
  absent: T,
  run: (ref: ConversationRef) => Promise<T>,
): Promise<T> {
  const ref = await conversationRef(host, conversationId, session);
  if (!ref) return absent;
  try {
    return await run(ref);
  } finally {
    ref.release();
  }
}

/** A chord reference to one conversation object, as this module uses it. */
type ConversationRef = {
  readonly view: { readonly value: unknown; subscribe(fn: (value: unknown) => void): () => void };
  release(): void;
} & Record<string, any>;

/** A conversation reference, or `undefined` when the host has no such conversation. */
async function conversationRef(
  host: Host,
  conversationId: number,
  session: () => Promise<Record<string, any>>,
): Promise<ConversationRef | undefined> {
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

/**
 * The seam's `AgentConfig` as the wire shape wants it.
 *
 * The only difference is `readonly` versus mutable arrays, which TypeBox's `Static` produces as
 * mutable. Normalising here rather than loosening the seam keeps "an adapter cannot mutate what it
 * passed" true on the side that owns the value.
 */
function wireAgent(agent: AgentConfig): {
  model: { provider: string; modelId: string };
  thinkingLevel?: string;
  cwd?: string;
  tools?: string[];
} {
  return {
    model: agent.model,
    ...(agent.thinkingLevel === undefined ? {} : { thinkingLevel: agent.thinkingLevel }),
    ...(agent.cwd === undefined ? {} : { cwd: agent.cwd }),
    ...(agent.tools === undefined ? {} : { tools: [...agent.tools] }),
  };
}

/** Resolve once, then reuse: the session object is a singleton per client host. */
function once<T>(factory: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined;
  return () => {
    value ??= factory();
    return value;
  };
}
