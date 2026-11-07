import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

export interface Config {
  /** Path to the service account JSON key (the Chat app's bot identity). */
  serviceAccountPath: string;
  pubsubSubscription: string;
  /** HTTP health endpoint port (0 disables). */
  healthPort: number;
  /**
   * Address the HTTP server binds to. Loopback by default: behind a tunnel or
   * reverse proxy, nothing else should be able to reach the bridge directly,
   * because the Access headers it trusts can otherwise be forged by anyone who
   * can open a socket to it.
   */
  bindAddress: string;
  /**
   * Where Cloudflare Access (or any identity-aware proxy) connects from.
   * The identity header is honoured only for requests whose socket peer is this
   * address; empty means never trust it.
   */
  trustedProxy: string;
  /** Working directory pi sessions operate in. */
  cwd: string;
  /**
   * Root of the per-conversation artifact directories, or empty to disable them.
   *
   * Each conversation gets `<artifactsDir>/conversation/<id>/`, which is a jj
   * repository, so scratch scripts written there can be annotated and commented
   * on per revision. Empty means "do not track artifacts in version control" and
   * leaves the mtime walk as the only witness.
   */
  artifactsDir: string;
  sessionsDir: string;
  stateFile: string;
  /** Watchdog: force-reset sessions streaming with no activity for this long (0 = disabled). */
  stallTimeoutMs: number;
  /** Watchdog: scan interval. */
  watchdogIntervalMs: number;
  /** Steer: how long to wait for an in-flight tool call before aborting to redirect (ms). */
  steerWaitMs: number;
  /** Evict an idle, non-streaming session from memory after this long (0 = disabled). */
  sessionIdleMs: number;
  /** Restrict responding to these spaces (resource name or ID). Empty = all. */
  allowedSpaces: string[];
  /** Restrict which users can trigger pi (resource name or ID). Empty = all. */
  allowedUsers: string[];
  /**
   * Restrict who may use `/secret` (resource name or ID). Empty = inherit
   * `allowedUsers`.
   *
   * Separate from `allowedUsers` because the two risks differ: triggering pi
   * spends tokens and can run tools; listing secrets reveals which names exist
   * and the last few characters of each. Someone may reasonably be allowed to
   * chat without being allowed to see the secret inventory.
   */
  secretUsers: string[];
  /** Optional shared secret required on POST /notify (Authorization: Bearer …). Empty = no auth. */
  notifyToken: string;
  /** Bearer token for web writes. Empty means no check (tailnet-only deployment). */
  webToken: string;
  /** Where the artifact origin lives, for links from the web pane. Empty hides them. */
  artifactsBaseUrl: string;
  /** Origin of the chat UI, allowed to frame artifact documents. */
  webOrigin: string;
  /** Re-title the /model "Model switched" card with a local-model topic (gchat display only). */
  topicSummary: boolean;
  /** OpenAI-compatible base URL of the LOCAL model used for titles (e.g. llama.cpp). */
  topicSummaryBaseUrl: string;
  /** Model id to request from that server. */
  topicSummaryModel: string;
  /** Give up on a title after this long — CPU inference is slow and shared. */
  topicSummaryTimeoutMs: number;
  /** Bearer token for a hosted titler; empty for the local llama.cpp one. */
  topicSummaryApiKey: string;
  /**
   * Streaming placeholder: post a fresh final message and delete the placeholder
   * (true, the historical behaviour — costs a "Message deleted" stub but the
   * final create is the notification), or keep the patched placeholder as the
   * answer (false — no stub, renders Markdown live).
   */
  replaceOnFinish: boolean;
  /**
   * What the bridge's own delivery cursor does (§17 of the design doc).
   *
   * `shadow` walks each conversation forward from its cursor and *logs* what it
   * would post, posting nothing: the cursor arithmetic is proven with no risk to
   * message delivery. `off` disables the pass entirely.
   */
  ledgerMode: "shadow" | "off";
  /**
   * Where the cursor lives. Empty means "next to the database", which is the one
   * directory this deployment can already write to.
   *
   * This is the bridge's *own* state, not the server's: a bridge is temporary and
   * the conversation is not, so "how much of this have I seen" belongs to the
   * bridge. See `durable/ledger.ts`.
   */
  ledgerPath: string;
  /** How often the pass runs. Cheap: it reads a page or two per active thread. */
  ledgerIntervalMs: number;
  /** Ignore threads nobody has touched for this long, so dormant ones cost nothing. */
  ledgerActiveWithinMs: number;
  /**
   * Conversations whose turns the painter posts, instead of the Chat handler.
   *
   * The rollout unit is a *conversation*, not a bridge: there is one Chat bridge, so
   * "one bridge at a time" would be all or nothing — while a conversation is exactly
   * the thing whose cursor, thread and notification policy are already per-instance.
   * Empty means the handler posts everything (today's behaviour); a list opts those
   * threads in, one at a time.
   */
  paintConversations: number[];
  /**
   * Paint every conversation that lives in Chat, rather than an opt-in list.
   *
   * `BRIDGE_PAINT=all`. The list is for a trial on one thread; this is the switch that
   * retires the handler's posting path entirely — after which the claim machinery
   * (`claimAnswer`/`releaseAnswer`/`lastPostedAnswer`) has no caller left.
   */
  paintAll: boolean;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

/** Parse a comma-separated env var into a trimmed, non-empty list. */
function listEnv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(): Config {
  const serviceAccountPath = required("GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!fs.existsSync(serviceAccountPath)) {
    throw new Error(`Service account file not found: ${serviceAccountPath}`);
  }

  const cwd = process.env.PI_CWD ?? process.cwd();
  if (!fs.existsSync(cwd)) {
    throw new Error(`PI_CWD does not exist: ${cwd}`);
  }

  const sessionsDir = path.resolve(process.env.BRIDGE_SESSIONS_DIR ?? "./sessions");
  const stateFile = path.resolve(process.env.BRIDGE_STATE_FILE ?? "./state.json");
  fs.mkdirSync(sessionsDir, { recursive: true });

  // Empty by default: enabling this creates a repository per conversation, which
  // is a deployment's choice to make, not something a fresh checkout should do
  // behind the operator's back.
  const artifactsDir = (process.env.BRIDGE_ARTIFACTS_DIR ?? "").trim();
  const paintAll = (process.env.BRIDGE_PAINT ?? "").trim().toLowerCase() === "all";

  return {
    serviceAccountPath,
    pubsubSubscription: process.env.PUBSUB_SUBSCRIPTION ?? "",
    healthPort: Number(process.env.PORT ?? 8080),
    bindAddress: process.env.BRIDGE_BIND ?? "127.0.0.1",
    trustedProxy: process.env.BRIDGE_TRUSTED_PROXY ?? "",
    cwd,
    artifactsDir: artifactsDir === "" ? "" : path.resolve(artifactsDir),
    sessionsDir,
    stateFile,
    stallTimeoutMs: Number(process.env.BRIDGE_STALL_TIMEOUT_MS ?? 20 * 60 * 1000),
    watchdogIntervalMs: Number(process.env.BRIDGE_WATCHDOG_INTERVAL_MS ?? 30_000),
    steerWaitMs: Number(process.env.BRIDGE_STEER_WAIT_MS ?? 10_000),
    sessionIdleMs: Number(process.env.BRIDGE_SESSION_IDLE_MS ?? 0),
    allowedSpaces: listEnv("ALLOWED_SPACES"),
    allowedUsers: listEnv("ALLOWED_USERS"),
    secretUsers: listEnv("SECRET_USERS"),
    notifyToken: process.env.BRIDGE_NOTIFY_TOKEN ?? "",
    webToken: process.env.BRIDGE_WEB_TOKEN ?? "",
    artifactsBaseUrl: process.env.BRIDGE_ARTIFACTS_BASE_URL ?? "",
    // Derived from the artifact base's sibling by default is impossible to guess,
    // so it is explicit; unset means "same origin only".
    webOrigin: process.env.BRIDGE_WEB_ORIGIN ?? "",
    topicSummary: (process.env.BRIDGE_TOPIC_SUMMARY ?? "1") !== "0",
    // The TITLER's own server, not the conversation router. Sharing one meant
    // every title evicted a conversation's KV prefix, which on a 2-slot server
    // is the whole cache. Default port 8091 is lfm-server.sh's titler instance.
    topicSummaryBaseUrl: process.env.BRIDGE_TOPIC_SUMMARY_BASE_URL ?? "http://127.0.0.1:8091/v1",
    topicSummaryApiKey: process.env.BRIDGE_TOPIC_SUMMARY_API_KEY ?? "",
    topicSummaryModel: process.env.BRIDGE_TOPIC_SUMMARY_MODEL ?? "lfm3-vl-2b-q8",
    // 15 min: CPU inference is slow, and the titler shares the machine with
    // whatever conversations are running (it no longer shares their slots).
    // The job is detached, so waiting costs nothing.
    topicSummaryTimeoutMs: Number(process.env.BRIDGE_TOPIC_SUMMARY_TIMEOUT_MS ?? 15 * 60 * 1000),
    replaceOnFinish: (process.env.BRIDGE_REPLACE_ON_FINISH ?? "1") !== "0",
    // Shadow by default: it posts nothing, so there is no reason to make an
    // operator opt into the safety net before it can prove anything.
    ledgerMode: (process.env.BRIDGE_LEDGER ?? "shadow") === "off" ? "off" : "shadow",
    ledgerPath: (process.env.BRIDGE_LEDGER_PATH ?? "").trim(),
    ledgerIntervalMs: Number(process.env.BRIDGE_LEDGER_INTERVAL_MS ?? 60_000),
    ledgerActiveWithinMs: Number(process.env.BRIDGE_LEDGER_ACTIVE_WITHIN_MS ?? 7 * 24 * 60 * 60 * 1000),
    paintAll,
    // `all` supersedes the list: keeping both live would make the log claim one thing
    // and the painter do another.
    paintConversations: paintAll
      ? []
      : listEnv("BRIDGE_PAINT_CONVERSATIONS")
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id) && id > 0),
  };
}
