/**
 * Forking an adapter: supervise it, follow its log, and accept its link.
 *
 * Both adapters need exactly this, and it was written twice — once for the web child and once for the
 * Chat child — with the same three parts in the same order:
 *
 *   1. `fork(entry, [], { stdio: ["ignore","pipe","inherit","ipc"] })`, because the IPC channel is
 *      the chord link and stdout is the only safe place to announce readiness;
 *   2. a `supervise()` loop, so a crashed adapter comes back with backoff instead of leaving its
 *      surface down until someone restarts the bridge;
 *   3. `objectHost.accept(ipcLink(child), …)` per generation, because a dead child's channel is gone
 *      and the next one needs its own;
 *   4. killing the child when its link closes without it exiting. Chord leaves an *upstream* binding
 *      detached after a closed link, waiting for a replacement the child can never open (it cannot
 *      re-fork itself), so the adapter would keep serving a host it cannot reach: calls made before
 *      the close hang, later ones fail `no route to session-host`, and nothing ever repairs it. A
 *      link death — a keepalive timeout on a starved machine, most often — is the same situation as
 *      a crash, and deserves the same answer.
 *
 * Two details are easy to get wrong and are handled here rather than in each caller:
 *
 *   - **stdout is parsed for one marker and then forwarded verbatim.** A piped stdout that is
 *     parsed and dropped is a process with no log: the Chat adapter ran for two hours like that, with
 *     every `[chat]` and `[paint]` line it wrote silently discarded.
 *   - **the link is accepted in `onStart`**, not after the readiness line, so a fast child cannot
 *     make a request before its link exists.
 */
import { fork, type ChildProcess } from "node:child_process";

import { ipcLink } from "@earendil-works/chord";

import { logger } from "../logger.js";
import { supervise, type Supervisor } from "./supervisor.js";
import type { Host } from "@earendil-works/chord";

export interface ForkAdapterOptions {
  /** The compiled entrypoint, e.g. `new URL("../chat-host.js", import.meta.url)`. */
  entry: URL;
  /** Extra environment for the child; the parent's is inherited first. */
  env?: Record<string, string>;
  /** The line the child prints once it can serve, e.g. `WEB_ADAPTER_LISTENING `. */
  marker: string;
  /** Called with the marker's payload (`bind:port`), and separately with each new child. */
  onReady?(where: string, child: ChildProcess): void;
  /** Called with every child generation, so the caller can accept its link. */
  onChild?(child: ChildProcess): void;
  /** Where the child's log lines go. Defaults to `logger.info`. */
  log?(line: string): void;
  /**
   * Node flags for the child.
   *
   * Production forks compiled JavaScript and needs none. A test forks TypeScript, so it passes
   * `["--import", "tsx"]` — the same loader the test process itself runs under.
   */
  execArgv?: string[];
}

/**
 * Keep one adapter process alive.
 *
 * `acceptLink` is separate from `onChild` because accepting is the chord host's job and the caller
 * owns it: this module must not know whether the deployment links one adapter or two.
 */
export function forkAdapter(
  options: ForkAdapterOptions,
  acceptLink: (child: ChildProcess) => void,
): Supervisor<ChildProcess> {
  const log = options.log ?? ((line: string) => logger.info(line));
  return supervise({
    start: () =>
      fork(options.entry.pathname, [], {
        stdio: ["ignore", "pipe", "inherit", "ipc"],
        env: { ...process.env, ...(options.env ?? {}) },
        ...(options.execArgv ? { execArgv: options.execArgv } : {}),
      }),
    onStart: (child) => {
      child.stdout?.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString().split("\n")) {
          if (line === "") continue;
          if (line.startsWith(options.marker)) {
            const where = line.slice(options.marker.length);
            (options.onReady ?? ((at: string) => logger.info(`[bridge] adapter ready on ${at}`)))(where, child);
            continue;
          }
          // Forwarded unchanged: the child's line already carries its own timestamp and level, so
          // re-logging it would double both — and dropping it was the bug this exists to prevent.
          process.stdout.write(`${line}\n`);
        }
      });
      acceptLink(child);
      options.onChild?.(child);
    },
    log: (message) => logger.warn(message),
  });
}

/** Accept one adapter generation's link on the host this process serves. */
export function acceptAdapterLink(objectHost: Host, child: ChildProcess, principal: string): void {
  const link = ipcLink(child as unknown as Parameters<typeof ipcLink>[0]);
  objectHost.accept(link, { principal, kind: "client" });
  // The child has no way back to this host once its link is closed (see the header): kill it so the
  // supervisor forks a generation with a fresh channel, exactly as it would after a crash.
  link.onClose((reason) => {
    // A child that merely died closes its channel first and is reaped a few milliseconds later.
    // Waiting for that turn keeps the log honest — a crash says so once, from the supervisor — and
    // stops a second SIGKILL being sent to a process that is already gone.
    setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      logger.warn(
        `[supervisor] ${principal} lost its link to the session host (${reason}) — restarting the adapter`,
      );
      // SIGKILL, not SIGTERM: the link is usually closed *because* the peer could not answer for
      // long enough to run its own exit handlers, so asking it to exit politely may never be heard.
      child.kill("SIGKILL");
    }, 25).unref();
  });
}
