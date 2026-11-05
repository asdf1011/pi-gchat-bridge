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
         * Say something in the Chat thread behind a conversation.
         *
         * On the session object because it needs the Chat client and the
         * conversation-name mapping, neither of which an adapter has.
         */
        announce: method(
          Type.Object({ conversation: Type.Number(), text: Type.String() }),
          Type.Boolean(),
        ),
      },
    },
  },
});
