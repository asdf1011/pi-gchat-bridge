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
import type { Context } from "@earendil-works/chord";
import type { Conversation } from "@earendil-works/pi-durable";

import { activeTool, projectView, type ProjectedView, type ViewLike } from "../session-host/projection.js";

/** The slice of `ReplyStream` the sink drives. Structural, so tests need no Chat client. */
export interface StreamTarget {
  onSnapshot(full: string): void;
  showTool(toolName: string, args: unknown): void;
  clearTool(): void;
}

export interface ViewSinkOptions {
  conversation: Conversation;
  context: Context;
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
  const { conversation, context, stream, onError } = options;

  let projected = projectView(undefined);
  let shownCallId: string | undefined;
  let detached = false;
  // What the placeholder currently shows. Only non-empty text is painted: the
  // sink must not blank the message when a run ends, because `finish()` owns the
  // final state (and deliberately handles the empty/aborted case by deleting the
  // placeholder). Painting "" here would flash an empty message before the answer.
  let painted = "";

  const apply = (view: ViewLike | undefined): void => {
    if (detached) return;
    projected = projectView(view);
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

  const opened = await conversation.viewState(context);
  // Paint the state at attach time first: a sink attached mid-run (a reconnect,
  // or a message that arrived while the run was already going) must not start
  // from a blank placeholder.
  apply(opened.value as ViewLike);
  opened.subscribe((value: unknown) => {
    try {
      apply(value as ViewLike);
    } catch (error) {
      onError?.(error);
    }
  });

  return {
    current: () => projected,
    detach: async () => {
      if (detached) return;
      detached = true;
      opened.dispose();
    },
  };
}
