/**
 * The Chat adapter, in its own process.
 *
 * Forked by the session host when `BRIDGE_CHAT_ENGINE=process`, connected over a Node IPC channel
 * carrying a chord link. This process holds the Chat credentials, the Pub/Sub receiver, the delivery
 * cursor, the painter and the command layer; it holds **no store**. Everything it knows about a
 * conversation comes through `SessionHost`, which is the same interface the in-process engine used —
 * so the extraction is a deployment change, not a rewrite.
 *
 * What that buys, concretely: restarting this process cannot interrupt a turn, because the turn is
 * the host's. Before this, a deploy of the bridge killed whatever the agent was doing.
 *
 * Two things to know, both learned the hard way:
 *
 *   - **stdout is the only safe channel.** The IPC channel belongs to chord, and a second writer on
 *     `process.send` is parsed as link frames.
 *   - **`/notify` lives here now.** It needs the Chat client, so it cannot stay on a host that is
 *     meant to hold no Chat credentials. Whatever calls it needs this port, not `PORT`.
 */
import http from "node:http";

import { createHost, ipcLink } from "@earendil-works/chord";

import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { ChatClient } from "./chat-client.js";
import { StateStore } from "./state.js";
import { SecretStore } from "./secret-store.js";
import { PubSubReceiver } from "./pubsub-receiver.js";
import { DurableRouter } from "./adapter/router.js";
import { defaultSettings } from "./adapter/commands.js";
import { identify } from "./durable/identity.js";
import { chatHandler } from "./durable/chat-handler.js";
import { startChatPainter } from "./durable/chat-painter.js";
import { handleDurableNotify } from "./durable/notify.js";
import { nameUntitledConversations } from "./durable/naming.js";
import { readBody } from "./adapter/web-routes.js";
import { linkSessionHost } from "./session-host/link.js";

const port = Number(process.env.BRIDGE_CHAT_PORT ?? 0);
const bind = process.env.BRIDGE_BIND ?? "127.0.0.1";
const config = loadConfig();
/**
 * Where the store lives — not to open it, but because two files sit beside it and belong to this
 * side: the delivery cursor (`bridge-ledger.json`) and the secrets file. The adapter must never open
 * the database; these two paths are the only reason it knows the directory.
 */
const dbPath = process.env.BRIDGE_DB ?? new URL("../bridge.sqlite", import.meta.url).pathname;

if (!port) {
  logger.error("[chat-host] BRIDGE_CHAT_PORT is not set — nothing to serve");
  process.exit(2);
}

const client = createHost({
  self: "chat-adapter",
  name: "chat-adapter",
  kind: "client",
  upstream: {
    link: ipcLink(process as unknown as Parameters<typeof ipcLink>[0]),
    principal: "session-host",
  },
});
const seam = linkSessionHost({ host: client });

const chat = new ChatClient(config.serviceAccountPath);
const state = new StateStore(config.stateFile);
const secrets = new SecretStore(SecretStore.defaultPath(dbPath));

/** The default model for a conversation this adapter creates; the host owns the setting. */
async function defaultModel(): Promise<{ provider: string; modelId: string }> {
  const defaults = await defaultSettings(seam);
  if (defaults.provider && defaults.modelId) {
    return { provider: defaults.provider, modelId: defaults.modelId };
  }
  const [fallback] = await seam.models();
  if (!fallback) {
    logger.error("[chat-host] no model configured — set a default in ~/.pi/agent/settings.json");
    process.exit(1);
  }
  return { provider: fallback.provider, modelId: fallback.id };
}

const model = await defaultModel();
const router = new DurableRouter(seam, {
  model,
  ...(await defaultSettings(seam)).thinkingLevel
    ? { thinkingLevel: (await defaultSettings(seam)).thinkingLevel as never }
    : {},
});
logger.info(`[chat-host] default model ${model.provider}/${model.modelId}`);

const painter = await startChatPainter({ seam, config, client: chat, dbPath });
const handler = chatHandler({ seam, config, client: chat, router, state, secrets });

const server = http.createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/idle")) {
        // This process's own liveness, not the store's: `/idle` here would be a lie about what is
        // running, which is the host's question. A restart supervisor asks this adapter whether the
        // adapter is up; `/idle` on the host stays where it was.
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
        return;
      }
      if (req.method === "POST" && url.pathname === "/notify") {
        // The cron side's single write path into Chat. It moved with the adapter because it needs a
        // Chat client, and the host is not supposed to have one.
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
            client: chat,
            seam,
            router,
            notifyToken: config.notifyToken || undefined,
            defaultAgent: { model },
          },
          json,
          req.headers.authorization,
        );
        res.writeHead(result.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result.json));
        return;
      }
      const who = identify(req, config.trustedProxy);
      logger.info(`[chat-host] ${req.method} ${url.pathname} from ${who.email ?? "anonymous"}`);
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "not found" }));
    } catch (error) {
      logger.error("[chat-host] request failed:", (error as Error).message);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: (error as Error).message }));
      }
    }
  })();
});

const receiver =
  process.env.RECEIVER === "none"
    ? undefined
    : new PubSubReceiver(
        config.serviceAccountPath,
        config.pubsubSubscription,
        state,
        config.allowedSpaces,
        config.allowedUsers,
      );

server.listen(port, bind, () => {
  // stdout, never `process.send`: the IPC channel is the link (see the header).
  process.stdout.write(`CHAT_ADAPTER_LISTENING ${bind}:${port}\n`);
  logger.info(`[chat-host] serving Chat and /notify on ${bind}:${port} over the session host link`);
});

if (receiver) {
  await receiver.start(handler);
  logger.info("[chat-host] listening for Chat events");
} else {
  logger.info("[chat-host] RECEIVER=none: no Pub/Sub, so no Chat messages will arrive");
}

// Name whatever has no title yet, in the background — the same pass the host used to run, moved
// with the titler because it is a Chat card that the title is displayed on.
if (config.topicSummary) {
  void nameUntitledConversations({
    seam,
    config: {
      baseUrl: config.topicSummaryBaseUrl,
      model: config.topicSummaryModel,
      timeoutMs: config.topicSummaryTimeoutMs,
      ...(config.topicSummaryApiKey ? { apiKey: config.topicSummaryApiKey } : {}),
    },
    intervalMs: 5_000,
    maxPerPass: 10,
  }).then(
    (count) => logger.info(`[naming] pass finished: ${count} conversation(s) named`),
    (error: unknown) => logger.error(`[naming] pass failed: ${(error as Error).message}`),
  );
}

const shutdown = (): void => {
  painter.stop();
  void receiver?.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
