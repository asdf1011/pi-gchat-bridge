/**
 * Provider registrations from installed pi packages, for the bridge's model runtime.
 *
 * `ModelRuntime.create()` builds its catalogue from three things: pi's bundled
 * providers, `~/.pi/agent/models.json`, and `auth.json`. OAuth providers are not
 * in any of them — they arrive as extensions that call `ctx.registerProvider()`,
 * which is why the TUI can offer `antigravity/*` and the bridge cannot. Without
 * this, a backend installed with `pi install` is invisible to `/model` in Chat
 * even after `/login`.
 *
 * The SDK's own `createAgentSessionServices` closes that gap by loading packages
 * through `DefaultResourceLoader` and draining
 * `pendingProviderRegistrations` into the runtime. That is more than the bridge
 * wants: the same load also collects tools, slash commands and hooks, and the
 * harness installs its own versions of those. So the loader runs here and only
 * the provider registrations are taken — a package's tools stay out of a
 * conversation that never asked for them.
 *
 * Deliberately best-effort. A broken package costs its own providers and a log
 * line; it must not stop the bridge from starting and answering.
 */
import { DefaultResourceLoader, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { logger } from "../logger.js";

export type ProviderRegistrationReport = {
  /** Providers registered into the runtime, by the name the extension chose. */
  registered: string[];
  /** Failures, already logged; kept for tests and callers that want to assert. */
  failures: { provider: string; error: string }[];
};

export async function registerPackageProviders(
  runtime: ModelRuntime,
  options: { cwd: string; agentDir?: string },
): Promise<ProviderRegistrationReport> {
  const agentDir = options.agentDir ?? getAgentDir();
  const report: ProviderRegistrationReport = { registered: [], failures: [] };

  let pending: readonly { name: string; config: unknown; extensionPath: string }[];
  try {
    const settingsManager = SettingsManager.create(options.cwd, agentDir);
    const loader = new DefaultResourceLoader({ cwd: options.cwd, agentDir, settingsManager });
    await loader.reload();
    pending = loader.getExtensions().runtime.pendingProviderRegistrations;
  } catch (error) {
    report.failures.push({ provider: "*", error: message(error) });
    logger.warn(`[models] could not load packages from ${agentDir}: ${message(error)}`);
    return report;
  }

  for (const { name, config, extensionPath } of pending) {
    try {
      runtime.registerProvider(name, config as Parameters<ModelRuntime["registerProvider"]>[1]);
      report.registered.push(name);
      logger.info(`[models] provider ${name} from ${extensionPath}`);
    } catch (error) {
      report.failures.push({ provider: name, error: message(error) });
      logger.warn(`[models] provider ${name} from ${extensionPath} failed: ${message(error)}`);
    }
  }

  return report;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
