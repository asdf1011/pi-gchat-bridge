/**
 * What a Chat reply needs, projected out of a pi-durable conversation view.
 *
 * The old bridge painted a reply from pi's *event stream* (`text_delta`,
 * `tool_execution_start`…) and accumulated the deltas itself. pi-durable commits
 * whole partial snapshots instead, so everything below is derived from committed
 * state: `docs["pi.live"]` for the in-flight answer and tool round,
 * `entries` for the transcript.
 *
 * Kept pure and free of pi-durable imports beyond types, so the projection can be
 * tested against hand-written view values: this is the code most likely to drift
 * from what Chat actually shows, and drift is invisible without tests.
 */

/** The parts of a view value this module reads. Structural, so tests can fake a view. */
export interface ViewLike {
  entries?: readonly EntryLike[];
  docs?: Record<string, unknown>;
}

export interface EntryLike {
  id?: number;
  kind?: string;
  model?: readonly MessageLike[];
  data?: unknown;
}

export interface MessageLike {
  role?: string;
  content?: readonly ContentLike[];
}

export interface ContentLike {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

export interface ToolLike {
  callId: string;
  name: string;
  status: "pending" | "running" | "done";
  output?: string;
  arguments?: unknown;
}

export interface ProjectedView {
  /** The answer being streamed right now; empty when nothing is generating. */
  liveText: string;
  /** The current tool round, in call order, with arguments recovered from the transcript. */
  tools: ToolLike[];
  /** True while a run owns the conversation. */
  busy: boolean;
  /** Text of the newest assistant entry in the active transcript. */
  lastAssistantText: string;
}

/** Concatenated text blocks of one model message. */
export function messageText(message: MessageLike | undefined): string {
  return (message?.content ?? [])
    .flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : []))
    .join("");
}

/**
 * Tool calls a model message issued, keyed by call ID.
 *
 * `pi.live.tools` carries the call ID and status but not the arguments, and the
 * Chat status line wants both ("bash: rg -n …"). The arguments only exist in the
 * assistant message that issued the call, so the two are joined here.
 */
export function toolCallsOf(message: MessageLike | undefined): Map<string, { name: string; arguments: unknown }> {
  const calls = new Map<string, { name: string; arguments: unknown }>();
  for (const block of message?.content ?? []) {
    if (block.type === "toolCall" && typeof block.id === "string") {
      calls.set(block.id, { name: block.name ?? "", arguments: block.arguments });
    }
  }
  return calls;
}

/**
 * Arguments for the current tool round, from the newest assistant entry that
 * issued tool calls. Later rounds always append a newer assistant entry, so the
 * newest one is the round `pi.live.tools` is describing.
 */
function currentRoundArguments(entries: readonly EntryLike[]): Map<string, { name: string; arguments: unknown }> {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const calls = toolCallsOf(entries[index]?.model?.[0]);
    if (calls.size > 0) return calls;
  }
  return new Map();
}

export function projectView(view: ViewLike | undefined): ProjectedView {
  const live = (view?.docs?.["pi.live"] ?? {}) as {
    run?: unknown;
    generation?: { message?: MessageLike };
    tools?: readonly ToolLike[];
  };
  const entries = view?.entries ?? [];

  const args = currentRoundArguments(entries);

  let lastAssistantText = "";
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind !== "pi.assistant") continue;
    lastAssistantText = messageText(entry.model?.[0]);
    break;
  }

  return {
    liveText: messageText(live.generation?.message),
    tools: (live.tools ?? []).map((tool) => {
      const call = args.get(tool.callId);
      return {
        callId: tool.callId,
        name: tool.name,
        status: tool.status,
        ...(tool.output === undefined ? {} : { output: tool.output }),
        ...(call === undefined ? {} : { arguments: call.arguments }),
      };
    }),
    busy: live.run !== undefined,
    lastAssistantText,
  };
}

/**
 * The tool to show in the status line, or undefined when no tool is in flight.
 *
 * A `pending` call counts: with sequential execution the next call is issued but
 * not started, and hiding it would blank the status between two tools.
 */
export function activeTool(tools: readonly ToolLike[]): ToolLike | undefined {
  return [...tools].reverse().find((tool) => tool.status !== "done");
}
