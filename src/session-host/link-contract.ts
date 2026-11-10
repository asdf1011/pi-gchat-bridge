/**
 * The wire schemas: what a `SessionHost` looks like as chord contracts.
 *
 * Shapes, not behaviour. Two contracts cover the two adapters that already use
 * the seam — the web front end (`list`, `attach`, `submit`) and the artifact
 * origin (`artifacts`) — because a contract with no consumer is speculation, and
 * this project has already paid for that lesson twice.
 *
 * `ProjectedView` is the interesting one: it is bounded by construction (the
 * live answer, the tool line, a busy flag), which is exactly why it is the thing
 * that crosses the wire and the transcript is not.
 */
import { Type, type Static } from "typebox";
import { hostNamed, method, remote } from "@earendil-works/chord";

export const ViewSchema = Type.Object({
  liveText: Type.String(),
  /** What the turn has already said, before the message now being generated. */
  turnText: Type.String(),
  busy: Type.Boolean(),
  lastAssistantText: Type.String(),
  tools: Type.Array(
    Type.Object({
      callId: Type.String(),
      name: Type.String(),
      status: Type.Union([Type.Literal("pending"), Type.Literal("running"), Type.Literal("done")]),
      output: Type.Optional(Type.String()),
      // Tool arguments are whatever the model passed. JSON-safe in practice (they
      // came from a JSON request), and the only consumer is the status line.
      arguments: Type.Optional(Type.Unknown()),
    }),
  ),
});

export type ViewValue = Static<typeof ViewSchema>;

export const NamedConversationSchema = Type.Object({
  conversationId: Type.Number(),
  name: Type.String(),
  label: Type.Optional(Type.String()),
  model: Type.String(),
  thinking: Type.Optional(Type.String()),
  createdAt: Type.Number(),
  lastActivityAt: Type.Optional(Type.Number()),
});

/** Token and cost totals, summed over every model one conversation has used. */
export const UsageTotalsSchema = Type.Object({
  input: Type.Number(),
  output: Type.Number(),
  cacheRead: Type.Number(),
  cacheWrite: Type.Number(),
  total: Type.Number(),
  cost: Type.Number(),
});

/** What a status view needs about one conversation: counts and names, never entries. */
export const ConversationStateSchema = Type.Object({
  conversationId: Type.Number(),
  model: Type.String(),
  provider: Type.String(),
  modelId: Type.String(),
  thinkingLevel: Type.Optional(Type.String()),
  supportedLevels: Type.Optional(Type.Array(Type.String())),
  usage: Type.Optional(UsageTotalsSchema),
  entries: Type.Number(),
});

/** A model as a picker lists it. */
export const ModelInfoSchema = Type.Object({
  provider: Type.String(),
  id: Type.String(),
  label: Type.String(),
  thinkingLevels: Type.Optional(Type.Array(Type.String())),
});

/** Where the host is running. Diagnostics, and the `/engine` report. */
export const HostInfoSchema = Type.Object({
  dbPath: Type.String(),
  cwd: Type.String(),
  startedAt: Type.Number(),
});

/** An adapter's verdict about a conversation — the notification validator's record. */
export const AdapterVerdictSchema = Type.Object({
  verdict: Type.Union([Type.Literal("YES"), Type.Literal("NO")]),
  reason: Type.String(),
  notificationPosted: Type.Optional(Type.Boolean()),
  postFailed: Type.Optional(Type.Boolean()),
  error: Type.Optional(Type.String()),
  at: Type.Number(),
});

/**
 * How a submission ended, as the seam reports it.
 *
 * A loose object rather than a discriminated union, like the comment result: chord's schema language
 * has no cheap union, and `status` is the discriminator both ends already switch on.
 */
export const SettledSchema = Type.Object({
  status: Type.Union([Type.Literal("done"), Type.Literal("unanswered")]),
  answerId: Type.Optional(Type.Number()),
  text: Type.Optional(Type.String()),
  reason: Type.Optional(Type.String()),
  detail: Type.Optional(Type.Unknown()),
});

/** One provider's quota, as `/quota` shows it. Mirrors `ProviderQuota` at the seam. */
export const ProviderQuotaSchema = Type.Object({
  provider: Type.String(),
  models: Type.Array(Type.String()),
  paid: Type.Boolean(),
  topUpUrl: Type.Optional(Type.String()),
  queried: Type.Boolean(),
  available: Type.Optional(Type.Boolean()),
  balance: Type.Optional(Type.String()),
  note: Type.Optional(Type.String()),
});

/** A recorded provider failure, as `/status` reports it. Mirrors `ProviderFailure` at the seam. */
export const ProviderFailureSchema = Type.Object({
  provider: Type.String(),
  kind: Type.String(),
  action: Type.String(),
  summary: Type.String(),
  persistent: Type.Boolean(),
  at: Type.Number(),
  conversationId: Type.Optional(Type.Number()),
  reason: Type.String(),
});

export const AgentConfigSchema = Type.Object({
  model: Type.Object({ provider: Type.String(), modelId: Type.String() }),
  thinkingLevel: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()),
});

export const ContentPartSchema = Type.Union([
  Type.String(),
  Type.Array(
    Type.Object({
      type: Type.String(),
      text: Type.Optional(Type.String()),
      data: Type.Optional(Type.String()),
      mimeType: Type.Optional(Type.String()),
    }),
  ),
]);

export const SubmitResultSchema = Type.Object({
  submissionId: Type.Optional(Type.Number()),
  error: Type.Optional(Type.String()),
});

export const TranscriptMessageSchema = Type.Object({
  role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
  text: Type.String(),
  at: Type.Optional(Type.Number()),
  entryId: Type.Optional(Type.Number()),
  /**
   * The surface this entry came from, when it was stamped.
   *
   * Carried because the seam's `TranscriptMessage` carries it: a client that reads history to decide
   * what to paint (the painter does exactly that) cannot ask "was this prompt already in my thread?"
   * without it. Absent means unknown, and unknown is handled conservatively.
   */
  origin: Type.Optional(Type.String()),
  images: Type.Optional(Type.Array(Type.Object({ mimeType: Type.String() }))),
});

export const ArtifactSchema = Type.Object({
  key: Type.String(),
  root: Type.String(),
  path: Type.String(),
  wrote: Type.Number(),
  edited: Type.Number(),
  entryId: Type.Optional(Type.Number()),
});

export const CommentAnchorSchema = Type.Object({
  changeId: Type.String(),
  originalLine: Type.Number(),
  content: Type.String(),
});

/**
 * One comment, as it crosses the wire.
 *
 * `positions` travels with it because the host resolved them against the live
 * revision: an adapter drawing a highlight must not re-derive them, since it has
 * no repository to annotate against.
 */
export const CommentViewSchema = Type.Object({
  id: Type.String(),
  file: Type.String(),
  anchors: Type.Array(CommentAnchorSchema),
  quote: Type.Optional(Type.String()),
  charStart: Type.Optional(Type.Number()),
  charEnd: Type.Optional(Type.Number()),
  occurrence: Type.Optional(Type.Number()),
  text: Type.String(),
  at: Type.Number(),
  author: Type.Optional(Type.String()),
  resolved: Type.Optional(Type.Boolean()),
  state: Type.Union([
    Type.Literal("visible"),
    Type.Literal("superseded"),
    Type.Literal("orphaned"),
    Type.Literal("resolved"),
  ]),
  positions: Type.Array(Type.Number()),
  successor: Type.Optional(
    Type.Object({
      revision: Type.String(),
      kind: Type.Union([
        Type.Literal("unchanged"),
        Type.Literal("moved"),
        Type.Literal("replaced"),
        Type.Literal("removed"),
      ]),
      start: Type.Number(),
      end: Type.Number(),
      quote: Type.Optional(Type.String()),
    }),
  ),
  atRevision: Type.Optional(Type.String()),
  submissions: Type.Optional(Type.Array(Type.Number())),
  replies: Type.Optional(
    Type.Array(
      Type.Object({ text: Type.String(), at: Type.Number(), author: Type.Optional(Type.String()) }),
    ),
  ),
});

export const CommentReplySchema = Type.Object({
  kind: Type.Union([Type.Literal("answer"), Type.Literal("note")]),
  text: Type.String(),
  at: Type.Optional(Type.Number()),
  submissionId: Type.Optional(Type.Number()),
  author: Type.Optional(Type.String()),
});

/**
 * The result of adding a comment.
 *
 * A loose object rather than a union of two shapes: chord's schema language has
 * no cheap discriminated union, and "either the stored comment or a reason it
 * was refused" is exactly two optional fields, which both ends already have to
 * check anyway.
 */
export const CommentCreateResultSchema = Type.Object({
  comment: Type.Optional(CommentViewSchema),
  error: Type.Optional(Type.String()),
});

/** One conversation, as a remote object: its view is state, its actions are methods. */
export const ConversationContract = remote("pi-bridge.conversation", {
  version: 1,
  input: Type.Object({ conversation: Type.Number() }),
  host: hostNamed("session-host"),
  variants: {
    default: {
      // State, not a stream: chord replicates a snapshot then deltas, which is
      // exactly what `attach` promises — and what makes a reconnect free.
      state: { view: ViewSchema },
      methods: {
        submit: method(
          Type.Object({
            requestId: Type.Optional(Type.String()),
            content: ContentPartSchema,
            whenBusy: Type.Optional(Type.String()),
            // The surface that submitted: `gchat`, `webui`, `cron`. Recorded so a
            // painter can tell its own messages from another surface's.
            origin: Type.Optional(Type.String()),
          }),
          SubmitResultSchema,
        ),
        /**
         * The conversation's settings and totals, for `/status` and a status card.
         *
         * Named `settings` rather than `state` because `state` is already the word for chord's
         * replicated view in this same contract, and two meanings of one word in one object is how a
         * reader loses an afternoon. Null rather than absent: chord has no `undefined`.
         */
        settings: method(Type.Object({}), Type.Union([ConversationStateSchema, Type.Null()])),
        artifacts: method(Type.Object({}), Type.Array(ArtifactSchema)),
        history: method(
          Type.Object({ limit: Type.Number(), offset: Type.Number() }),
          Type.Array(TranscriptMessageSchema),
        ),
        image: method(
          Type.Object({ entryId: Type.Number(), index: Type.Number() }),
          Type.Union([Type.Object({ mimeType: Type.String(), data: Type.String() }), Type.Null()]),
        ),
        // Review comments. The anchors are derived host-side from the artifact
        // repository's own annotation, so what crosses is a *selection* on the
        // way in and resolved *positions* on the way out.
        comments: method(Type.Object({}), Type.Array(CommentViewSchema)),
        addComment: method(
          Type.Object({
            file: Type.String(),
            // Optional: a *rendered* document reports the selected text and the
            // host derives the line from it, so this is absent when commenting on
            // Markdown rather than on a numbered source view.
            line: Type.Optional(Type.Number()),
            endLine: Type.Optional(Type.Number()),
            charStart: Type.Optional(Type.Number()),
            charEnd: Type.Optional(Type.Number()),
            quote: Type.Optional(Type.String()),
            occurrence: Type.Optional(Type.Number()),
            text: Type.String(),
            author: Type.Optional(Type.String()),
          }),
          CommentCreateResultSchema,
        ),
        resolveComment: method(
          Type.Object({ commentId: Type.String(), resolved: Type.Boolean() }),
          Type.Boolean(),
        ),
        noteCommentSubmission: method(
          Type.Object({ commentId: Type.String(), submissionId: Type.Number() }),
          Type.Null(),
        ),
        commentThread: method(
          Type.Object({ commentId: Type.String() }),
          Type.Array(CommentReplySchema),
        ),
        /**
         * The agent replying into a thread. Not a submission: the reply is for the
         * review pane, so it never reaches Chat and never re-enters the model's
         * context.
         */
        replyToComment: method(
          Type.Object({ commentId: Type.String(), text: Type.String() }),
          Type.Object({ id: Type.Optional(Type.String()), error: Type.Optional(Type.String()) }),
        ),
        /**
         * Write an adapter-authored entry into the conversation: a notice, not a model turn.
         *
         * `data` is the adapter's own shape. The host stores it and hands it back to readers; it is
         * deliberately untyped here, because the seam's job is to carry it, not to interpret it.
         */
        write: method(
          Type.Object({
            kind: Type.String(),
            data: Type.Unknown(),
            model: Type.Optional(Type.Array(Type.Unknown())),
          }),
          Type.Number(),
        ),
        /** The first user/assistant exchange, for a title. Extracted host-side, as it always is. */
        firstTurn: method(
          Type.Object({}),
          Type.Union([Type.Object({ userText: Type.String(), assistantText: Type.String() }), Type.Null()]),
        ),
        /** Summarise the history now. Instructions are free text. */
        compact: method(Type.Object({ instructions: Type.Optional(Type.String()) }), Type.Null()),
        /** Stop whatever is running. True when something was stopped. */
        abort: method(Type.Object({}), Type.Boolean()),
      },
    },
  },
});

/** The session-level object: naming and listing. */
export const SessionContract = remote("pi-bridge.session", {
  version: 1,
  input: Type.Object({}),
  host: hostNamed("session-host"),
  variants: {
    default: {
      methods: {
        list: method(
          Type.Object({ limit: Type.Optional(Type.Number()), offset: Type.Optional(Type.Number()) }),
          Type.Array(NamedConversationSchema),
        ),
        /** Start a conversation nobody has named yet — the web index's "new chat". */
        create: method(
          Type.Object({ name: Type.String(), agent: AgentConfigSchema }),
          NamedConversationSchema,
        ),
        resolve: method(
          Type.Object({ name: Type.String() }),
          Type.Union([NamedConversationSchema, Type.Null()]),
        ),
        getOrCreate: method(
          Type.Object({ name: Type.String(), agent: AgentConfigSchema }),
          NamedConversationSchema,
        ),
        /**
         * Whether a conversation id exists.
         *
         * Needed because a chord object is created on demand: serving one for a
         * conversation the host does not have would make "gone" indistinguishable
         * from "empty", and the seam promises `undefined` for the former.
         */
        has: method(Type.Object({ conversation: Type.Number() }), Type.Boolean()),
        /**
         * The models a picker may offer, with their thinking levels.
         *
         * Session-level rather than per conversation because the list is a property of the
         * deployment, not of a thread — and one request serves every card and every command.
         */
        models: method(Type.Object({}), Type.Array(ModelInfoSchema)),
        /**
         * Change the model (and thinking level) a *named* conversation runs with.
         *
         * Keyed by name, like `create` and `bind`, because a model change has to update the
         * binding record and the conversation's agent in one commit — the binding is the adapter's
         * name → conversation mapping, and a card that changed only the conversation would disagree
         * with the next lookup by name.
         */
        setModel: method(
          Type.Object({
            name: Type.String(),
            provider: Type.String(),
            modelId: Type.String(),
            thinkingLevel: Type.Optional(Type.String()),
          }),
          Type.Object({ model: Type.String(), thinkingLevel: Type.Optional(Type.String()) }),
        ),
        /** Point a name at an existing conversation, keeping the previous label. */
        bind: method(
          Type.Object({ name: Type.String(), conversation: Type.Number() }),
          Type.Union([NamedConversationSchema, Type.Null()]),
        ),
        /** Set a conversation's display label. Adapter-facing text only. */
        label: method(Type.Object({ name: Type.String(), label: Type.String() }), Type.Boolean()),
        /**
         * Provider quotas.
         *
         * Session-level, because the answer is about the deployment's providers rather than about a
         * conversation — and because the check reads `models.json` and calls the providers, so it
         * can only run where the host is.
         */
        /**
         * Write a failure notice as the answer to a submission.
         *
         * Session-level because it names the submission it answers, and that is what decides
         * which surface the notice returns to. Distinct from a conversation's `write`, which is
         * commentary the painter never posts; this one must appear as a reply or the turn looks
         * hung — and it must reach the person who is waiting, not a log.
         */
        writeNotice: method(
          Type.Object({
            conversationId: Type.Number(),
            submission: Type.Number(),
            text: Type.String(),
          }),
          Type.Union([Type.Number(), Type.Null()]),
        ),
        quota: method(Type.Object({}), Type.Array(ProviderQuotaSchema)),
        /**
         * Provider failures the bridge recorded, newest first.
         *
         * Unlike `quota`, this makes no network call: it is what the host saw when a turn
         * actually died, so it answers during an outage — which is the only time it is asked.
         */
        modelFailures: method(Type.Object({}), Type.Array(ProviderFailureSchema)),
        /** Where the host is running: storage path, working directory, start time. */
        info: method(Type.Object({}), HostInfoSchema),
        /**
         * Secret *names*, never values.
         *
         * There is deliberately no operation that returns a value: an adapter may write one and can
         * never read one, so a compromised or buggy surface cannot exfiltrate what it was trusted to
         * enter. `set` carries the value once, on the way in.
         */
        secrets: method(Type.Object({}), Type.Array(Type.Object({ name: Type.String(), addedBy: Type.Optional(Type.String()) }))),
        setSecret: method(
          Type.Object({ name: Type.String(), value: Type.String(), addedBy: Type.String() }),
          Type.Object({ ok: Type.Optional(Type.Boolean()), error: Type.Optional(Type.String()) }),
        ),
        removeSecret: method(Type.Object({ name: Type.String() }), Type.Boolean()),
        /**
         * Wait for a submission to settle.
         *
         * Session-level, not conversation-level: the id is enough — that is what makes it durable
         * across a host restart — and the Chat handler words its failure notices from the answer, so
         * an adapter that cannot wait cannot say why a turn produced nothing.
         */
        awaitSubmission: method(Type.Object({ submissionId: Type.Number() }), SettledSchema),
        /** Store-wide token and cost totals, as the host tallies them. */
        usage: method(
          Type.Object({}),
          Type.Object({
            models: Type.Record(Type.String(), Type.Unknown()),
            tools: Type.Record(Type.String(), Type.Unknown()),
          }),
        ),
        /**
         * The notification validator's record for a name.
         *
         * Keyed by name rather than conversation because that is what the adapter has: a Chat thread
         * is validated before it is necessarily a conversation.
         */
        recordVerdict: method(Type.Object({ name: Type.String(), verdict: AdapterVerdictSchema }), Type.Null()),
        verdict: method(
          Type.Object({ name: Type.String() }),
          Type.Union([AdapterVerdictSchema, Type.Null()]),
        ),
      },
    },
  },
});
