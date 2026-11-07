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
          "That directory is a jj repository, committed once per turn, so the user can comment on a specific revision and line.",
          "Write scratch scripts, generated data, and anything worth keeping there; keep throwaway logs and one-off probes in `/tmp`.",
          "Do not run `jj` in that directory yourself — the harness commits it at the end of each turn.",
        ].join("\n");
      }),
    ],
  });
}
