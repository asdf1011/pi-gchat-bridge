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

import { deriveArtifacts, mergeArtifacts, type ArtifactEntryLike, type ArtifactFile } from "../durable/artifacts.js";
import {
  annotate,
  artifactKeyForPath,
  changedFiles,
  classifyComments,
  commitTurn,
  currentRevision,
  repoRelativePath,
  revisionDiff,
  type AnnotatedLine,
  type ArtifactComment,
  type ResolvedComment,
} from "../durable/artifact-vcs.js";
import { placeComment, reanchor } from "../durable/successor.js";
import { mergeRevisions, type ArtifactRevision } from "../durable/artifact-revisions.js";
import {
  anchorsForSelection,
  deriveQuoteSelection,
  MAX_COMMENT_CHARS,
  newCommentId,
  selectionFromOffsets,
} from "../durable/comments.js";
import { filesChangedSince } from "../durable/observed-files.js";
import type { BridgeHost } from "../durable/host.js";
import { projectView, type ProjectedView, type ViewLike } from "./projection.js";
import type {
  AdapterEntry,
  AdapterVerdict,
  AgentConfig,
  CommentInput,
  CommentReply,
  CommentSuccessor,
  CommentView,
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
   * Show a turn started on another surface in the Chat side of a conversation.
   *
   * Injected rather than implemented here: the Chat client is the session host's
   * business, and an adapter must never hold those credentials.
   */
  mirrorTurn?: (conversationId: number, submissionId: number, prompt: string) => Promise<boolean>;
  /** Directories an artifact path may resolve under. */
  roots: readonly string[];
  /** Chord context for host calls; defaults to the host's. */
  context?: Context;
  /** Told when a filesystem observation fails. Observing is best-effort. */
  onObserveError?: (error: unknown) => void;
  /**
   * The jj repository tracking one conversation's artifacts, if any.
   *
   * Supplied by the caller rather than derived here: where artifacts live is a
   * deployment decision (see `BRIDGE_ARTIFACTS_DIR`), not a session-host fact.
   * Returning `undefined` disables version control for that conversation and
   * leaves the mtime walk as the only witness — which is the status quo.
   */
  artifactRepoFor?: (conversationId: number) => string | undefined;
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
    preview?: string;
  }): NamedConversation => ({
    conversationId: binding.conversationId,
    name,
    ...(binding.name === undefined ? {} : { label: binding.name }),
    model: binding.model,
    ...(binding.thinking === undefined ? {} : { thinking: binding.thinking }),
    createdAt: binding.createdAt,
    lastActivityAt: binding.updatedAt ?? binding.createdAt,
    ...(binding.preview === undefined ? {} : { preview: binding.preview }),
  });

  /**
   * Note what the turn changed, once it has settled.
   *
   * `awaitSubmission` is the only hook that fires for both surfaces — Chat and
   * web both submit and forget — so it is where the observation hangs. Concurrent
   * turns each walk with their own start time; a file two of them touched shows
   * up in both, which is true.
   */
  async function observeFiles(
    conversationId: number,
    submissionId: number,
    startedAt: number,
  ): Promise<void> {
    try {
      await host.awaitSubmission(submissionId);
      // The walk runs first, deliberately. `commitTurn` writes into `.jj/`, which
      // the walk already skips, but ordering it this way means no harness write
      // can ever be picked up as a file the turn produced.
      const changed = await filesChangedSince(options.roots, startedAt);
      await host.recordObservedFiles(conversationId, changed);
    } catch (error) {
      // A missing artifact list is a small loss; a crashed host is not.
      options.onObserveError?.(error);
    }

    // Committing the turn is separate from observing it: an observation failure
    // must not cost the revision, and a broken repository must not cost the
    // artifact list. Each is wrapped on its own for that reason.
    const repo = options.artifactRepoFor?.(conversationId);
    if (repo) {
      try {
        const revision = await commitTurn(repo, submissionId);
        if (revision !== undefined) {
          // Which files the revision holds, so a reopened conversation can show
          // the version it produced rather than whatever the path says today.
          // Recorded here rather than derived later: "which revision changed this
          // file" is a diff question, and the answer is free at this moment.
          const files = await changedFiles(repo, revision).catch(() => [] as string[]);
          const at = Date.now();
          const pins: ArtifactRevision[] = files.map((file) => ({
            // Stored as the viewer's key, not the repository's path, so a
            // "show me the version this conversation produced" link works.
            file: artifactKeyForPath(repo, file),
            changeId: revision,
            submissionId,
            at,
          }));
          await host.recordRevisions(conversationId, pins);
        }
      } catch (error) {
        options.onObserveError?.(error);
      }
    }
  }

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

    async history(
      conversationId: number,
      options?: { limit?: number; offset?: number },
    ): Promise<readonly TranscriptMessage[] | undefined> {
      return host.history(conversationId, options?.limit, options?.offset);
    },

    async image(
      conversationId: number,
      entryId: number,
      index: number,
    ): Promise<{ mimeType: string; data: string } | undefined> {
      return host.image(conversationId, entryId, index);
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
        const derived = deriveArtifacts(entries as readonly ArtifactEntryLike[], options.roots);
        // Plus whatever the filesystem saw change during this conversation's
        // turns: `bash` edits leave no path in the transcript to derive from.
        return mergeArtifacts(derived, await host.observedFiles(conversationId), options.roots);
      } finally {
        opened.dispose();
      }
    },

    async comments(conversationId: number): Promise<readonly CommentView[] | undefined> {
      const conversation = await conversationOf(conversationId);
      if (!conversation) return undefined;
      const stored = await host.comments(conversationId);
      const repo = options.artifactRepoFor?.(conversationId);
      // Annotate each commented file once, not once per comment: a conversation
      // with ten comments on one file pays for one annotate, and a file that
      // cannot be annotated (deleted, no repository) leaves its comments
      // orphaned rather than failing the request.
      const annotated = new Map<string, readonly AnnotatedLine[]>();
      if (repo !== undefined) {
        for (const file of new Set(stored.map((comment) => comment.file))) {
          try {
            annotated.set(file, await annotate(repo, "@", repoRelativePath(repo, file)));
          } catch {
            // Orphaned: the anchor is still recorded, the position is not.
          }
        }
      }
      const classified = await reanchorAll(
        repo,
        classifyComments(stored as readonly ArtifactComment[], annotated),
        stored,
      );
      return classified.map((comment) => ({
        id: comment.id,
        file: comment.file,
        anchors: comment.anchors,
        ...(comment.quote === undefined ? {} : { quote: comment.quote }),
        ...(comment.charStart === undefined ? {} : { charStart: comment.charStart }),
        ...(comment.charEnd === undefined ? {} : { charEnd: comment.charEnd }),
        ...(comment.occurrence === undefined ? {} : { occurrence: comment.occurrence }),
        text: comment.text,
        at: comment.at,
        ...(comment.author === undefined ? {} : { author: comment.author }),
        ...(comment.resolved === undefined ? {} : { resolved: comment.resolved }),
        state: comment.state,
        positions: comment.positions,
        ...(comment.successor === undefined ? {} : { successor: comment.successor }),
        ...(comment.atRevision === undefined ? {} : { atRevision: comment.atRevision }),
        ...(comment.submissions === undefined ? {} : { submissions: comment.submissions }),
        ...(comment.replies === undefined ? {} : { replies: comment.replies }),
      }));
    },

    async addComment(conversationId: number, input: CommentInput): Promise<{ comment: CommentView } | { error: string }> {
      const text = input.text.trim();
      if (text === "") return { error: "empty comment" };
      if (text.length > MAX_COMMENT_CHARS) {
        return { error: `comment is longer than ${MAX_COMMENT_CHARS} characters` };
      }
      const repo = options.artifactRepoFor?.(conversationId);
      if (repo === undefined) {
        // The deployment chose not to version artifacts, so there is nothing to
        // anchor to. Saying so is better than anchoring to a line that will mean
        // something else tomorrow.
        return { error: "artifacts are not version controlled in this deployment" };
      }
      const conversation = await conversationOf(conversationId);
      if (!conversation) return { error: `no such conversation: ${conversationId}` };

      // The annotation is the authority: the viewer says which lines a person
      // dragged across, and this decides which revisions those lines came from
      // and what they said. A stale viewer gets a refusal.
      let lines: AnnotatedLine[];
      try {
        lines = await annotate(repo, "@", repoRelativePath(repo, input.file));
      } catch (error) {
        return { error: `cannot annotate ${input.file}: ${(error as Error).message}` };
      }
      // A rendered document reports text, not line numbers: a paragraph is not a
      // line. So the source — which the annotation already carries — is searched
      // for that text, and the *host* decides where the anchor goes. The client
      // never supplies a position it could get wrong.
      let selection = input.selection;
      if (selection.line === undefined) {
        const source = lines.map((line) => line.content).join("\n");
        if (!selection.quote) return { error: "a selection needs a line, or a quote" };
        const span = deriveQuoteSelection(source, selection.quote, selection.occurrence ?? 0);
        if (!span) {
          return {
            error: "that text could not be located in the file; select within a line and try again",
          };
        }
        selection = { ...selection, ...selectionFromOffsets(source, span.start, span.end) };
      }

      const anchored = anchorsForSelection(lines, selection);
      if ("error" in anchored) return anchored;

      // Two quotes, one comment. The *anchor* addresses source text, which is
      // what jj annotates; the quote is what the reader actually selected, which
      // is what the rendered view searches for when it paints its own highlight
      // and what the model should see. For a source selection they are the same
      // string; for a rendered one they differ by markup, and swapping them would
      // make the highlight impossible to find.
      const shown = selection.quote?.trim();
      const quote = shown === undefined || shown === "" ? anchored.quote : shown.slice(0, 400);

      const id = newCommentId();
      // The revision this comment is written *against*, recorded now: it is the one
      // fact that lets a later edit be mapped instead of guessed at. Best-effort —
      // a repository that cannot answer is a lost mapping, not a lost comment.
      const atRevision = await currentRevision(repo);
      const stored = {
        id,
        file: input.file,
        anchors: anchored.anchors,
        ...(quote === undefined || quote === "" ? {} : { quote }),
        ...(anchored.charStart === undefined ? {} : { charStart: anchored.charStart }),
        ...(anchored.charEnd === undefined ? {} : { charEnd: anchored.charEnd }),
        ...(selection.occurrence === undefined ? {} : { occurrence: selection.occurrence }),
        text,
        at: Date.now(),
        ...(input.author === undefined ? {} : { author: input.author }),
        ...(atRevision === undefined ? {} : { atRevision }),
      };
      await host.addComment(conversationId, stored);
      // The new comment is live by construction — the anchors came from the
      // annotation it was just written against — so the positions are known
      // without a second annotate.
      return {
        comment: {
          ...stored,
          state: "visible",
          positions: anchored.anchors.map((anchor) => {
            const line = lines.find(
              (candidate) =>
                candidate.changeId === anchor.changeId && candidate.originalLine === anchor.originalLine,
            );
            return line?.line ?? anchor.originalLine;
          }),
        },
      };
    },

    async replyToComment(
      conversationId: number,
      commentId: string,
      text: string,
    ): Promise<{ id: string } | { error: string }> {
      return host.addCommentReply(conversationId, commentId, text);
    },

    async resolveComment(conversationId: number, commentId: string, resolved: boolean): Promise<boolean> {
      return host.setCommentResolved(conversationId, commentId, resolved);
    },

    async noteCommentSubmission(conversationId: number, commentId: string, submissionId: number): Promise<void> {
      return host.appendCommentSubmission(conversationId, commentId, submissionId);
    },

    async commentThread(conversationId: number, commentId: string): Promise<readonly CommentReply[] | undefined> {
      const stored = await host.comments(conversationId);
      const comment = stored.find((candidate) => candidate.id === commentId);
      if (!comment) return undefined;
      const exchanges: CommentReply[] = [];
      for (const submissionId of comment.submissions ?? []) {
        // A turn that is still running, or one whose answer was lost, leaves the
        // question visible and the answer absent — which is the honest shape.
        const settled = await host.awaitSubmission(submissionId).catch(() => undefined);
        const answer = settled && settled.status === "done" ? settled.text : undefined;
        exchanges.push({ kind: "answer", text: answer ?? "", submissionId });
      }
      for (const reply of comment.replies ?? []) {
        exchanges.push({
          kind: "note",
          text: reply.text,
          at: reply.at,
          ...(reply.author === undefined ? {} : { author: reply.author }),
        });
      }
      return exchanges;
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

    async mirrorTurn(conversationId: number, submissionId: number, prompt: string): Promise<boolean> {
      if (!options.mirrorTurn) return false;
      return options.mirrorTurn(conversationId, submissionId, prompt);
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
      // Before the turn, not after: the walk looks for files newer than this, so
      // the clock has to be read before the first command can touch anything.
      const startedAt = Date.now();
      const submission = await conversation.submit(
        {
          type: "input",
          content: toUserInput(request.content),
          whenBusy: request.whenBusy ?? "steer",
          ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
        },
        host.context,
      );
      // Which surface this came from, stamped against the entry the submission
      // created. `recordOrigin` finds that entry itself (it is the newest user entry
      // with no stamp), so the rule about how a submission becomes an entry stays in
      // the host instead of being re-derived by every adapter.
      if (request.origin) {
        await host
          .recordOrigin(conversationId, submission.id as unknown as number, request.origin)
          .catch(() => {});
      }
      // Remember that the conversation was used, and what it opened with, for the
      // recent list: a title is a model call away, and the list needs a name now.
      await host.touch(conversationId).catch(() => {});
      const firstText =
        typeof request.content === "string"
          ? request.content
          : request.content.find((part) => part.type === "text")?.text;
      if (firstText) await host.setPreview(conversationId, firstText).catch(() => {});
      // Off the reply path: the answer does not wait for a filesystem walk, and a
      // walk that fails costs a drawer entry, not a turn.
      void observeFiles(conversationId, submission.id as unknown as number, startedAt);
      return { submissionId: submission.id as unknown as number };
    },
  };
}

/**
 * Ask history where the comments that no longer resolve went.
 *
 * Annotation can prove a comment is live but not that it is dead, so an orphaned
 * note is a *question* — and one the diff can usually answer, because the usual
 * reason a line vanished is the turn the reviewer asked for. The mapping is the
 * difference between a review that ends in a list of orphans and one that follows
 * the code to where it went.
 *
 * Best-effort by construction: no repository, no recorded revision, an unreadable
 * file or a failed jj call all leave the comment exactly as annotation left it
 * (`orphaned`), because a lost mapping must never cost a lost review. One diff per
 * revision pair and one annotate per file are shared across the comments that need
 * them, so a thread of ten notes on one file is still two calls.
 */
async function reanchorAll(
  repo: string | undefined,
  classified: readonly ResolvedComment[],
  stored: readonly { id: string; file: string; atRevision?: string }[],
): Promise<(ResolvedComment & { successor?: CommentSuccessor })[]> {
  if (repo === undefined) return [...classified];

  const annotateAt = new Map<string, readonly AnnotatedLine[] | undefined>();
  const diffs = new Map<string, Awaited<ReturnType<typeof revisionDiff>> | undefined>();
  let current: string | undefined | false;

  const deps = {
    current: async () => {
      if (current === undefined) current = (await currentRevision(repo)) ?? false;
      return current === false ? undefined : current;
    },
    annotate: async (revision: string, file: string) => {
      const key = `${revision}\u0000${file}`;
      if (!annotateAt.has(key)) {
        annotateAt.set(
          key,
          await annotate(repo, revision, repoRelativePath(repo, file)).catch(() => undefined),
        );
      }
      return annotateAt.get(key);
    },
    diff: async (from: string, to: string) => {
      const key = `${from}\u0000${to}`;
      if (!diffs.has(key)) diffs.set(key, await revisionDiff(repo, from, to).catch(() => undefined));
      return diffs.get(key);
    },
  };

  const out: (ResolvedComment & { successor?: CommentSuccessor })[] = [];
  for (const comment of classified) {
    const atRevision = stored.find((candidate) => candidate.id === comment.id)?.atRevision;
    if (comment.state !== "orphaned" || atRevision === undefined) {
      out.push(comment);
      continue;
    }
    const found = await reanchor({ file: comment.file, anchors: comment.anchors, atRevision }, deps).catch(
      () => undefined,
    );
    if (!found) {
      out.push(comment);
      continue;
    }
    out.push({ ...comment, ...placeComment(comment.anchors.length, found) });
  }
  return out;
}

/** Re-exported so an adapter can name the model ref it passes, without the library. */
export type { AgentConfig, NamedConversation, SessionHost } from "./api.js";
export { parseModel };
