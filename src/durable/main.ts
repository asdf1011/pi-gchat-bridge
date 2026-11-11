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


import { forkAdapter, acceptAdapterLink } from "../session-host/fork-adapter.js";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";
import { logger } from "../logger.js";
import { serveSessionHost } from "../session-host/link.js";
import { ReplyStream } from "../stream.js";
import type { IncomingMessage } from "../types.js";
import { attachViewSink, viewFramePainter } from "../adapter/view-sink.js";
import { runDurableCommand } from "../chat/commands.js";
import { defaultSettings } from "../chat/commands.js";
import { ActivityFeed } from "./activity.js";
import { httpPoll } from "../adapter/poll-client.js";
import { entriesAfter } from "./entries.js";
import type { ProjectedView } from "../session-host/projection.js";
import { chatTarget } from "../session-key.js";
import { splitMessage } from "../stream.js";
import { Ledger } from "./ledger.js";
import { BridgeHost } from "./host.js";
import { BridgeLockedError } from "./lock.js";
import { hostRouteFailure, hostRoutes } from "./host-routes.js";
import { serveRoutes } from "../shared/serve-routes.js";
import { readBody } from "../adapter/web-routes.js";
import { startArtifactsServer } from "../adapter/artifacts-server.js";
import { artifactRoots } from "./artifacts.js";
import { initArtifactRepo } from "./artifact-vcs.js";
import { inProcessSessionHost } from "../session-host/inprocess.js";
import type { SessionHost } from "../session-host/api.js";
import type { Supervisor } from "../session-host/supervisor.js";
import { ipcLink } from "@earendil-works/chord";
import { SecretRegistry } from "./extensions/redact.js";
import { secretsFromEnvironment } from "./extensions/secret-redactor.js";
import { applyDurableTopicSummary } from "./topic.js";
import { failureNotice } from "./failure-notice.js";
import { keyFor } from "../session-key.js";
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
  // The server's own account of what it is doing. Subscribers are connections, not readers, and the
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
    // The store the redaction registry is seeded from: the same file, so a secret added from a surface
    // is a secret the host can redact (after a restart — see the note in `chat-host.ts`).
    secrets,
    onObserveError: (error) => logger.warn(`[artifacts] observation failed: ${String(error)}`),
    // A turn exists when a submission is accepted, and the host is the thing that accepted it. The
    // feed wakes the long poll; the adapter does not have to announce what the host just did.
    onTurnStarted: (conversationId) => activity.started(conversationId),
  });

  // The Chat adapter runs in its own process, always.
  //
  // It held the seam in-process long enough to prove the seam was complete — a linked seam over a
  // memory pair, so that an operation the adapter needs but the link does not publish failed here, in
  // a log line, rather than at the moment a second process started and Chat went quiet. That served
  // its purpose and is gone; what is left is the arrangement that matters: this process owns the
  // store, and the adapter cannot touch it.
  //
  // The child is forked from *this* process rather than the supervisor because the IPC channel is
  // the link: whoever accepts it must be the session host.
  const chatPort = Number(process.env.BRIDGE_CHAT_PORT ?? 0);
  if (!chatPort) {
    logger.error("[bridge] BRIDGE_CHAT_PORT is not set — the Chat adapter needs somewhere to listen");
    process.exit(1);
  }
  // `serveSessionHost` opens no socket: it is a chord host, and accepts one link per adapter.
  const objectHost = serveSessionHost(hostSeam);
  let chatSupervisor: Supervisor<import("node:child_process").ChildProcess> | undefined;
  chatSupervisor = forkAdapter(
    {
      entry: new URL("../chat-host.js", import.meta.url),
      env: {
        // It needs the store's *directory* for the ledger and the secrets file, and nothing else
        // about the store. `BRIDGE_DB` stays set for that reason and no other.
        BRIDGE_CHAT_PORT: String(chatPort),
      },
      marker: "CHAT_ADAPTER_LISTENING ",
      onReady: (where) => logger.info(`[bridge] chat adapter ready on ${where}`),
    },
    (child) => acceptAdapterLink(objectHost, child, "chat-adapter"),
  );
  logger.info(`[bridge] chat adapter forked; /notify is served on ${chatPort}`);

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
  logger.info(`[bridge] default model ${defaultModel.provider}/${defaultModel.modelId}`);

  // --- The host's own HTTP surface ---
  //
  // Four questions a deployment asks of the process that owns the store: `/v1` (what happened),
  // `/healthz` (are you alive), `/status` (are the models working) and `/idle` (may I restart you).
  // The table is a module so it can be tested without a bridge; the skeleton around it — URL, identity,
  // the 500 guard — is shared with both adapters.
  if (config.healthPort > 0) {
    const server = http.createServer(
      serveRoutes({
        routes: hostRoutes({
          host,
          seam: hostSeam,
          activity,
          config,
          chatPort,
          model: defaultModel,
        }),
        trustedProxy: config.trustedProxy,
        warn: (line) => logger.warn(line),
        onError: hostRouteFailure,
      }),
    );
    server.listen(config.healthPort, config.bindAddress, () => {
      const where = `${config.bindAddress}:${config.healthPort}`;
      logger.info(`[bridge] health, /v1 and /idle on ${where}`);
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
  // The web adapter is forked, always: `dist/web-host.js` on `BRIDGE_WEB_PORT`, which is the port
  // the tunnel must point at. Everything it does goes through the seam, so that process holds no
  // database and no Chat credentials, and restarting it cannot interrupt a turn.
  //
  // It used to be a mode (`BRIDGE_WEB_ENGINE=link|inprocess`), the same way the Chat adapter was:
  // prove the seam with a toggle, delete the toggle. This is the deletion — there is no in-process
  // `/web` any more, so the duplication and the configuration matrix are both gone.
  //
  // The child is forked from *this* process rather than the supervisor because the IPC channel is
  // the link: whoever accepts it must be the session host.
  const webPort = Number(process.env.BRIDGE_WEB_PORT ?? 0);
  if (!webPort) {
    logger.error("[bridge] BRIDGE_WEB_PORT is not set — the web adapter needs somewhere to listen");
    process.exit(1);
  }
  let webSupervisor: Supervisor<import("node:child_process").ChildProcess> | undefined;
  webSupervisor = forkAdapter(
    {
      entry: new URL("../web-host.js", import.meta.url),
      env: {
        // The adapter has no business reading the database path or the service account; it only
        // needs where to listen and which model to default to.
        BRIDGE_DB: "",
        GOOGLE_SERVICE_ACCOUNT_JSON: "",
        BRIDGE_WEB_DEFAULT_PROVIDER: defaultModel.provider,
        BRIDGE_WEB_DEFAULT_MODEL: defaultModel.modelId,
      },
      marker: "WEB_ADAPTER_LISTENING ",
      onReady: (where) => logger.info(`[bridge] web adapter ready on ${where}`),
    },
    (child) => acceptAdapterLink(objectHost, child, "web-adapter"),
  );
  logger.info(`[bridge] web adapter forked; /web is served on ${webPort}`);

  const shutdown = async (): Promise<void> => {
    logger.info("[bridge] shutting down...");
    chatSupervisor?.stop();
    artifactsServer?.close();
    webSupervisor?.stop();
    // Closing the harness waits for running task code to return and leaves the
    // store consistent; anything unfinished resumes on the next start.
    await host.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  logger.info("[bridge] running on the durable engine. Ctrl+C to stop.");


}

main().catch((error) => {
  logger.error("[bridge] fatal:", error);
  process.exit(1);
});

