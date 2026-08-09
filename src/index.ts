import http from "node:http";

import { AgentRouter } from "./agent-sessions.js";
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
    console.log(`[chat] ${display}: ${text.slice(0, 120)}`);

    if (router.isBusy(spaceName)) {
      console.log(`[chat] ${display}: busy, deferring`);
      return "busy";
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

      const reply = await router.handleMessage(spaceName, text, (delta) => {
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
