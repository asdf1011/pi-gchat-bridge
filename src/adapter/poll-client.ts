/**
 * The client half of the conversation protocol: two ordinary requests.
 *
 * There is no streaming half any more, and that is the point — a client states its cursor and gets
 * an answer, so there is nothing to reconnect, no silence to detect and no mode to fall out of.
 * `httpPoll` is the delivery loop's request; `httpSnapshot` is the one-shot question a surface asks
 * while it paints a turn ("what does it look like now").
 */
export interface PollResult {
  cursor: number;
  entries: { conversationId: number; entryId: number; role: "user" | "assistant"; text: string; at?: number; origin?: string }[];
  /** How long the server actually waited. Far below `wait` with no entries means a cache answered. */
  waitedMs: number;
  busy?: boolean;
  view?: { liveText: string; busy: boolean; tools: unknown } | null;
}

export async function httpPoll(options: {
  baseUrl: string;
  since: number;
  waitSeconds?: number;
  batchMs?: number;
  conversationId?: number;
  observe?: boolean;
  token?: string;
  signal?: AbortSignal;
}): Promise<PollResult> {
  const query = new URLSearchParams({ since: String(options.since) });
  if (options.waitSeconds !== undefined) query.set("wait", String(options.waitSeconds));
  if (options.batchMs !== undefined) query.set("batch", String(options.batchMs));
  if (options.conversationId !== undefined) query.set("conversation", String(options.conversationId));
  if (options.observe) query.set("observe", "1");
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const response = await fetch(`${options.baseUrl.replace(/\/$/, "")}/v1/poll?${query.toString()}`, {
    headers,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) throw new Error(`poll: HTTP ${response.status}`);
  return (await response.json()) as PollResult;
}

/**
 * One snapshot: what does this conversation look like *now*.
 *
 * The painting half of the poll protocol. A surface showing a running turn asks this every few
 * hundred milliseconds and paints the answer as it grows — three updates a second, which is finer
 * than the 250ms debounce the Chat bridge already applies to its own placeholders.
 */
export async function httpSnapshot(options: {
  baseUrl: string;
  conversationId: number;
  token?: string;
  signal?: AbortSignal;
}): Promise<{ liveText: string; busy: boolean; tools: unknown } | undefined> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const response = await fetch(
    `${options.baseUrl.replace(/\/$/, "")}/v1/conversations/${options.conversationId}`,
    { headers, ...(options.signal ? { signal: options.signal } : {}) },
  );
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`snapshot: HTTP ${response.status}`);
  const body = (await response.json()) as { view?: { liveText?: string; busy?: boolean; tools?: unknown } };
  return {
    liveText: body.view?.liveText ?? "",
    busy: body.view?.busy === true,
    tools: body.view?.tools ?? [],
  };
}
