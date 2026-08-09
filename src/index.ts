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

function confirmCard(label: string): unknown[] {
  const safe = label.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
  console.log(`[bridge] cwd=${config.cwd} pull=${config.pullIntervalMs}ms`);

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
  const router = await AgentRouter.create(config.cwd, config.sessionsDir);

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
    // Conversations are keyed per thread, so parallel threads never block
    // each other (space is the fallback for non-threaded DMs).
    const sessionKey = AgentRouter.keyFor(spaceName, threadName);
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

    if (router.isBusy(sessionKey)) {
      console.log(`[chat] ${display}: busy, deferring`);
      return "busy";
    }

    // --- Built-in commands (handled by the bridge, not sent to pi) ---
    if (/^\/model\b/.test(text.trim())) {
      const models = router.listModels();
      if (models.length === 0) {
        await client.sendMessage(spaceName, "No models configured.", threadName);
        return "ok";
      }
      await client.createCardMessage(spaceName, modelPickerCard(models), "Choose a backend model.", threadName);
      console.log(`[chat] ${display}: posted model picker (${models.length} models)`);
      return "ok";
    }
    if (/^\/help\b/.test(text.trim())) {
      await client.createCardMessage(spaceName, helpCard(), "Available commands: /resume, /sessions, /list, /help.", threadName);
      console.log(`[chat] ${display}: posted help card`);
      return "ok";
    }
    if (/^\/(resume|sessions|list)\b/.test(text.trim())) {
      const sessions = await router.listSessions();
      if (sessions.length === 0) {
        await client.sendMessage(spaceName, "No sessions found yet.", threadName);
        return "ok";
      }
      await client.createCardMessage(spaceName, pickerCard(sessions), "Choose a session to resume.", threadName);
      console.log(`[chat] ${display}: posted session picker (${sessions.length} sessions)`);
      return "ok";
    }

    let markerName: string | undefined;
    let markerTimer: NodeJS.Timeout | undefined;
    let streamed = "";
    let patchTimer: NodeJS.Timeout | undefined;

    /** Create the placeholder on demand (called by the delay timer). */
    const ensureMarker = async (): Promise<void> => {
      if (markerName) return;
      markerName = await client.createMessage(spaceName, THINKING_TEXT, threadName);
    };

    const patchNow = async (): Promise<void> => {
      patchTimer = undefined;
      const capped = streamed.slice(0, MAX_MESSAGE_CHARS);
      if (capped && markerName) {
        try {
          await client.updateMessage(markerName, capped);
        } catch (err) {
          console.error("[chat] patch failed:", (err as Error).message);
        }
      }
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
      console.error(`[chat] ${display}: handler error:`, (err as Error).message);
      if (markerTimer) clearTimeout(markerTimer);
      if (markerName) {
        await client.deleteMessage(markerName).catch(() => {});
      }
      return "ok"; // ack so a poison message doesn't redeliver forever
    }
  };

  const receiver: MessageReceiver = new PubSubReceiver(
    config.serviceAccountPath,
    config.pubsubSubscription,
    state,
    config.pullIntervalMs,
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
