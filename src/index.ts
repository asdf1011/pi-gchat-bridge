import http from "node:http";

import { AgentRouter, type ModelInfo, type SessionInfo } from "./agent-sessions.js";
import { ChatClient, MAX_MESSAGE_CHARS } from "./chat-client.js";
import { loadConfig } from "./config.js";
import { PubSubReceiver } from "./pubsub-receiver.js";
import type { HandleResult, MessageReceiver } from "./receiver.js";
import { StateStore } from "./state.js";
import type { IncomingMessage } from "./types.js";

const THINKING_TEXT = "Thinking…";
const PATCH_DEBOUNCE_MS = 250;
/** Delay before posting the placeholder — quick replies never show one. */
const MARKER_DELAY_MS = 3000;
/** Delay before showing the running tool's status line (avoids flicker for fast tools). */
const TOOL_STATUS_DELAY_MS = 500;
/** Card action method for the session picker dropdown. */
const RESUME_ACTION = "resume_session";
/** Card action method for the model picker dropdown. */
const MODEL_ACTION = "switch_model";

/**
 * Live streaming markers per conversation: the running turn's handler registers
 * its placeholder here so a steering message (a separate handler invocation)
 * can relocate the placeholder BELOW the steering message. Google Chat orders
 * thread messages by creation time, so without relocation the reply — which
 * now covers the steer — would render above the steering text. A placeholder
 * that already shows streamed text is kept in place (frozen) as a record of
 * what was being said; only the continued stream moves below the steer.
 * Entries are removed when the owning handler finishes.
 */
const markers = new Map<string, { owner: object; relocate: () => Promise<void> }>();

/** Extract the picked value from a CARD_CLICKED event (formInputs or parameters). */
function selectedValue(incoming: IncomingMessage): string | undefined {
  const formInputs = incoming.action?.formInputs;
  if (formInputs) {
    for (const key of Object.keys(formInputs)) {
      const value = formInputs[key]?.input?.stringInputs?.value?.[0];
      if (value) return value;
    }
  }
  return incoming.action?.parameters?.find((p) => p.key === "session")?.value;
}

/** Dropdown card listing sessions; selection fires a CARD_CLICKED event. */
function pickerCard(sessions: SessionInfo[]): unknown[] {
  return [
    {
      cardId: "session-picker",
      card: {
        header: { title: "Resume a session" },
        sections: [
          {
            widgets: [
              {
                selectionInput: {
                  name: "session_picker",
                  label: "Session",
                  type: "DROPDOWN",
                  items: sessions.map((s) => ({ text: s.label, value: s.file })),
                  onChangeAction: { function: RESUME_ACTION },
                },
              },
            ],
          },
        ],
      },
    },
  ];
}

/** Escape text for use inside Chat card/message HTML (e.g. user-supplied names). */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** One-line status shown under the stream while a tool is running (e.g. the command).
 *  The placeholder is PATCHed, so it renders legacy Chat syntax only — backtick
 *  monospace is the closest to a code block; the final answer renders real
 *  Markdown. Inner backticks are stripped so the wrap can't break. */
function toolStatusLine(toolName: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const command = typeof a.command === "string" ? a.command.trim().replace(/\s+/g, " ") : "";
  const path = typeof a.path === "string" ? a.path.trim() : "";
  const detail = (command || path).replace(/`/g, "").slice(0, 140);
  const label = command ? "Running" : `Running ${toolName}`;
  return detail ? `${label}: \`${detail}\`` : `${label}…`;
}

function confirmCard(label: string): unknown[] {
  const safe = escapeHtml(label);
  return [
    {
      cardId: "resume-confirm",
      card: {
        header: { title: "Session switched" },
        sections: [
          {
            widgets: [
              { textParagraph: { text: `Now on <b>${safe}</b>. Send a message to continue there.` } },
            ],
          },
        ],
      },
    },
  ];
}

function errorCard(message: string): unknown[] {
  const safe = message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return [
    {
      cardId: "resume-error",
      card: {
        header: { title: "Couldn't switch session" },
        sections: [{ widgets: [{ textParagraph: { text: safe } }] }],
      },
    },
  ];
}

function sessionStatsCard(stats: import("@earendil-works/pi-coding-agent").SessionStats, name?: string): unknown[] {
  const t = stats.tokens;
  const lines = [
    name ? `<b>${escapeHtml(name)}</b>` : "",
    `File: <b>${escapeHtml(stats.sessionFile?.split("/").pop() ?? "(in-memory)")}</b>`,
    `Messages: ${stats.totalMessages} (${stats.userMessages} user · ${stats.assistantMessages} assistant · ${stats.toolResults} tool results · ${stats.toolCalls} tool calls)`,
    `Tokens: ${t.total.toLocaleString()} total (${t.input.toLocaleString()} in · ${t.output.toLocaleString()} out · ${t.cacheRead.toLocaleString()} cache read)`,
    `Cost: <b>$${stats.cost.toFixed(4)}</b>`,
    stats.contextUsage ? `Context now: ${stats.contextUsage.tokens?.toLocaleString() ?? "unknown"} tokens (${stats.contextUsage.percent?.toFixed(0) ?? "?"}% of ${stats.contextUsage.contextWindow.toLocaleString()})` : "",
  ].filter(Boolean);
  return [
    {
      cardId: "session-stats",
      card: {
        header: { title: "Session" },
        sections: [
          {
            widgets: [{ textParagraph: { text: lines.join("<br>") } }],
          },
        ],
      },
    },
  ];
}

function modelPickerCard(models: ModelInfo[]): unknown[] {
  return [
    {
      cardId: "model-picker",
      card: {
        header: { title: "Switch backend model" },
        sections: [
          {
            widgets: [
              {
                selectionInput: {
                  name: "model_picker",
                  label: "Model",
                  type: "DROPDOWN",
                  items: models.map((m) => ({
                    text: m.label,
                    value: `${m.provider}|${m.id}`,
                  })),
                  onChangeAction: { function: MODEL_ACTION },
                },
              },
            ],
          },
        ],
      },
    },
  ];
}

function modelConfirmCard(result: { ok: boolean; label: string; error?: string }): unknown[] {
  const safe = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return [
    {
      cardId: "model-confirm",
      card: {
        header: { title: result.ok ? "Model switched" : "Couldn't switch model" },
        sections: [
          {
            widgets: [
              {
                textParagraph: {
                  text: result.ok
                    ? `Now on <b>${safe(result.label)}</b>.`
                    : `${safe(result.error ?? "Unknown error")}`,
                },
              },
            ],
          },
        ],
      },
    },
  ];
}

function helpCard(): unknown[] {
  const items = [
    ["<b>/resume</b>", "Resume a session (dropdown picker)"],
    ["<b>/sessions</b>", "Same as /resume"],
    ["<b>/list</b>", "Same as /resume"],
    ["<b>/name</b>", "Show or set this conversation's session name"],
    ["<b>/session</b>", "Show this conversation's session stats (tokens, cost)"],
    ["<b>/help</b>", "This card"],
    ["<b>anything else</b>", "Chats with pi (tools, skills, images)"],
  ];
  return [
    {
      cardId: "help",
      card: {
        header: { title: "Commands" },
        sections: [
          {
            widgets: [
              {
                textParagraph: {
                  text: items.map(([cmd, desc]) => `${cmd} — ${desc}`).join("<br>"),
                },
              },
            ],
          },
        ],
      },
    },
  ];
}

async function main(): Promise<void> {
  const config = loadConfig();
  console.log(`[bridge] cwd=${config.cwd}`);

  if (config.healthPort > 0) {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    });
    server.listen(config.healthPort, "0.0.0.0", () => {
      console.log(`[health] listening on :${config.healthPort}`);
    });
  }

  const client = new ChatClient(config.serviceAccountPath);
  const state = new StateStore(config.stateFile);
  const router = await AgentRouter.create(
    config.cwd,
    config.sessionsDir,
    config.stallTimeoutMs,
    config.watchdogIntervalMs,
    config.steerWaitMs,
    state,
  );

  /**
   * Handle one incoming Chat message with a live, in-place streaming reply:
   * post a "Thinking…" placeholder, patch it with streamed text as pi speaks,
   * then finalize (replace with the full answer, or delete if empty).
   */
  const handler = async (incoming: IncomingMessage): Promise<HandleResult> => {
    const spaceName = incoming.space.name;
    const display = incoming.space.displayName ?? spaceName;
    const text = incoming.message.text ?? "";
    const threadName = incoming.message.threadName;
    const threadKey = incoming.message.threadKey;
    // Conversations are keyed per thread (app-chosen threadKey wins when
    // present), so parallel threads never block each other (space is the
    // fallback for non-threaded DMs).
    const sessionKey = AgentRouter.keyFor(spaceName, threadName, threadKey);
    console.log(
      `[chat] ${display}: ${incoming.eventType === "CARD_CLICKED" ? `card:${incoming.action?.actionMethodName}` : text.slice(0, 120)}`,
    );

    // --- Interactive card events (dropdown selection, buttons) ---
    if (incoming.eventType === "CARD_CLICKED") {
      if (incoming.action?.actionMethodName === MODEL_ACTION) {
        const picked = selectedValue(incoming);
        if (!picked) {
          await client
            .updateMessageCards(incoming.message.name, modelConfirmCard({ ok: false, label: "", error: "No model was selected." }), "No model selected.")
            .catch((err) => console.error("[chat] card update failed:", (err as Error).message));
          return "ok";
        }
        const [provider, modelId] = picked.split("|");
        const result = await router.switchModel(sessionKey, provider ?? "", modelId ?? "");
        if (result.error === "busy") {
          console.log(`[chat] ${display}: busy, deferring model switch`);
          return "busy"; // leave unacked; retried once the session frees up
        }
        await client
          .updateMessageCards(incoming.message.name, modelConfirmCard(result), `Model switch: ${result.ok ? result.label : result.error}`)
          .catch((err) => console.error("[chat] card update failed:", (err as Error).message));
        console.log(`[chat] ${display}: model switch ${result.ok ? "-> " + result.label : "failed: " + result.error}`);
        return "ok";
      }
      if (incoming.action?.actionMethodName === RESUME_ACTION) {
        const picked = selectedValue(incoming);
        if (!picked) {
          await client
            .updateMessageCards(incoming.message.name, errorCard("No session was selected."), "No session selected.")
            .catch((err) => console.error("[chat] card update failed:", (err as Error).message));
          return "ok";
        }
        const label = await router.switchSession(sessionKey, picked);
        if (label === null) {
          console.log(`[chat] ${display}: busy, deferring session switch`);
          return "busy"; // leave unacked; redelivered once the session frees up
        }
        await client
          .updateMessageCards(incoming.message.name, confirmCard(label), `Resumed session ${label}.`)
          .catch((err) => console.error("[chat] card update failed:", (err as Error).message));
        console.log(`[chat] ${display}: resumed session ${label}`);
        return "ok";
      }
      console.log(`[chat] ${display}: unhandled card action`);
      return "ok";
    }

    // --- Built-in commands (handled by the bridge, not sent to pi) ---
    // Commands are explicit control: they interrupt any running reply first.
    if (/^\/model\b/.test(text.trim())) {
      if (router.isBusy(sessionKey)) await router.interrupt(sessionKey);
      const models = router.listModels();
      if (models.length === 0) {
        await client.sendMessage(spaceName, "No models configured.", threadName);
        return "ok";
      }
      await client.createCardMessage(spaceName, modelPickerCard(models), "Choose a backend model.", threadName);
      console.log(`[chat] ${display}: posted model picker (${models.length} models)`);
      return "ok";
    }
    if (/^\/session\b/.test(text.trim())) {
      if (router.isBusy(sessionKey)) await router.interrupt(sessionKey);
      const stats = router.sessionStats(sessionKey);
      if (!stats) {
        await client.sendMessage(spaceName, "No session for this conversation yet — send a message first.", threadName);
        return "ok";
      }
      const name = await router.getSessionName(sessionKey);
      await client.createCardMessage(spaceName, sessionStatsCard(stats, name), "Session stats.", threadName);
      console.log(`[chat] ${display}: posted session stats (${stats.totalMessages} messages, $${stats.cost.toFixed(4)})`);
      return "ok";
    }
    if (/^\/name\b/.test(text.trim())) {
      if (router.isBusy(sessionKey)) await router.interrupt(sessionKey);
      const arg = text.trim().replace(/^\/name\s*/, "").trim();
      if (!arg) {
        const current = await router.getSessionName(sessionKey);
        await client.sendMessage(
          spaceName,
          current
            ? `This conversation's session is named: **${escapeHtml(current)}**`
            : "This conversation has no session name yet. Use **/name &lt;name&gt;** to set one.",
          threadName,
        );
        console.log(`[chat] ${display}: queried session name (${current ?? "none"})`);
        return "ok";
      }
      const set = router.setSessionName(sessionKey, arg);
      if (set === null) {
        await client.sendMessage(
          spaceName,
          "No session for this conversation yet — send a message first, then use /name.",
          threadName,
        );
        return "ok";
      }
      await client.sendMessage(spaceName, `Session named: **${escapeHtml(arg)}**`, threadName);
      console.log(`[chat] ${display}: named session -> ${arg}`);
      return "ok";
    }
    if (/^\/help\b/.test(text.trim())) {
      if (router.isBusy(sessionKey)) await router.interrupt(sessionKey);
      await client.createCardMessage(spaceName, helpCard(), "Available commands: /resume, /sessions, /list, /help.", threadName);
      console.log(`[chat] ${display}: posted help card`);
      return "ok";
    }
    if (/^\/(resume|sessions|list)\b/.test(text.trim())) {
      if (router.isBusy(sessionKey)) await router.interrupt(sessionKey);
      const sessions = await router.listSessions();
      if (sessions.length === 0) {
        await client.sendMessage(spaceName, "No sessions found yet.", threadName);
        return "ok";
      }
      await client.createCardMessage(spaceName, pickerCard(sessions), "Choose a session to resume.", threadName);
      console.log(`[chat] ${display}: posted session picker (${sessions.length} sessions)`);
      return "ok";
    }

    // --- Plain message while the conversation is streaming: steer it into the
    // running turn (interleaved) with a bounded tool wait. If the in-flight
    // tool finishes within steerWaitMs its result lands and the steer is
    // delivered right after; otherwise abort + redirect so the interjection
    // is never stuck behind a long tool call. ---
    if (router.isBusy(sessionKey)) {
      const outcome = await router.redirect(sessionKey, text);
      if (outcome === "steered") {
        console.log(`[chat] ${display}: steered into running turn`);
        // The reply now covers the steer too, so move its placeholder below the
        // steering message — otherwise the response renders above the steer.
        await markers
          .get(sessionKey)
          ?.relocate()
          .catch((err) => console.error("[chat] marker relocate failed:", (err as Error).message));
        return "ok";
      }
      if (outcome === "redirected") {
        console.log(`[chat] ${display}: tool overrun — aborted, redirecting`);
        // Fall through: the new message becomes a normal prompt.
      }
      // not-busy: race — fall through to a normal prompt below.
    }

    let markerName: string | undefined;
    let markerTimer: NodeJS.Timeout | undefined;
    let streamed = "";
    let patchTimer: NodeJS.Timeout | undefined;
    /** Transient status line (e.g. the command pi is running), shown under the stream. */
    let statusText: string | undefined;
    /** Delays showing the status line so fast tools don't flicker. */
    let toolTimer: NodeJS.Timeout | undefined;
    /** Serialized placeholder updates: only one PATCH in flight at a time, applied in
     *  order, so a stale snapshot can never land after the final text (an out-of-order
     *  PATCH race could otherwise permanently truncate the stored message). */
    let patchChain: Promise<void> = Promise.resolve();
    /** Serialized placeholder relocations (a steer moves the streaming reply
     *  below the steering message; see `relocateMarker`). */
    let relocateChain: Promise<void> = Promise.resolve();
    /** Identity token so a stale handler can't unregister a newer one's marker. */
    const owner = {};

    /** Text to show in the placeholder: the stream plus any transient status line. */
    const displayText = (): string => {
      if (!statusText) return streamed.slice(0, MAX_MESSAGE_CHARS);
      const status = statusText.slice(0, 200);
      const base = streamed.slice(0, Math.max(0, MAX_MESSAGE_CHARS - status.length - 2));
      return base ? `${base}\n\n${status}` : status;
    };

    /**
     * Move the streaming placeholder below a steering message. Google Chat
     * orders thread messages by creation time, so a placeholder created before
     * the steer would render ABOVE the steering text once the reply covers it.
     * The old placeholder is kept where it is when it already carries real
     * text — a frozen record of what was being said when the user steered, so
     * the thread history still shows what the answer was a response to — and
     * a fresh one is created below the steer for the continued stream. Only a
     * bare "Thinking…" placeholder (nothing streamed yet) is deleted.
     */
    const relocateMarker = (): Promise<void> => {
      relocateChain = relocateChain.then(async () => {
        await patchChain; // settle queued patches before freezing the old marker
        const old = markerName;
        if (!old) return; // no placeholder yet — the one created later lands after the steer anyway
        markerName = undefined; // meanwhile patchNow() becomes a no-op
        if (streamed.trim()) {
          // Keep the partial reply where it is (above the steer) as a record
          // of what was being said; only a bare "Thinking…" placeholder is
          // deleted. The below-steer marker carries just the continued stream.
          console.log(`[chat] steer: kept ${streamed.length} chars of partial reply above the steer`);
        } else {
          await client.deleteMessage(old).catch(() => {});
        }
        // Reset the accumulator so the fresh marker only ever shows text
        // streamed AFTER the steer — the frozen message above already holds
        // the rest, so the live view doesn't duplicate the draft. The final
        // answer posted at the end is the complete text regardless.
        streamed = "";
        markerName = await client.createMessage(spaceName, THINKING_TEXT, threadName);
        const capped = displayText();
        if (capped) {
          try {
            await client.updateMessage(markerName, capped);
          } catch (err) {
            console.error("[chat] relocate carry-over failed:", (err as Error).message);
          }
        }
      });
      return relocateChain;
    };
    // Register so a steering message (a separate handler) can relocate this marker.
    markers.set(sessionKey, { owner, relocate: relocateMarker });

    /** Create the placeholder on demand (called by the delay timer).
     *  Not silent: the placeholder is the "work in progress" ping — it notifies
     *  so the user knows pi is working (the final answer notifies separately). */
    const ensureMarker = async (): Promise<void> => {
      if (markerName) return;
      markerName = await client.createMessage(spaceName, THINKING_TEXT, threadName);
      // A tool is already running — show its status right away.
      if (statusText) await patchNow();
    };

    const patchNow = (): Promise<void> => {
      patchChain = patchChain.then(async () => {
        patchTimer = undefined;
        // Read the LATEST text when the queued task runs, so intermediate
        // snapshots coalesce and the final patch always carries the final text.
        const capped = displayText();
        if (capped && markerName) {
          try {
            await client.updateMessage(markerName, capped);
          } catch (err) {
            console.error("[chat] patch failed:", (err as Error).message);
          }
        }
      });
      return patchChain;
    };

    /** Show the tool status after a short delay (fast tools shouldn't flicker). */
    const showTool = (toolName: string, args: unknown): void => {
      if (toolTimer) clearTimeout(toolTimer);
      const line = toolStatusLine(toolName, args);
      toolTimer = setTimeout(() => {
        toolTimer = undefined;
        statusText = line;
        void patchNow();
      }, TOOL_STATUS_DELAY_MS);
    };
    /** Clear the tool status line when the tool finishes. */
    const clearTool = (): void => {
      if (toolTimer) clearTimeout(toolTimer);
      toolTimer = undefined;
      if (statusText) {
        statusText = undefined;
        void patchNow();
      }
    };

    try {
      // Only show a placeholder if the reply is taking a while — feels like a
      // typing indicator for fast answers (no API exists for the real one).
      markerTimer = setTimeout(() => {
        ensureMarker().catch((err) => console.error("[chat] marker failed:", (err as Error).message));
      }, MARKER_DELAY_MS);

      const reply = await router.handleMessage(
        sessionKey,
        spaceName,
        text,
        (delta) => {
          streamed += delta;
          if (streamed.length > MAX_MESSAGE_CHARS) return; // stop patching past the cap
          if (!patchTimer) patchTimer = setTimeout(() => void patchNow(), PATCH_DEBOUNCE_MS);
        },
        showTool,
        clearTool,
      );

      if (patchTimer) clearTimeout(patchTimer);
      if (markerTimer) clearTimeout(markerTimer);
      if (toolTimer) clearTimeout(toolTimer);
      statusText = undefined;

      if (reply === null) {
        // Session became busy between the check and the prompt — drop the marker.
        if (markerName) await client.deleteMessage(markerName).catch(() => {});
        console.log(`[chat] ${display}: busy, deferred`);
        return "busy";
      }

      const final = reply.trim();
      if (!final) {
        if (markerName) await client.deleteMessage(markerName).catch(() => {});
        console.log(`[chat] ${display}: empty reply, marker removed`);
        return "ok";
      }

      // Show the final text (in the placeholder if one exists), then post overflow.
      streamed = final;
      // Replace the streamed placeholder with a fresh message: `markupSyntax`
      // is create-only (any text PATCH resets the message to legacy CHAT
      // syntax — verified Aug 2026), so the placeholder can't render Markdown.
      // Both the placeholder ("thinking") and this final create notify, so the
      // user knows work is ongoing and then that the answer is ready.
      if (markerName) {
        await patchNow();
        await client.deleteMessage(markerName).catch(() => {});
      }
      // The first chunk IS the answer (it notifies). Overflow chunks would
      // ideally be silent so long replies don't re-notify per 4000-char spill,
      // but NOTIFICATION_TYPE_SILENT 403s when combined with messageReplyOption
      // (threaded replies — verified Aug 2026); silent only works for top-level
      // creates, so threaded overflow posts normally.
      let rest = final;
      let first = true;
      while (rest.length > 0) {
        const silent = !first && !threadName ? { silent: true } : undefined;
        await client.sendMessage(spaceName, rest.slice(0, MAX_MESSAGE_CHARS), threadName, silent);
        rest = rest.slice(MAX_MESSAGE_CHARS);
        first = false;
      }
      console.log(`[chat] ${display}: replied (${final.length} chars)`);
      return "ok";
    } catch (err) {
      const aborted = (err as Error)?.name === "AbortError";
      console.error(`[chat] ${display}: handler ${aborted ? "interrupted (implicit stop)" : "error"}:`, (err as Error).message);
      if (markerTimer) clearTimeout(markerTimer);
      if (toolTimer) clearTimeout(toolTimer);
      if (aborted && streamed.trim()) {
        // Implicit stop: keep the partial reply visible, but replace the
        // streamed placeholder with a fresh message so it renders as Markdown.
        const partial = streamed.trim().slice(0, MAX_MESSAGE_CHARS);
        if (markerName) {
          await client.deleteMessage(markerName).catch(() => {});
          markerName = undefined;
        }
        if (partial) {
          await client.sendMessage(spaceName, partial, threadName).catch((e) =>
            console.error("[chat] final partial post failed:", (e as Error).message),
          );
        }
      } else if (markerName) {
        await client.deleteMessage(markerName).catch(() => {});
      }
      return "ok"; // ack so a poison message doesn't redeliver forever
    } finally {
      // Only the handler that owns the current marker may unregister it.
      if (markers.get(sessionKey)?.owner === owner) markers.delete(sessionKey);
    }
  };

  const receiver: MessageReceiver = new PubSubReceiver(
    config.serviceAccountPath,
    config.pubsubSubscription,
    state,
  );

  const shutdown = async (): Promise<void> => {
    console.log("[bridge] shutting down...");
    await receiver.stop();
    router.dispose();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await receiver.start(handler);
  console.log("[bridge] running. Ctrl+C to stop.");
}

main().catch((err) => {
  console.error("[bridge] fatal:", err);
  process.exit(1);
});
