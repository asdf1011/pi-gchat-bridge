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
import path from "node:path";


import { ChatClient, collectImageAttachments } from "../chat-client.js";
import { fork } from "node:child_process";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";
import { logger } from "../logger.js";
import { PubSubReceiver } from "../pubsub-receiver.js";
import type { MessageReceiver } from "../receiver.js";
import { StateStore } from "../state.js";
import { ReplyStream } from "../stream.js";
import type { IncomingMessage } from "../types.js";
import { createHost, memoryLinkPair } from "@earendil-works/chord";
import { attachViewSink, viewFramePainter } from "../adapter/view-sink.js";
import { DurableRouter } from "../adapter/router.js";
import { runDurableCommand } from "../adapter/commands.js";
import { defaultSettings } from "../adapter/commands.js";
import { ActivityFeed } from "./activity.js";
import { startChatPainter } from "./chat-painter.js";
import { chatHandler } from "./chat-handler.js";
import { httpPoll } from "../adapter/poll-client.js";
import { entriesAfter } from "./entries.js";
import type { ProjectedView } from "../session-host/projection.js";
import { chatTarget } from "../session-key.js";
import { splitMessage } from "../stream.js";
import { Ledger } from "./ledger.js";
import { BridgeHost } from "./host.js";
import { BridgeLockedError } from "./lock.js";
import { handleDurableNotify } from "./notify.js";
import { handleV1 } from "../adapter/v1-routes.js";
import { handleWebRequest, readBody } from "../adapter/web-routes.js";
import { startArtifactsServer } from "../adapter/artifacts-server.js";
import { artifactRoots } from "./artifacts.js";
import { initArtifactRepo } from "./artifact-vcs.js";
import { inProcessSessionHost } from "../session-host/inprocess.js";
import { linkSessionHost, serveSessionHost } from "../session-host/link.js";
import type { SessionHost } from "../session-host/api.js";
import { supervise, type Supervisor } from "../session-host/supervisor.js";
import { ipcLink } from "@earendil-works/chord";
import { SecretRegistry } from "./extensions/redact.js";
import { secretsFromEnvironment } from "./extensions/secret-redactor.js";
import { applyDurableTopicSummary } from "./topic.js";
import { nameUntitledConversations } from "./naming.js";
import { identify } from "./identity.js";
import { failureNotice } from "./failure-notice.js";
import { AgentRouter } from "../agent-sessions.js";
import { NullReceiver } from "../receiver.js";
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

  const host = await BridgeHost.open({
    dbPath,
    cwd: config.cwd,
    secrets,
    artifactsDir: config.artifactsDir,
  }).catch((error: unknown) => {
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

  // --- The seam, and which side of the boundary is asking. ---
  //
  // Two names for one object today, which is the point: the host's own uses (`/v1`, the artifact
  // origin, `/idle`, the web routes when they are served here) and the Chat adapter's (the router,
  // the handler, notify, the titler, the painter) are different things that happen to share a
  // process. Naming them apart is what makes "give the Chat adapter a link instead" a one-line
  // change rather than a hunt through twenty call sites, and what keeps a host route from being
  // accidentally sent through a fork.
  //
  // The artifact roots are decided host-side because deriving artifacts is the host's job: a viewer
  // asks for a list, it does not walk the transcript and filter paths itself.
  /**
   * Show a turn that started on another surface in the Chat side of the
   * conversation (see `durable/mirror.ts` for the shape and the API 403 behind
   * it). Chat is the surface that would otherwise be missing those turns, and a
   * conversation that only half appears in one client is not much use.
   */
  // The server's own account of what it is doing. Subscribers are connections (§17), and the
  // per-turn watching is one attachment per running turn — not per reader. Late-bound because
  // the seam is built below, and this object is only used once requests start arriving.
  const activity = new ActivityFeed({ seam: { attach: (id, frame) => hostSeam.attach(id, frame) } });

  // Created lazily, on the first turn of a conversation, rather than up front:
  // most conversations never write an artifact, and an empty repository per
  // conversation is a directory tree nobody asked for. `initArtifactRepo` is
  // idempotent, so a repeated turn pays one `jj root` and nothing else.
  const artifactRepos = new Set<string>();
  const artifactRepoFor = config.artifactsDir === ""
    ? undefined
    : (conversationId: number): string | undefined => {
        const dir = path.join(config.artifactsDir, "conversation", String(conversationId));
        if (!artifactRepos.has(dir)) {
          artifactRepos.add(dir);
          // Fire and forget: the first turn of a conversation should not wait on
          // a repository being created, and a failure here leaves the mtime walk
          // as the only witness, which is the status quo rather than a breakage.
          void initArtifactRepo(dir).catch((error) =>
            logger.warn(`[artifacts] no repo at ${dir}: ${String(error)}`),
          );
        }
        return dir;
      };

  if (config.artifactsDir !== "") {
    logger.info(`[artifacts] tracking ${config.artifactsDir}/conversation/<id>`);
  }

  const hostSeam = inProcessSessionHost({
    host,
    roots: config.artifactsDir === ""
      ? artifactRoots(config.cwd, getAgentDir())
      : // The artifact root has to include the tracked directory, or files
        // written there are unservable and the comment feature has nothing to
        // point at.
        artifactRoots(config.cwd, getAgentDir(), [config.artifactsDir]),
    artifactRepoFor,
    // A steer is placed at the round's boundary, so a tool that never returns holds
    // it forever. This is the cap the SDK bridge had as `redirect()`; see
    // `durable/steer-watch.ts`. `BRIDGE_STEER_WAIT_MS`, 10s unless set.
    steerWaitMs: config.steerWaitMs,
    onObserveError: (error) => logger.warn(`[artifacts] observation failed: ${String(error)}`),
  });

  // The Chat adapter's view of the seam.
  //
  // `BRIDGE_CHAT_ENGINE=link` gives it a *linked* seam in this same process: two chord objects, a
  // memory pair between them, and the adapter reaching the host the way it will when it is finally
  // forked. That is the extraction with the fork left out, and it is worth the round trip: an
  // operation the adapter needs but the link does not publish fails here, in a log line, instead of
  // at the moment a second process starts and Chat goes quiet.
  const chatEngine = process.env.BRIDGE_CHAT_ENGINE ?? "inprocess";
  let chatSeam: SessionHost = hostSeam;
  // `serveSessionHost` opens no socket: it is a chord host, and a deployment that never links pays
  // nothing but an object.
  const objectHost = serveSessionHost(hostSeam);
  if (chatEngine === "link") {
    const [down, up] = memoryLinkPair();
    objectHost.accept(down, { principal: "chat-adapter", kind: "client" });
    const client = createHost({
      self: "chat-adapter",
      name: "chat-adapter",
      kind: "client",
      upstream: { link: up, principal: "session-host" },
    });
    chatSeam = linkSessionHost({ host: client });
    logger.info("[bridge] chat engine=link: the Chat adapter talks to the host over a link");
  } else {
    logger.info("[bridge] chat engine=inprocess: the Chat adapter shares the host's seam");
  }

  const defaults = await defaultSettings(hostSeam);
  const [fallback] = await hostSeam.models();
  const defaultModel = defaults.provider && defaults.modelId
    ? { provider: defaults.provider, modelId: defaults.modelId }
    : fallback
      ? { provider: fallback.provider, modelId: fallback.id }
      : undefined;
  if (!defaultModel) {
    logger.error("[bridge] no model configured — set a default in ~/.pi/agent/settings.json");
    process.exit(1);
  }
  const router = new DurableRouter(chatSeam, {
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
          // /v1: the conversation protocol a second surface reads (§17). Its own module
          // so the shapes are testable without a bridge, and mounted here because this is
          // already the process that owns the store.
          if (
            await handleV1(req, res, url, {
              seam: hostSeam,
              activity,
              conversations: async () => {
                const bindings = await host.bindings();
                return Object.entries(bindings.byChatKey).map(([chatKey, binding]) => ({
                  conversationId: binding.conversationId,
                  address: chatKey,
                  ...(binding.name === undefined ? {} : { name: binding.name }),
                  lastActivityAt: binding.updatedAt ?? binding.createdAt,
                }));
              },
              ...(config.webToken ? { token: config.webToken } : {}),
            })
          ) {
            return;
          }
          if (req.method === "GET" && url.pathname === "/healthz") {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("ok");
            return;
          }
          // GET /idle: is any turn running right now?
          //
          // Exists for the restart gate. "No child processes" is not the same
          // question: an agent thinking between tool calls looks idle for a minute at
          // a time, so a gate built on process silence fires mid-turn and kills the
          // work it was trying to protect. Only conversations touched recently are
          // asked, because a dormant thread cannot be mid-turn and each answer costs a
          // view snapshot.
          if (req.method === "GET" && url.pathname === "/idle") {
            const busy: number[] = [];
            const since = Date.now() - 24 * 60 * 60 * 1000;
            try {
              const bindings = await host.bindings();
              for (const binding of Object.values(bindings.byChatKey)) {
                if ((binding.updatedAt ?? binding.createdAt) < since) continue;
                if ((await hostSeam.snapshot(binding.conversationId))?.busy === true) {
                  busy.push(binding.conversationId);
                }
              }
            } catch (error) {
              // Cannot tell is not idle: a restart that guesses would kill a turn.
              res.writeHead(503, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ idle: false, error: (error as Error).message }));
              return;
            }
            res.writeHead(busy.length === 0 ? 200 : 503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ idle: busy.length === 0, busy }));
            return;
          }
          // POST /notify: the cron service's single write path into Chat.
          //
          // This route was collateral damage in the web-routes extraction
          // (3a91b1d): the handler moved out, the /notify block was deleted with
          // the /web routes, and nothing noticed because `handleDurableNotify` is
          // still *imported* below (so `tsc` was happy) and its unit tests call the
          // handler directly rather than this server. The result was a silent
          // 404 for every scheduled notification — balance checks, release notes,
          // reminders — while `npm test` stayed green.
          //
          // The engine check is on purpose: this listener is the durable host's,
          // and only it holds a `router`/`seam` pair for the durable harness.
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
                seam: chatSeam,
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
          // The browser front end lives in one module so the same routes can be
          // served from the bridge process or from an adapter process. In link
          // mode the adapter owns them, and this process answers 404 — the tunnel
          // must point at BRIDGE_WEB_PORT, not here.
          if (
            webEngine !== "link" &&
            (await handleWebRequest(req, res, url, {
              seam: hostSeam,
              model: defaultModel,
              ...(config.webToken ? { token: config.webToken } : {}),
              ...(config.artifactsBaseUrl ? { artifactsBaseUrl: config.artifactsBaseUrl } : {}),
              // Where a comment's file lives, for the text the model receives:
              // the artifact directory is per conversation, and only this side
              // knows that.
              ...(config.artifactsDir === ""
                ? {}
                : {
                    artifactPath: (conversationId: number, file: string) =>
                      path.join(config.artifactsDir, "conversation", String(conversationId), file),
                  }),
              who,
            }))
          ) {
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

  // --- The artifact origin: a second listener, GET-only, on its own port. ---
  //
  // Separate from the server above on purpose. What is registered there is a
  // read-only route table, so no request on this port — however malformed — can
  // reach `/web/api/.../message` or any other mutating route. The tunnel maps a
  // different hostname onto this port, which is what makes the capability split
  // a fact of the deployment instead of a header check.
  //
  // Off unless `BRIDGE_ARTIFACTS_PORT` is set: a bridge that serves Chat needs no
  // artifact origin, and a listener nobody asked for is just another port to
  // wonder about.
  const artifactsPort = Number(process.env.BRIDGE_ARTIFACTS_PORT ?? 0);
  let artifactsServer: http.Server | undefined;
  if (artifactsPort > 0) {
    // Resolved per request, exactly as the harness resolves its registry per
    // call: `/secret set` must take effect in a running bridge, and this viewer
    // reads files the harness never sees, so it needs its own redaction pass.
    const redactArtifact = (text: string): string => {
      const stored = secrets.registrySecrets();
      const names = new Set(stored.map((secret) => secret.name));
      return new SecretRegistry([
        ...stored,
        ...secretsFromEnvironment().filter((secret) => !names.has(secret.name)),
      ]).redact(text);
    };
    artifactsServer = await startArtifactsServer({
      seam: hostSeam,
      port: artifactsPort,
      // Reads of a specific revision go through jj; the live file is still read
      // from disk, which is what makes an in-progress turn visible.
      ...(artifactRepoFor ? { repoFor: artifactRepoFor } : {}),
      bind: config.bindAddress,
      redact: redactArtifact,
      ...(config.webOrigin ? { webOrigin: config.webOrigin } : {}),
    });
  }

  // --- The web front end, optionally in its own process. ---
  //
  // `BRIDGE_WEB_ENGINE=link` forks `dist/web-host.js`, accepts its chord link, and
  // stops serving `/web` here. The adapter then owns that surface on
  // `BRIDGE_WEB_PORT`, which is the port the tunnel must point at; everything it
  // does goes through the seam, so the process holds no database and no Chat
  // credentials, and restarting it cannot interrupt a turn.
  //
  // The child is forked from *this* process rather than the supervisor because
  // the IPC channel is the link: whoever accepts it must be the session host.
  const webEngine = process.env.BRIDGE_WEB_ENGINE ?? "inprocess";
  let webSupervisor: Supervisor<import("node:child_process").ChildProcess> | undefined;
  if (webEngine === "link") {
    const webPort = Number(process.env.BRIDGE_WEB_PORT ?? 0);
    if (!webPort) {
      logger.error("[bridge] BRIDGE_WEB_ENGINE=link needs BRIDGE_WEB_PORT");
      process.exit(1);
    }
    // src/web-host.ts compiles next to the entrypoint, one level up from this file.
    const entry = new URL("../web-host.js", import.meta.url).pathname;

    // The one chord host this process serves, created above and shared: it accepts one link per
    // adapter generation, and a deployment with two linked adapters still has one host.
    webSupervisor = supervise({
      start: () =>
        fork(entry, [], {
          stdio: ["ignore", "pipe", "inherit", "ipc"],
          env: {
            ...process.env,
            // The adapter has no business reading the database path or the
            // service account; it only needs where to listen and which model to
            // default to.
            BRIDGE_DB: "",
            GOOGLE_SERVICE_ACCOUNT_JSON: "",
            BRIDGE_WEB_DEFAULT_PROVIDER: defaultModel.provider,
            BRIDGE_WEB_DEFAULT_MODEL: defaultModel.modelId,
          },
        }),
      onStart: (child) => {
        child.stdout?.on("data", (chunk: Buffer) => {
          for (const line of chunk.toString().split("\n")) {
            if (line.startsWith("WEB_ADAPTER_LISTENING ")) {
              logger.info(`[bridge] web adapter ready on ${line.slice("WEB_ADAPTER_LISTENING ".length)}`);
            }
          }
        });
        // Each generation gets its own link: a dead child's channel is gone.
        objectHost.accept(ipcLink(child as unknown as Parameters<typeof ipcLink>[0]), {
          principal: "web-adapter",
          kind: "client",
        });
      },
      log: (message) => logger.warn(message),
    });
    logger.info("[bridge] web engine=link: /web is served by a supervised adapter process");
  }

  // The painter, started as one thing: the cursor and the mouth it feeds.
  const chatPainter = await startChatPainter({ seam: chatSeam, config, client, dbPath });

  // `RECEIVER=none` runs the bridge for `/web` only — no Pub/Sub, no service
  // account, no Chat app. It exists because `PubSubReceiver.start()` refuses to
  // start without a subscription, so a web-only deployment (and the browser
  // tests) would otherwise exit immediately.
  const receiver: MessageReceiver =
    process.env.RECEIVER === "none"
      ? new NullReceiver()
      : new PubSubReceiver(
          config.serviceAccountPath,
          config.pubsubSubscription,
          state,
          config.allowedSpaces,
          config.allowedUsers,
        );

  // --- The bridge's own delivery cursor, in shadow mode -------------------------
  //
  // Step one of moving delivery off the server (§17 of the design doc): the bridge
  // keeps a position per conversation and walks it forward, *posting nothing*. It
  // proves the cursor arithmetic — adoption at the head, gaps getting adopted rather
  // than skipped, an unfinished post being reported — while the legacy path keeps
  // doing the actual posting, so a bug here costs a log line and never a message.
  //
  // The state is deliberately the bridge's, not the server's: "how much of this have
  // I seen" is a fact about this surface, and it survives a conversation outliving
  // the bridge.

  /**
   * Feed view frames into a stream, whichever way they arrived.
   *
   * The same rule the in-process sink applies — newest unfinished tool, cleared once none
   * is left, and nothing said when neither changed — kept in one function so the two view
   * modes cannot drift in how they paint.
   */

  const shutdown = async (): Promise<void> => {
    chatPainter?.stop();
    logger.info("[bridge] shutting down...");
    await receiver.stop();
    artifactsServer?.close();
    webSupervisor?.stop();
    // Closing the harness waits for running task code to return and leaves the
    // store consistent; anything unfinished resumes on the next start.
    await host.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  // The Chat adapter's message path, in its own module: the same function the fork will run in
  // another process, given a seam instead of a `BridgeHost`.
  const handler = chatHandler({
    seam: chatSeam,
    config,
    client,
    router,
    state,
    secrets,
    activity,
  });
  await receiver.start(handler);
  logger.info("[bridge] running on the durable engine. Ctrl+C to stop.");

  // Name whatever has no title yet, in the background. Detached on purpose: a
  // hundred titles must not delay the first Chat message, and one title at a time
  // keeps the titler from competing with a running turn.
  if (config.topicSummary) {
    void nameUntitledConversations({
      seam: chatSeam,
      config: {
        baseUrl: config.topicSummaryBaseUrl,
        model: config.topicSummaryModel,
        timeoutMs: config.topicSummaryTimeoutMs,
        ...(config.topicSummaryApiKey ? { apiKey: config.topicSummaryApiKey } : {}),
      },
      // One title at a time, with a gap between them: the titler shares this
      // machine's cores with the conversations it is naming, and a title arriving
      // a minute late is fine.
      intervalMs: 5_000,
      maxPerPass: 10,
    }).then(
      (count) => logger.info(`[naming] pass finished: ${count} conversation(s) named`),
      (error: unknown) => logger.error(`[naming] pass failed: ${(error as Error).message}`),
    );
  }
}

main().catch((error) => {
  logger.error("[bridge] fatal:", error);
  process.exit(1);
});

