/**
 * Artifact guidance — where a conversation's scratch files belong.
 *
 * The conversation's artifact directory is a jj repository, committed once per
 * turn, so a review comment can name a revision and a line and `jj file annotate`
 * can say whether that line is still live. None of that works if the files are
 * written somewhere else: `/tmp` is outside the artifact roots, so a script there
 * can never be annotated, commented on, or even served to a viewer.
 *
 * So this section states the location, per conversation. It is rendered rather
 * than constant — the path contains the conversation id — but the shape is fixed,
 * so the prompt cache still gets long stable prefixes.
 *
 * Deliberately narrow: it says *where*, not *whether*. Ephemeral logs and
 * one-off probes are still fine in `/tmp`; the rule is about files worth keeping
 * long enough to comment on.
 *
 * It also says to commit as you go. The end-of-turn commit exists to give a comment
 * an anchor, not to decide what history looks like: a file written and discussed in
 * the same message would otherwise have no revision until the turn ends, and the
 * reviewer would have nothing to reply to. The `comment_reply` path commits before
 * it writes (see `comment-tools.ts`), so the advice is enforced where it matters and
 * this is the part the model can act on itself.
 */
import { defineExtension, section } from "@earendil-works/pi-durable";

/** The directory name, relative to the artifacts root, that a conversation owns. */
export function conversationArtifactDir(root: string, conversationId: number | string): string {
  return `${root}/conversation/${conversationId}`;
}

/**
 * Build the extension for one artifacts root.
 *
 * `root` empty means tracking is off, and the section is not installed at all —
 * better than telling the model about a directory nothing commits.
 */
export function artifactGuidance(root: string) {
  return defineExtension({
    name: "artifact-guidance",
    sections: [
      section("artifact_files", (input) => {
        const dir = conversationArtifactDir(root, input.conversationId as unknown as number);
        return [
          `Files you want the user to be able to review later belong in \`${dir}\`.`,
          "That directory is a jj repository. Commit as you go, so there is always a revision to talk about:",
          "- `jj commit -m \"<what changed>\"` once a change is worth discussing — writing a file and then asking for a review of it happens inside one turn, and without a commit there are no lines to annotate.",
          "- `jj describe -m \"<what changed>\"` instead, if you would rather keep working in the same change.",
          "- Read-only `jj` is always fine: `status`, `diff`, `log`, `show`.",
          "- Never push, and never discard work (`abandon`, `restore`, `op restore`).",
          "- The harness also commits at the end of each turn, as a backstop for anything left in the working copy; replying to a review comment commits first, automatically.",
          "Write scratch scripts, generated data, and anything worth keeping there; keep throwaway logs and one-off probes in `/tmp`.",
        ].join("\n");
      }),
    ],
  });
}
