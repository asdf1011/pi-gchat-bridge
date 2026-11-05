/**
 * The Chat sink: paint one pi-durable conversation into one `ReplyStream`.
 *
 * This is the durable replacement for the event wiring in `agent-sessions.ts`
 * (`session.subscribe` → `onDelta`/`showTool`/`clearTool` → `finish`). What it
 * does *not* replace is `ReplyStream` itself, deliberately: every Chat-API
 * quirk — the delayed "Thinking…" placeholder, in-place PATCHes, the 4,000-char
 * chunking, the code-fence repair at a chunk boundary, and the notification
 * trade-off in `finish()` — is platform behaviour that survived the migration
 * unchanged.
 *
 * The sink is deliberately dumb: it subscribes, translates, and gets out of the
 * way. Ordering is guaranteed by the caller awaiting the submission *after*
 * attaching the sink, so `finish()` can never be followed by a late snapshot.
 */
import { activeTool, projectView, type ProjectedView } from "../session-host/projection.js";
import type { SessionHost } from "../session-host/api.js";

/** The slice of `ReplyStream` the sink drives. Structural, so tests need no Chat client. */
export interface StreamTarget {
  onSnapshot(full: string): void;
  showTool(toolName: string, args: unknown): void;
  clearTool(): void;
}

export interface ViewSinkOptions {
  /** The conversation host: the sink needs one attachment, nothing else. */
  seam: SessionHost;
  conversationId: number;
  stream: StreamTarget;
  /** Called for a snapshot the sink cannot paint (never fatal). */
  onError?: (error: unknown) => void;
}

export interface ViewSink {
  /** Latest projection, for the caller's own bookkeeping (finish text, /status). */
  current(): ProjectedView;
  /** Stop watching. Safe to call twice. */
  detach(): Promise<void>;
}

/**
 * Attach a sink to a conversation's view.
 *
 * Tool status follows the same rule as the old bridge: show the newest
 * unfinished call, and clear once none is left, so a fast tool does not leave a
 * stale line (ReplyStream additionally debounces the show).
 */
export async function attachViewSink(options: ViewSinkOptions): Promise<ViewSink> {
  const { seam, conversationId, stream, onError } = options;

  let projected = projectView(undefined);
  let shownCallId: string | undefined;
  let detached = false;
  // What the placeholder currently shows. Only non-empty text is painted: the
  // sink must not blank the message when a run ends, because `finish()` owns the
  // final state (and deliberately handles the empty/aborted case by deleting the
  // placeholder). Painting "" here would flash an empty message before the answer.
  let painted = "";

  const apply = (next: ProjectedView): void => {
    if (detached) return;
    projected = next;
    if (projected.liveText !== painted) {
      painted = projected.liveText;
      if (painted !== "") stream.onSnapshot(painted);
    }

    const tool = activeTool(projected.tools);
    if (tool && tool.callId !== shownCallId) {
      shownCallId = tool.callId;
      stream.showTool(tool.name, tool.arguments);
    } else if (!tool && shownCallId !== undefined) {
      shownCallId = undefined;
      stream.clearTool();
    }
  };

  // The seam sends the state at attach time as the first frame, so a sink
  // attached mid-run (a reconnect, or a message that arrived while the run was
  // already going) never starts from a blank placeholder.
  const handle = await seam.attach(conversationId, (next) => {
    try {
      apply(next);
    } catch (error) {
      onError?.(error);
    }
  });
  if (!handle) throw new Error(`no such conversation: ${conversationId}`);

  // Belt and braces for the ordering: if a frame somehow did not arrive first.
  if (painted === "" && projected.liveText === "" && handle.snapshot.liveText !== "") apply(handle.snapshot);

  return {
    current: () => projected,
    detach: async () => {
      if (detached) return;
      detached = true;
      handle.detach();
    },
  };
}
