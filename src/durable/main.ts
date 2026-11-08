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
import { attachViewSink, viewFramePainter } from "../adapter/view-sink.js";
import { DurableRouter } from "../adapter/router.js";
import { runDurableCommand } from "../adapter/commands.js";
import { defaultSettings } from "../adapter/commands.js";
import { ActivityFeed } from "./activity.js";
import { Painter } from "./painter.js";
import { httpActivitySource, httpViewSource, ViewLadder } from "../adapter/view-client.js";
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
import { serveSessionHost } from "../session-host/link.js";
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

  // --- The seam every adapter talks to. ---
  //
  // In-process today, but constructed once and passed to each adapter, so the
  // adapters depend on the interface rather than on this object. The artifact
  // roots are decided here because deriving artifacts is the host's job: a viewer
  // asks for a list, it does not walk the transcript and filter paths itself.
  /**
   * Show a turn that started on another surface in the Chat side of the
   * conversation (see `durable/mirror.ts` for the shape and the API 403 behind
   * it). Chat is the surface that would otherwise be missing those turns, and a
   * conversation that only half appears in one client is not much use.
   */
  // Conversations whose turns the painter posts (see the painter block below). Read
  // by the handler *and* the painter, from one value, so the two cannot disagree about
  // who owns a thread.
  /** Set once the painter is created, below. The handler pokes it; nothing else does. */
  let painter: Painter | undefined;
  // The server's own account of what it is doing. Subscribers are connections (§17), and the
  // per-turn watching is one attachment per running turn — not per reader. Late-bound because
  // the seam is built below, and this object is only used once requests start arriving.
  const activity = new ActivityFeed({ seam: { attach: (id, frame) => seam.attach(id, frame) } });

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

  const seam = inProcessSessionHost({
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

  const defaults = await defaultSettings(seam);
  const [fallback] = await seam.models();
  const defaultModel = defaults.provider && defaults.modelId
    ? { provider: defaults.provider, modelId: defaults.modelId }
    : fallback
      ? { provider: fallback.provider, modelId: fallback.id }
      : undefined;
  if (!defaultModel) {
    logger.error("[bridge] no model configured — set a default in ~/.pi/agent/settings.json");
    process.exit(1);
  }
  const router = new DurableRouter(seam, {
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
              seam,
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
                if ((await seam.snapshot(binding.conversationId))?.busy === true) {
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
                seam,
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
              seam,
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
      seam,
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

    // `serveSessionHost` only creates a chord host: it opens no socket, so a
    // bridge that never forks an adapter pays nothing for it. It is created once
    // and accepts one link per adapter generation.
    const objectHost = serveSessionHost(seam);

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
      seam,
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

    // The painter is the mouth for every Chat conversation, so this handler's job is
    // narrower than it was: submit, wait (waiting is what stamps the answer's origin),
    // poke the painter, and say why a turn produced nothing. It never posts an answer,
    // which is why the claim machinery that arbitrated between two posters is gone
    // rather than merely idle.
    try {
      // The delivery is idempotent on the Chat message name, so a Pub/Sub
      // redelivery after a crash finds the same submission instead of asking the
      // model again.
      const delivered = await router.deliver({
        chatKey,
        messageName: incoming.message.name,
        text,
        images,
      });
      activity.started(delivered.conversationId);
      // No wake: activity carries this now, and the painter hears it from the server like any
      // other subscriber.

      const turnStarted = Date.now();
      const settled = await seam.awaitSubmission(delivered.submissionId);
      const turnMs = Date.now() - turnStarted;

      if (settled.status !== "done" || settled.text === "") {
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
            ` after ${turnMs}ms conversation=${delivered.conversationId}` +
            (detail === undefined ? "" : ` detail=${JSON.stringify(detail).slice(0, 300)}`),
        );
        // The notice is the handler's because the handler is what knows *why*: the
        // painter only ever sees that no answer entry arrived.
        await client
          .sendMessage(spaceName, failureNotice(settled.status, reason, turnMs), threadName)
          .catch((error) => logger.error("[chat] empty-reply notice failed:", (error as Error).message));
        return "ok";
      }

      // Detached: a CPU titler can take minutes, and the reply is already
      // delivered. Only fires when /model left a pending card for this thread,
      // so it is free to call on every turn.
      if (config.topicSummary) {
        void applyDurableTopicSummary({
          state,
          seam,
          client,
          chatKey,
          display,
          config: {
            baseUrl: config.topicSummaryBaseUrl,
            model: config.topicSummaryModel,
            timeoutMs: config.topicSummaryTimeoutMs,
            ...(config.topicSummaryApiKey ? { apiKey: config.topicSummaryApiKey } : {}),
          },
        });
      }
      return "ok";
    } catch (error) {
      const aborted = (error as Error)?.name === "AbortError";
      logger.error(`[chat] ${display}: handler ${aborted ? "interrupted" : "error"}:`, (error as Error).message);
      // Nothing to clean up here any more: the placeholder belongs to the painter, which
      // abandons it when it sees a settled turn with no answer entry.
      return "ok";
    }
  };

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
  let paintTimer: NodeJS.Timeout | undefined;
  {
    const ledgerFile =
      config.ledgerPath === ""
        ? path.join(path.dirname(dbPath), "bridge-ledger.json")
        : config.ledgerPath;
    const ledger = await Ledger.load(ledgerFile);
    logger.info(
      `[ledger] shadow mode, positions in ${ledgerFile}${ledger.recovered ? " (adopting afresh: the file was unreadable)" : ""}`,
    );
    // The shadow pass is gone. It existed to prove a cursor against real transcripts while the
    // legacy path still posted; the painter posts now, so the pass was left observing a mouth that
    // was already the same object — and worse, *confirming* entries the painter had not painted
    // yet, which is how an answer gets stolen. The cursor is simply the painter's memory.
    logger.info(`[ledger] positions in ${ledgerFile}${ledger.recovered ? " (unreadable: adopting afresh)" : ""}`);

    // --- The painter: the one mouth for the conversations it owns -----------------
    //
    // Rolled out per *conversation*, not per bridge: there is one Chat bridge, so
    // "one bridge at a time" is all or nothing, whereas a conversation is exactly the
    // unit whose cursor, thread and notification policy are already its own. Opted-in
    // threads get their turns posted here and the handler keeps its hands off them
    // (same predicate, same process, so the two cannot disagree).
    {
      logger.info("[paint] posting for every Chat conversation — the handler will not");
      // The address a conversation lives at. Read per use rather than cached: bindings
      // are rewritten on every message, and a stale key here would post into the wrong
      // thread — the failure this whole arrangement exists to make impossible.
      const addressOf = async (conversationId: number): Promise<string | undefined> => {
        const bindings = await host.bindings().catch(() => ({ byChatKey: {} }));
        return Object.entries(bindings.byChatKey).find(([, b]) => b.conversationId === conversationId)?.[0];
      };
      painter = new Painter({
        surface: "gchat",
        ledger,
        // Every conversation that lives in Chat, and nothing else: a web-only
        // conversation has no thread for this bridge to keep up.
        owns: () => true,
        conversations: async () => {
          const bindings = await host.bindings().catch(() => ({ byChatKey: {} }));
          return Object.entries(bindings.byChatKey)
            .filter(([chatKey]) => chatKey.startsWith("spaces/"))
            .map(([, binding]) => ({
              conversationId: binding.conversationId,
              lastActivityAt: binding.updatedAt ?? binding.createdAt,
            }));
        },
        history: (conversationId, limit, offset) => seam.history(conversationId, { limit, offset }),
        busy: async (conversationId) => (await seam.snapshot(conversationId))?.busy === true,
        // Held per conversation, across turns: this is what makes a turn *starting* pushed
        // rather than polled, and it is the shape the extracted bridge will have.
        ...(config.viewMode === "stream"
          ? {
              // One activity stream for every conversation this bridge serves — the chat bridge's
              // shape. It is what tells the painter a turn started in a thread it is not watching,
              // which is the job the sweep used to do.
              activity: (handlers: { started(id: number): void; settled(id: number): void }) => {
                const ladder = new ViewLadder({
                  source: httpActivitySource({
                    baseUrl: config.selfUrl === "" ? `http://127.0.0.1:${config.healthPort}` : config.selfUrl,
                    ...(config.webToken ? { token: config.webToken } : {}),
                  }),
                  onView: (event) => {
                    const activity = event as { conversationId?: unknown; kind?: unknown };
                    if (typeof activity.conversationId !== "number") return;
                    if (activity.kind === "started") handlers.started(activity.conversationId);
                    else if (activity.kind === "settled") handlers.settled(activity.conversationId);
                  },
                  // Degraded: the sweep comes back, which is §18's fallback and the only polling
                  // left in the healthy path's absence.
                  poll: async () => {
                    await painter?.tick();
                  },
                  heartbeatMs: 15_000,
                  onMode: (mode) => logger.info(`[paint] activity ${mode}`),
                });
                void ladder.run();
                logger.info(
                  "[paint] activity: subscribed to every conversation (push; the sweep runs only if this degrades)",
                );
                return { detach: () => ladder.stop() };
              },
              watch: (
                conversationId: number,
                handlers: { frame(projected: unknown): void; settled(): void },
              ) => {
                // Settle is a transition, not a state: a stream that is idle stays idle, and
                // reporting every idle frame would re-read the transcript continuously.
                let wasBusy: boolean | undefined;
                const ladder = new ViewLadder({
                  source: httpViewSource({
                    baseUrl: config.selfUrl === "" ? `http://127.0.0.1:${config.healthPort}` : config.selfUrl,
                    conversationId,
                    ...(config.webToken ? { token: config.webToken } : {}),
                  }),
                  onView: (view) => {
                    const busy = (view as { busy?: unknown }).busy === true;
                    if (wasBusy === true && !busy) handlers.settled();
                    wasBusy = busy;
                    handlers.frame(view);
                  },
                  // Degraded: read the entries, which is what the bridge would otherwise do on
                  // its own timer. That is the §18 fallback, and it is the only polling left.
                  poll: async () => {
                    await painter?.poke();
                  },
                  heartbeatMs: 15_000,
                  onMode: (mode) => logger.info(`[paint] conversation ${conversationId}: view ${mode}`),
                });
                void ladder.run();
                return { detach: () => ladder.stop() };
              },
            }
          : {}),
        surfaceClient: {
          // The stream and its subscription are one act: a Chat placeholder cannot be
          // patched before it exists, and creating it later would be a second message.
          // Opening a stream is all this does. Subscribing it is the *watcher's* job in
          // stream mode (one subscription held across turns), and the sink's in-process mode,
          // so a conversation never ends up with two.
          open: async (conversationId) => {
            const target = chatTarget(await addressOf(conversationId));
            if (!target) return undefined;
            const key = (await addressOf(conversationId)) ?? String(conversationId);
            const stream = new ReplyStream(client, target.space, target.threadName, "gchat", {
              replaceOnFinish: config.replaceOnFinish,
            });
            stream.register(key);
            const paint = viewFramePainter(stream);

            if (config.viewMode === "stream") {
              // The watcher paints; nothing to attach here.
              return {
                stream: {
                  text: (full) => stream.onSnapshot(full),
                  tool: (name, args) => stream.showTool(name, args),
                  clearTool: () => stream.clearTool(),
                  finish: async (text) => {
                    await stream.finish(text);
                    stream.unregister(key);
                  },
                  abandon: async () => {
                    await stream.abandon();
                    stream.unregister(key);
                  },
                },
                paint: (projected) => paint(projected as ProjectedView),
                detach: () => stream.unregister(key),
              };
            }

            // In-process: the sink subscribes, paints and reports the settle edge itself.
            const sink = await attachViewSink({
              seam,
              conversationId,
              stream,
              onSettle: () => void painter?.poke(),
            });
            return {
              stream: {
                text: (full) => stream.onSnapshot(full),
                tool: (name, args) => stream.showTool(name, args),
                clearTool: () => stream.clearTool(),
                finish: async (text) => {
                  await stream.finish(text);
                  stream.unregister(key);
                },
                abandon: async () => {
                  await stream.abandon();
                  stream.unregister(key);
                },
              },
              paint: () => {}, // the sink is already painting this stream
              detach: () => {
                sink.detach();
                stream.unregister(key);
              },
            };
          },
          post: async (conversationId, text) => {
            const target = chatTarget(await addressOf(conversationId));
            if (!target) return;
            for (const [index, chunk] of splitMessage(text).entries()) {
              await client.sendMessage(
                target.space,
                chunk,
                target.threadName,
                index > 0 && target.threadName === undefined ? { silent: true } : undefined,
              );
            }
          },
        },
      });
      // The interval is the fallback for a deployment with no activity stream: it catches a
      // turn nothing announced (a web message, a resume after a restart).
      const instance = painter;
      // Periodic work, and *what* it is depends on whether there is a push path:
      //
      //   - no activity stream (in-process): the sweep is the mechanism, so it walks every
      //     conversation, on the shorter interval it has always used;
      //   - activity stream: the mechanism is the event, and all that is left to check is turns
      //     that claimed to start and never finished — normally an empty set, so normally no
      //     reads. A blanket sweep here would be a second mechanism doing nothing until something
      //     broke, which is a fair thing to refuse.
      const streamed = config.viewMode === "stream";
      paintTimer = setInterval(
        () => void (streamed ? instance.checkStuck() : instance.tick()),
        streamed ? 60_000 : Math.min(config.ledgerIntervalMs, 15_000),
      );
      paintTimer.unref();
      instance.start();
      void instance.tick();
    }
  }

  /**
   * Feed view frames into a stream, whichever way they arrived.
   *
   * The same rule the in-process sink applies — newest unfinished tool, cleared once none
   * is left, and nothing said when neither changed — kept in one function so the two view
   * modes cannot drift in how they paint.
   */

  const shutdown = async (): Promise<void> => {
    if (paintTimer) clearInterval(paintTimer);
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

  await receiver.start(handler);
  logger.info("[bridge] running on the durable engine. Ctrl+C to stop.");

  // Name whatever has no title yet, in the background. Detached on purpose: a
  // hundred titles must not delay the first Chat message, and one title at a time
  // keeps the titler from competing with a running turn.
  if (config.topicSummary) {
    void nameUntitledConversations({
      seam,
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

