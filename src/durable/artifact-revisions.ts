/**
 * Which revision of an artifact a conversation produced.
 *
 * An artifact directory is a jj repository committed once per turn, so every file
 * a conversation wrote has a revision that *is* the version that conversation
 * produced. Recording it here answers the question a reopened conversation asks:
 * "show me what this made", rather than "show me whatever that path contains
 * today" — which, for a scratch directory, may be a later conversation's work.
 *
 * Deliberately a small per-file record and not a history: jj already holds the
 * history, and `revisionLog()` can list it for any file on demand. This is only
 * the pointer to the newest one, kept beside the observed-file list because that
 * is written at the same moment, from the same turn.
 *
 * A type alias, not an interface: it is stored inside a pi-durable document, and
 * those accept literals with an implicit index signature.
 */
export type ArtifactRevision = {
  /** Path relative to the repository root, which is also the artifact key. */
  file: string;
  /** Change id of the turn's revision, the stable handle across rewrites. */
  changeId: string;
  /** The submission that produced it, so a viewer can name the turn. */
  submissionId: number;
  /** Epoch ms, for ordering and display. */
  at: number;
};

/** Most files one conversation pins revisions for. */
export const MAX_REVISIONS_PER_CONVERSATION = 400;

/**
 * Newest first, one record per file.
 *
 * A file the same conversation changed in five turns has one pin — the newest —
 * because "what this conversation produced" is a single answer. Older revisions
 * remain reachable through jj (`revisionLog`), which is where a history belongs.
 */
export function mergeRevisions(
  existing: readonly ArtifactRevision[] | undefined,
  fresh: readonly ArtifactRevision[],
  max = MAX_REVISIONS_PER_CONVERSATION,
): ArtifactRevision[] {
  const byFile = new Map<string, ArtifactRevision>();
  for (const revision of existing ?? []) byFile.set(revision.file, revision);
  for (const revision of fresh) {
    const previous = byFile.get(revision.file);
    byFile.set(revision.file, previous && previous.at > revision.at ? previous : revision);
  }
  return [...byFile.values()].sort((a, b) => b.at - a.at).slice(0, max);
}
