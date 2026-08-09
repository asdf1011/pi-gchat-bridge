import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

export interface Config {
  /** Path to the service account JSON key (the Chat app's bot identity). */
  serviceAccountPath: string;
  /** How often to pull for Pub/Sub events (ms). */
  pullIntervalMs: number;
  pubsubSubscription: string;
  /** HTTP health endpoint port (0 disables). */
  healthPort: number;
  /** Working directory pi sessions operate in. */
  cwd: string;
  sessionsDir: string;
  stateFile: string;
  /** Watchdog: force-reset sessions streaming with no activity for this long (0 = disabled). */
  stallTimeoutMs: number;
  /** Watchdog: scan interval. */
  watchdogIntervalMs: number;
  /** Steer: how long to wait for an in-flight tool call before aborting to redirect (ms). */
  steerWaitMs: number;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value;
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

  return {
    serviceAccountPath,
    pullIntervalMs: Number(process.env.PULL_INTERVAL_MS ?? 1000),
    pubsubSubscription: process.env.PUBSUB_SUBSCRIPTION ?? "",
    healthPort: Number(process.env.PORT ?? 8080),
    cwd,
    sessionsDir,
    stateFile,
    stallTimeoutMs: Number(process.env.BRIDGE_STALL_TIMEOUT_MS ?? 20 * 60 * 1000),
    watchdogIntervalMs: Number(process.env.BRIDGE_WATCHDOG_INTERVAL_MS ?? 30_000),
    steerWaitMs: Number(process.env.BRIDGE_STEER_WAIT_MS ?? 10_000),
  };
}
