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
/** Card action method for the session picker dropdown. */
const RESUME_ACTION = "resume_session";
/** Card action method for the model picker dropdown. */
const MODEL_ACTION = "switch_model";

/**
 * Live streaming markers per conversation: the running turn's handler registers
 * its placeholder here so a steering message (a separate handler invocation)
 * can relocate the placeholder BELOW the steering message. Google Chat orders
 * thread messages by creation time, so without relocation the reply — which
 * now covers the steer — would render above the steering text. Entries are
 * removed when the owning handler finishes.
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
            ? `This conversation's session is named: <b>${escapeHtml(current)}</b>`
            : "This conversation has no session name yet. Use <b>/name &lt;name&gt;</b> to set one.",
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
      await client.sendMessage(spaceName, `Session named: <b>${escapeHtml(arg)}</b>`, threadName);
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
    /** Serialized placeholder updates: only one PATCH in flight at a time, applied in
     *  order, so a stale snapshot can never land after the final text (an out-of-order
     *  PATCH race could otherwise permanently truncate the stored message). */
    let patchChain: Promise<void> = Promise.resolve();
    /** Serialized placeholder relocations (a steer moves the streaming reply
     *  below the steering message; see `relocateMarker`). */
    let relocateChain: Promise<void> = Promise.resolve();
    /** Identity token so a stale handler can't unregister a newer one's marker. */
    const owner = {};

    /**
     * Move the streaming placeholder below a steering message: delete the old
     * one (created before the steer, so it renders ABOVE the steer text) and
     * create a fresh one carrying the streamed text so far. Google Chat orders
     * thread messages by creation time, so without this the reply to a
     * steered-in message would appear before the steering message itself.
     */
    const relocateMarker = (): Promise<void> => {
      relocateChain = relocateChain.then(async () => {
        await patchChain; // settle queued patches before deleting the old marker
        const old = markerName;
        if (!old) return; // no placeholder yet — the one created later lands after the steer anyway
        markerName = undefined; // meanwhile patchNow() becomes a no-op
        await client.deleteMessage(old).catch(() => {});
        markerName = await client.createMessage(spaceName, THINKING_TEXT, threadName);
        const capped = streamed.slice(0, MAX_MESSAGE_CHARS);
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

    /** Create the placeholder on demand (called by the delay timer). */
    const ensureMarker = async (): Promise<void> => {
      if (markerName) return;
      markerName = await client.createMessage(spaceName, THINKING_TEXT, threadName);
    };

    const patchNow = (): Promise<void> => {
      patchChain = patchChain.then(async () => {
        patchTimer = undefined;
        // Read the LATEST text when the queued task runs, so intermediate
        // snapshots coalesce and the final patch always carries the final text.
        const capped = streamed.slice(0, MAX_MESSAGE_CHARS);
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

    try {
      // Only show a placeholder if the reply is taking a while — feels like a
      // typing indicator for fast answers (no API exists for the real one).
      markerTimer = setTimeout(() => {
        ensureMarker().catch((err) => console.error("[chat] marker failed:", (err as Error).message));
      }, MARKER_DELAY_MS);

      const reply = await router.handleMessage(sessionKey, spaceName, text, (delta) => {
        streamed += delta;
        if (streamed.length > MAX_MESSAGE_CHARS) return; // stop patching past the cap
        if (!patchTimer) patchTimer = setTimeout(() => void patchNow(), PATCH_DEBOUNCE_MS);
      });

      if (patchTimer) clearTimeout(patchTimer);
      if (markerTimer) clearTimeout(markerTimer);

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
      if (markerName) {
        await patchNow();
        let rest = final.slice(MAX_MESSAGE_CHARS);
        while (rest.length > 0) {
          await client.sendMessage(spaceName, rest.slice(0, MAX_MESSAGE_CHARS), threadName);
          rest = rest.slice(MAX_MESSAGE_CHARS);
        }
      } else {
        // No placeholder was needed — post the reply directly, split if long.
        let rest = final;
        while (rest.length > 0) {
          await client.sendMessage(spaceName, rest.slice(0, MAX_MESSAGE_CHARS), threadName);
          rest = rest.slice(MAX_MESSAGE_CHARS);
        }
      }
      console.log(`[chat] ${display}: replied (${final.length} chars)`);
      return "ok";
    } catch (err) {
      const aborted = (err as Error)?.name === "AbortError";
      console.error(`[chat] ${display}: handler ${aborted ? "interrupted (implicit stop)" : "error"}:`, (err as Error).message);
      if (markerTimer) clearTimeout(markerTimer);
      if (aborted && streamed.trim()) {
        // Implicit stop: keep the partial reply visible in the placeholder.
        await patchNow().catch((e) => console.error("[chat] final partial patch failed:", (e as Error).message));
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
