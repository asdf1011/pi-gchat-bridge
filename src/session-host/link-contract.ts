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
         * Show a turn started on another surface in the Chat side of a conversation.
         *
         * On the session object because it needs the Chat client and the
         * conversation-name mapping, neither of which an adapter has.
         */
        mirrorTurn: method(
          Type.Object({ conversation: Type.Number(), submission: Type.Number(), prompt: Type.String() }),
          Type.Boolean(),
        ),
      },
    },
  },
});
