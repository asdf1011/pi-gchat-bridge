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
import { BridgeLockedError } from "./lock.js";
import { handleDurableNotify } from "./notify.js";
import { attachWebClient, webIndex, webSubmit, WEB_PAGE } from "../adapter/web.js";
import { applyDurableTopicSummary } from "./topic.js";
import { identify } from "./identity.js";
import { failureNotice } from "./failure-notice.js";
import { claimAnswer, releaseAnswer } from "./posted-doc.js";
import { AgentRouter } from "../agent-sessions.js";
import { SecretStore } from "../secret-store.js";

/**
 * Exit code for "another process owns the bridge database".
 *
 * Distinct from 1 so the supervisor can tell a refused start from a crash. A
 * crash should restart immediately; a lock conflict means the process holding
 * the database is already serving, so restarting is pointless and the retry
 * loop just buries the real error under identical log lines.
 */
const EXIT_DB_LOCKED = 75;

async function main(): Promise<void> {
  const config = loadConfig();
  const dbPath = process.env.BRIDGE_DB ?? new URL("../../bridge.sqlite", import.meta.url).pathname;
  logger.info(`[bridge] engine=durable cwd=${config.cwd} db=${dbPath}`);

  // One store per process, next to the database rather than in PI_CWD: the
  // agent's tools run in PI_CWD, and a secrets file there is one `cat` away
  // from a tool result. The host reads it at startup to seed the redaction
  // registry; the /secret command writes it.
  const secrets = new SecretStore(SecretStore.defaultPath(dbPath));

  const host = await BridgeHost.open({ dbPath, cwd: config.cwd, secrets }).catch((error: unknown) => {
    if (error instanceof BridgeLockedError) {
      // Not a crash: the owner is serving Chat right now. Exiting non-zero-and-
      // distinct lets the supervisor stop retrying instead of looping forever.
      logger.error(`[bridge] refusing to start: ${error.message}`);
      process.exit(EXIT_DB_LOCKED);
    }
    throw error;
  });
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
        // Resolved once per request. The header is only believed when the socket
        // peer is the configured proxy, so it cannot be forged by anything that
        // can merely reach the port.
        const who = identify(req, config.trustedProxy);
        if (who.untrustedHeader) {
          logger.warn(`[web] identity header from untrusted peer ${req.socket.remoteAddress} — ignored`);
        }
        try {
          if (req.method === "GET" && url.pathname === "/healthz") {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("ok");
            return;
          }
          // A proxy that mounts us at /pi/ and strips the prefix asks for "/".
          // Serve the app there, because a browser following a bookmark to the
          // mount root should land on the app, not on a bare "ok". Health checks
          // use /healthz, so nothing is lost. A HEAD probe gets the page's
          // headers too, which is how some proxies smoke-test an upstream.
          if (req.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(WEB_PAGE);
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
          // --- Web frontend: a second sink on the same conversations. ---
          //
          // Mount-agnostic on purpose. A reverse proxy may hand us "/pi/web"
          // (prefix passed through) or "/web" (prefix stripped), and the HTML
          // cannot know which -- so routes strip an optional prefix and the page
          // uses relative URLs throughout. That makes both proxy styles work
          // without a build-time or config-time base path.
          if (req.method === "GET" && (webPath(url.pathname) === "/web" || webPath(url.pathname) === "/web/")) {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(WEB_PAGE);
            return;
          }
          if (req.method === "GET" && webPath(url.pathname) === "/web/api/conversations") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(await webIndex(host)));
            return;
          }
          const events = /^\/web\/api\/c\/(\d+)\/events$/.exec(webPath(url.pathname));
          if (req.method === "GET" && events) {
            const conversationId = Number(events[1]);
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              // No CORS: the page is served from this origin only.
            });
            let alive = true;
            const client = {
              open: alive,
              send(event: string, data: unknown) {
                if (!alive) return;
                try {
                  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
                } catch {
                  alive = false;
                }
              },
            };
            const handle = await attachWebClient(
              { host, model: defaultModel, ...(config.webToken ? { token: config.webToken } : {}) },
              conversationId,
              client,
            );
            // A comment line keeps proxies from closing an idle stream.
            const keepalive = setInterval(() => {
              if (!alive) return;
              try {
                res.write(": keepalive\n\n");
              } catch {
                alive = false;
              }
            }, 15_000);
            req.on("close", () => {
              alive = false;
              clearInterval(keepalive);
              handle.close();
            });
            return;
          }
          const send = /^\/web\/api\/c\/(\d+)\/message$/.exec(webPath(url.pathname));
          if (req.method === "POST" && send) {
            if (config.webToken && req.headers.authorization !== `Bearer ${config.webToken}`) {
              res.writeHead(401, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
              return;
            }
            const body = await readBody(req, 200_000);
            if (body === null) {
              res.writeHead(413, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: false, error: "request body too large" }));
              return;
            }
            let text = "";
            try {
              const parsed = JSON.parse(body) as { text?: unknown };
              text = typeof parsed.text === "string" ? parsed.text : "";
            } catch {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: false, error: "invalid JSON body" }));
              return;
            }
            const result = await webSubmit(
              { host, model: defaultModel, ...(config.webToken ? { token: config.webToken } : {}) },
              Number(send[1]),
              text,
            );
            if (result.ok) {
              // Who asked, and which conversation: this bridge can run shell
              // commands, so "who submitted this" belongs in the log.
              logger.info(
                `[web] ${who.email ?? "anonymous"}: submitted to conversation ${send[1]} (submission ${result.submissionId})`,
              );
            }
            res.writeHead(result.ok ? 202 : 400, { "Content-Type": "application/json" });
            res.end(JSON.stringify(result));
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
    server.listen(config.healthPort, config.bindAddress, () => {
      const where = `${config.bindAddress}:${config.healthPort}`;
      logger.info(`[bridge] health + notify + web on ${where}`);
      if (config.bindAddress === "0.0.0.0" || config.bindAddress === "::") {
        logger.warn(
          "[bridge] BRIDGE_BIND is all interfaces: anything that can reach this port can submit as the bot. " +
            "Bind 127.0.0.1 and put the tunnel or proxy in front.",
        );
      }
      if (config.trustedProxy) logger.info(`[bridge] identity headers trusted from ${config.trustedProxy}`);
    });
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
    // Keying is logged for EVERY event, not just card clicks: in a space the
    // difference between a top-level message (keyed by the space) and a reply in
    // a thread (keyed by the thread) is the intended model, but it is also the
    // one thing that looks like "the bot answered in the wrong conversation".
    // Having both keys in the log turns that from a guess into a lookup.
    logger.info(
      `[chat] ${display}: keying ${incoming.eventType ?? "MESSAGE"} thread=${threadName ?? "(none)"} threadKey=${threadKey ?? "(none)"} chatKey=${chatKey} actionKey=${actionKey}${actionKey === chatKey ? "" : " (differ)"}`,
    );

    const handled = await runDurableCommand({
      client,
      host,
      router,
      state,
      secrets,
      // Falls back to ALLOWED_USERS when SECRET_USERS is unset, so a single-user
      // deployment needs no extra configuration.
      secretUsers: config.secretUsers.length > 0 ? config.secretUsers : config.allowedUsers,
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

      const turnStarted = Date.now();
      const settled = await submission.wait(host.context);
      const turnMs = Date.now() - turnStarted;
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
        // A failure here used to log only the status, so "unanswered after 9s"
        // and "unanswered after 154s" were indistinguishable, and the reason
        // pi-durable records (aborted / provider error / ...) was thrown away.
        // Diagnosing a real failure from that took twenty minutes of log
        // archaeology; these four facts make it a single line.
        const reason = settled.status === "unanswered" ? settled.reason : undefined;
        const detail = settled.status === "unanswered" ? settled.detail : undefined;
        logger.info(
          `[chat] ${display}: no answer text status=${settled.status}` +
            `${reason ? ` reason=${reason}` : ""}` +
            ` after ${turnMs}ms conversation=${bound.binding.conversationId}` +
            (detail === undefined ? "" : ` detail=${JSON.stringify(detail).slice(0, 300)}`),
        );
        await stream.abandon();
        await client
          .sendMessage(spaceName, failureNotice(settled.status, reason, turnMs), threadName)
          .catch((error) => logger.error("[chat] empty-reply notice failed:", (error as Error).message));
        return "ok";
      }

      // One answer, one Chat message. A single run can answer several Chat
      // messages — a message that arrives mid-run is a steer and joins the run,
      // and messages queued behind a stuck tool are all answered when it
      // finishes. Every one of those submissions settles with the SAME answer
      // entry, so posting here per submission is what produced the duplicate
      // replies (four queued messages → four identical 2533-char posts).
      //
      // The claim is on the answer, not on the message: `requestId` dedupe is
      // already correct and cannot see this, because those really are different
      // Chat messages. It is durable, so a redelivery after a crash (posted,
      // then died before acking) does not post the same answer twice either.
      const answerKey = Number(answerId);
      if (!(await claimAnswer(host, chatKey, answerKey))) {
        logger.info(
          `[chat] ${display}: answer ${answerKey} already delivered in this thread — not posting it again ` +
            `(conversation=${bound.binding.conversationId})`,
        );
        await stream.abandon();
        return "ok";
      }
      try {
        await stream.finish(final);
      } catch (error) {
        // The reply was not delivered after all: hand the claim back so another
        // handler for this answer (or a Pub/Sub redelivery) still delivers it.
        // Losing a reply is worse than posting one twice.
        await releaseAnswer(host, chatKey, answerKey).catch(() => {});
        throw error;
      }

      // Detached: a CPU titler can take minutes, and the reply is already
      // delivered. Only fires when /model left a pending card for this thread,
      // so it is free to call on every turn.
      if (config.topicSummary) {
        void applyDurableTopicSummary({
          state,
          host,
          client,
          chatKey,
          display,
          config: {
            baseUrl: config.topicSummaryBaseUrl,
            model: config.topicSummaryModel,
            timeoutMs: config.topicSummaryTimeoutMs,
          },
        });
      }
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

/**
 * Strip a reverse proxy's mount prefix, so route matching is independent of
 * whether the proxy passes "/pi/web/..." or rewrites it to "/web/...".
 *
 * Only leading segments before "/web" are removed, so a conversation id or any
 * other late path component is never touched.
 */
function webPath(pathname: string): string {
  const at = pathname.indexOf("/web");
  return at > 0 ? pathname.slice(at) : pathname;
}

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
