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

/**
 * Frames in, stream calls out — the one place that decides what a view change means.
 *
 * Shared by every transport that feeds a `ReplyStream`: the in-process sink below, and any
 * surface that reads the same frames over the wire (`GET /v1/view`). Two copies of this
 * rule is how two view paths start painting differently, and the rule has opinions worth
 * keeping in one place: only non-empty text is painted (so an ending run does not blank a
 * message that `finish()` owns), and a tool line is shown once per call rather than on
 * every frame.
 *
 * A frame is a `ProjectedView` on every transport: the seam hands one out, and the wire
 * carries the same JSON. So this takes the projection and never re-projects — projecting a
 * projection yields an empty one, which is the bug this signature exists to prevent.
 */
export interface FrameHooks {
  /**
   * The turn finished, as far as the *view* can tell (`busy` went true → false).
   *
   * This is the one push-driven edge worth having: the answer arrives as a transcript entry
   * a moment later, and without this the painter would find it on its next tick — up to
   * fifteen seconds of an answer sitting unposted at the end of every turn. The frame says
   * "stop looking at the view"; the entry read says "here is what to post".
   */
  onSettle?(): void;
}

export function viewFramePainter(
  stream: StreamTarget,
  hooks: FrameHooks = {},
): (projected: ProjectedView) => void {
  let painted = "";
  let shownCallId: string | undefined;
  let wasBusy: boolean | undefined;
  return (projected) => {
    // Settle edge first: the caller may read entries inside this call, and painting the last
    // snapshot first would put an answer behind a stale "Thinking…".
    if (wasBusy === true && projected.busy === false) hooks.onSettle?.();
    wasBusy = projected.busy;
    // What the turn has already said, then the message being generated. A turn is
    // several messages — say something, call a tool, say something else — and
    // painting only `liveText` meant each message replaced the last in the Chat
    // placeholder, so the answer appeared to shrink backwards as the turn went on.
    // Joined with a blank line, which is where the model's own paragraph breaks are.
    const body = projected.turnText
      ? projected.liveText
        ? `${projected.turnText}\n\n${projected.liveText}`
        : projected.turnText
      : projected.liveText;
    if (body !== painted) {
      painted = body;
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
}

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
  /** The turn settled, as far as the view can tell. See `FrameHooks.onSettle`. */
  onSettle?: () => void;
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
  let detached = false;
  // Painting is `viewFramePainter`'s job — the same function the stream transport uses, so
  // the two cannot drift. What stays local is the *sink's* own bookkeeping: what the
  // placeholder currently shows, and whether it is still attached.
  const paint = viewFramePainter(stream, { ...(options.onSettle ? { onSettle: options.onSettle } : {}) });
  const apply = (next: ProjectedView): void => {
    if (detached) return;
    projected = next;
    paint(next);
  };

  const handle = await seam.attach(conversationId, (next) => {
    try {
      apply(next);
    } catch (error) {
      onError?.(error);
    }
  });
  if (!handle) throw new Error(`no such conversation: ${conversationId}`);

  // Belt and braces for the ordering: if a frame somehow did not arrive first. The painter
  // handles "nothing changed" itself, so this is safe even when the snapshot repeats.
  // Either half counts: a turn whose live message is momentarily empty still has
  // text worth painting, and checking only `liveText` skipped it.
  const blank = projected.liveText === "" && projected.turnText === "";
  const filled = handle.snapshot.liveText !== "" || handle.snapshot.turnText !== "";
  if (blank && filled) apply(handle.snapshot);

  return {
    current: () => projected,
    detach: async () => {
      if (detached) return;
      detached = true;
      handle.detach();
    },
  };
}
