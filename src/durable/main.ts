/**
 * The bridge on Pi Durable.
 *
 * A second entrypoint, not a rewrite of `index.ts`: the SDK-host bridge keeps
 * running from `dist/index.js` until the cutover, so switching engines is a
 * matter of which script the container starts, and rolling back is starting the
 * other one. Both read the same `.env`, the same Chat app and the same Pub/Sub
 * subscription — only one may run at a time (a second subscriber on the same
 * subscription steals messages rather than copying them).
 *
 *   node dist/durable/main.js
 *
 * Requirement: `BRIDGE_DB` (default `./bridge.sqlite`) is owned by this process
 * alone. pi-durable has no cross-process locking, by design.
 */
import http from "node:http";

import { AssistantEntry } from "@earendil-works/pi-durable";

import { ChatClient, collectImageAttachments } from "../chat-client.js";
import { loadConfig } from "../config.js";
import { logger } from "../logger.js";
import { PubSubReceiver } from "../pubsub-receiver.js";
import type { MessageReceiver } from "../receiver.js";
import { StateStore } from "../state.js";
import { markers, ReplyStream } from "../stream.js";
import type { IncomingMessage } from "../types.js";
import { attachViewSink } from "../adapter/view-sink.js";
import { DurableRouter } from "../adapter/router.js";
import { runDurableCommand } from "../adapter/commands.js";
import { defaultSettings } from "../adapter/commands.js";
import { BridgeHost } from "./host.js";
import { handleDurableNotify } from "./notify.js";
import { AgentRouter } from "../agent-sessions.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const dbPath = process.env.BRIDGE_DB ?? new URL("../../bridge.sqlite", import.meta.url).pathname;
  logger.info(`[bridge] engine=durable cwd=${config.cwd} db=${dbPath}`);

  const host = await BridgeHost.open({ dbPath, cwd: config.cwd });
  const client = new ChatClient(config.serviceAccountPath);
  const state = new StateStore(config.stateFile);

  const defaults = defaultSettings(host, config.cwd);
  const fallback = host.modelRuntime.getModels()[0];
  const defaultModel = defaults.provider && defaults.modelId
    ? { provider: defaults.provider, modelId: defaults.modelId }
    : fallback
      ? { provider: fallback.provider, modelId: fallback.id }
      : undefined;
  if (!defaultModel) {
    logger.error("[bridge] no model configured — set a default in ~/.pi/agent/settings.json");
    process.exit(1);
  }
  const router = new DurableRouter(host, {
    model: defaultModel,
    ...(defaults.thinkingLevel ? { thinkingLevel: defaults.thinkingLevel as never } : {}),
  });
  logger.info(`[bridge] default model ${defaultModel.provider}/${defaultModel.modelId}`);

  // --- Health + /notify, the same surface the SDK host exposes. ---
  if (config.healthPort > 0) {
    const server = http.createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? "/", "http://localhost");
        try {
          if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/")) {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("ok");
            return;
          }
          if (req.method === "POST" && url.pathname === "/notify") {
            const body = await readBody(req, 1_000_000);
            if (body === null) {
              res.writeHead(413, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: false, error: "request body too large" }));
              return;
            }
            let json: unknown;
            try {
              json = JSON.parse(body);
            } catch {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: false, error: "invalid JSON body" }));
              return;
            }
            const result = await handleDurableNotify(
              {
                client,
                host,
                router,
                notifyToken: config.notifyToken || undefined,
                defaultAgent: { model: defaultModel },
              },
              json,
              req.headers.authorization,
            );
            res.writeHead(result.status, { "Content-Type": "application/json" });
            res.end(JSON.stringify(result.json));
            return;
          }
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "not found" }));
        } catch (error) {
          logger.error("[bridge] http handler failed:", (error as Error).message);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: (error as Error).message }));
          }
        }
      })();
    });
    server.listen(config.healthPort, () => logger.info(`[bridge] health + notify on :${config.healthPort}`));
  }

  // --- One Chat message → one durable submission → one Chat reply. ---
  const handler = async (incoming: IncomingMessage): Promise<import("../receiver.js").HandleResult> => {
    const spaceName = incoming.space.name ?? "";
    const display = incoming.space.displayName ?? spaceName;
    const text = incoming.message.text ?? "";
    const threadName = incoming.message.threadName;
    const threadKey = incoming.message.threadKey;
    // keyFor() is unchanged from the SDK host: threadKey wins, then the thread
    // name, then the space — so a thread stays one conversation across engines.
    const chatKey = AgentRouter.keyFor(spaceName, threadName, threadKey);
    const actionKey = incoming.action?.parameters?.find((p) => p.key === "session")?.value ?? chatKey;

    logger.info(
      `[chat] ${display} [${incoming.message.name ?? "?"}]: ${incoming.eventType === "CARD_CLICKED" ? `card:${incoming.action?.actionMethodName}` : text.slice(0, 120)}`,
    );
    if (incoming.eventType === "CARD_CLICKED") {
      // The one event shape the bridge cannot control: Chat often omits the
      // thread on a card click, which collapses `chatKey` to the space and makes
      // the card's own `session` parameter the only reliable hint. Logged so a
      // keying bug can be diagnosed from the log instead of inferred from
      // behaviour.
      logger.info(
        `[chat] ${display}: card keying thread=${threadName ?? "(none)"} threadKey=${threadKey ?? "(none)"} chatKey=${chatKey} actionKey=${actionKey}${actionKey === chatKey ? "" : " (differ)"}`,
      );
    }

    const handled = await runDurableCommand({
      client,
      host,
      router,
      state,
      incoming,
      chatKey,
      actionKey,
      spaceName,
      threadName,
      display,
      text,
    });
    if (handled !== null) return handled;

    const { images, hadAttachments } = await collectImageAttachments(client, incoming);
    if (images.length === 0 && !text.trim()) {
      await client
        .sendMessage(spaceName, "I got your message but couldn't read the attachment — only images are supported.", threadName)
        .catch((error) => logger.error("[chat] attachment notice failed:", (error as Error).message));
      return "ok";
    }
    if (images.length) {
      logger.info(`[chat] ${display}: ${images.length} image(s) attached${text ? ` with text "${text.slice(0, 60)}"` : ""}`);
    } else if (hadAttachments) {
      logger.info(`[chat] ${display}: attachments present but no image could be downloaded`);
    }

    const stream = new ReplyStream(client, spaceName, threadName, display, {
      replaceOnFinish: config.replaceOnFinish,
    });
    stream.register(chatKey);

    let sink: Awaited<ReturnType<typeof attachViewSink>> | undefined;
    try {
      // The delivery is idempotent on the Chat message name, so a Pub/Sub
      // redelivery after a crash finds the same submission instead of asking the
      // model again.
      const { bound, submission } = await router.deliver({
        chatKey,
        messageName: incoming.message.name,
        text,
        images,
      });

      // Attach the sink *before* waiting: the answer may already be streaming.
      sink = await attachViewSink({ conversation: bound.conversation, context: host.context, stream });

      const settled = await submission.wait(host.context);
      await sink.detach();
      sink = undefined;

      const answerId = settled.status === "done" ? settled.answer : undefined;
      const answer = answerId === undefined
        ? undefined
        : await bound.conversation.commit((tx) => tx.entry(AssistantEntry, answerId), host.context);
      const final = ((answer?.model?.[0] as { content?: readonly { type?: string; text?: string }[] } | undefined)?.content ?? [])
        .flatMap((block) => (block.type === "text" && block.text ? [block.text] : []))
        .join("")
        .trim();

      if (!final) {
        await stream.abandon();
        await client
          .sendMessage(
            spaceName,
            settled.status === "done"
              ? "The model returned no text — check the bridge log, or switch models with **/model**."
              : `That turn did not finish (${settled.status}). The conversation is intact — send it again.`,
            threadName,
          )
          .catch((error) => logger.error("[chat] empty-reply notice failed:", (error as Error).message));
        logger.info(`[chat] ${display}: no answer text (${settled.status})`);
        return "ok";
      }

      await stream.finish(final);
      return "ok";
    } catch (error) {
      const aborted = (error as Error)?.name === "AbortError";
      logger.error(`[chat] ${display}: handler ${aborted ? "interrupted" : "error"}:`, (error as Error).message);
      await stream.onError(aborted);
      return "ok";
    } finally {
      await sink?.detach().catch(() => {});
      stream.unregister(chatKey);
      markers.delete(chatKey);
    }
  };

  const receiver: MessageReceiver = new PubSubReceiver(
    config.serviceAccountPath,
    config.pubsubSubscription,
    state,
    config.allowedSpaces,
    config.allowedUsers,
  );

  const shutdown = async (): Promise<void> => {
    logger.info("[bridge] shutting down...");
    await receiver.stop();
    // Closing the harness waits for running task code to return and leaves the
    // store consistent; anything unfinished resumes on the next start.
    await host.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await receiver.start(handler);
  logger.info("[bridge] running on the durable engine. Ctrl+C to stop.");
}

main().catch((error) => {
  logger.error("[bridge] fatal:", error);
  process.exit(1);
});

/** Read a request body up to `maxBytes`; returns null when the cap is exceeded. */
function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > maxBytes) {
        done = true;
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (error) => {
      if (done) return;
      done = true;
      reject(error);
    });
  });
}
