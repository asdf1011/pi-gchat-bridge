/**
 * The one tool an agent has for review comments: replying into a thread.
 *
 * **Plumbing, deliberately.** A reply written here appears next to the line in
 * the review pane and nowhere else: it is not a submission, so it does not reach
 * Chat and does not become an entry the model reads back on its next turn. The
 * turn's own answer is the thing the conversation sees — that is what makes a
 * comment thread read as "here is the change, and here is why" in Chat while the
 * review pane keeps the line-level conversation.
 *
 * There is no `comment_resolve` tool and there will not be one: resolving says
 * nothing actionable, so the agent neither needs it nor should be able to close a
 * reviewer's note. Resolving stays a human action, recorded where the model cannot
 * see it.
 *
 * No `comment_list` either. A comment arrives as a user message carrying its id;
 * an agent that goes looking for other people's open notes is an agent inventing
 * work.
 */
import { defineExtension, defineTool, hook, ToolTask } from "@earendil-works/pi-durable";
import { Type } from "typebox";

/** What the tool needs from the host: one write, scoped to a conversation. */
export interface CommentReplyTarget {
  reply(
    conversationId: number,
    commentId: string,
    text: string,
  ): Promise<{ id: string } | { error: string }>;
  /**
   * Commit the conversation's artifact working copy, so a comment has a revision
   * to be written against.
   *
   * Called before the reply is written, because that is the only order that works:
   * a comment anchors to lines that exist in a *revision*, and the harness's
   * end-of-turn commit has not happened yet while the turn is still running.
   */
  commitArtifacts?(conversationId: number): Promise<string | undefined>;
}

export function createCommentTools(target: CommentReplyTarget) {
  return defineExtension({
    name: "comment-tools",
    hooks: [
      // "Commit as you go", enforced rather than advised.
      //
      // The artifact guidance section tells a conversation to commit its scratch
      // change before asking for a review of it, and the end-of-turn commit catches
      // anything left over. Neither helps the case that actually bites: writing a
      // file and commenting on it in the *same* turn — which is exactly what a
      // review subagent does, and what a conversation does when it produces a
      // document and discusses it. Without this, the line being commented on has no
      // revision, and the comment is either refused or anchored to yesterday's tree.
      //
      // A hook, not a tool the model must remember to call: the one thing that has
      // to be true before an anchor is written is not something to leave to a
      // prompt. A failure here is swallowed — a reply that could not be committed
      // for is still better than a reply that was lost.
      hook(ToolTask, {
        beforeTool: async (call, api) => {
          if (call.name !== "comment_reply") return undefined;
          if (target.commitArtifacts === undefined) return undefined;
          await target.commitArtifacts(api.conversationId as unknown as number).catch(() => undefined);
          return undefined;
        },
      }),
    ],
    tools: [
      defineTool({
        name: "comment_reply",
        description:
          "Reply inside a review comment's thread. Use it for the short answer that belongs next to " +
          "the line you were asked about — it shows in the review pane and nowhere else, so keep your " +
          "explanation of the change itself in your normal response. Takes the comment id from the " +
          "comment you were sent (a prefix of it is enough).",
        parameters: Type.Object({
          commentId: Type.String({
            description: "The id shown in the comment you were sent, e.g. `2f4f5da0`.",
          }),
          text: Type.String({ description: "What to say in the thread. Plain text, markdown-free." }),
        }),
        // A reply is a small append to a document; replaying one after a restart
        // would duplicate it, so this is not safe to rerun.
        replay: "unsafe",
        async execute(args, api) {
          const result = await target.reply(
            api.conversationId as unknown as number,
            args.commentId,
            args.text,
          );
          // `output` is tool-result content: text parts, not a bare string.
          const say = (text: string, isError = false) => ({
            output: [{ type: "text" as const, text }],
            ...(isError ? { isError: true } : {}),
          });
          if ("error" in result) return say(`Could not reply: ${result.error}`, true);
          return say(
            `Replied in comment ${args.commentId}. It is visible in the review pane only — ` +
              "it was not posted to the conversation, so say anything about the change itself in your response.",
          );
        },
      }),
    ],
  });
}
