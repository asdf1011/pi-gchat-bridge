/**
 * Provider quota checks for /quota.
 *
 * Sources of truth:
 * - The providers to check come from the model runtime's auth-filtered model
 *   list (what conversations can actually query) — callers pass `listModels()`.
 * - Connection details (baseUrl, apiKey) come from `models.json` in the agent
 *   dir, so `$VAR` key references resolve against the environment.
 * - The topic titler (BRIDGE_TOPIC_SUMMARY_*) is a second programmatic caller;
 *   when its base URL matches a listed provider it is shown on that provider.
 *
 * A provider is `paid` when any of its models bills per token (cost > 0);
 * paid providers get a top-up link regardless of whether a balance API exists.
 * A failed or missing quota check never throws — the card reports what it
 * could find, per provider.
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Quota probe result for one provider. */
export interface ProviderQuota {
  provider: string;
  /** Model ids this provider offers (plus the topic titler's, when it shares this provider). */
  models: string[];
  /** True when any model bills per token (cost > 0). */
  paid: boolean;
  /** Where to add credit (paid providers only). */
  topUpUrl?: string;
  /** True when a quota API was actually queried. */
  queried: boolean;
  /** Provider says the account can make calls (undefined = unknown/not queried). */
  available?: boolean;
  /** Formatted balance / quota line for the card. */
  balance?: string;
  /** Free-local note, "no quota API" note, or error detail. */
  note?: string;
}

/** Console pages where credit can be added, per provider. */
const TOP_UP_URLS: Record<string, string> = {
  deepseek: "https://platform.deepseek.com/top_up",
  zai: "https://z.ai/manage-apikey/apikey-list",
};

/** model.json's connection block for one provider (subset we use). */
interface ProviderConfig {
  baseUrl?: string;
  apiKey?: string | null;
  models?: { id: string; cost?: { input?: number; output?: number } }[];
}

interface AgentModelsFile {
  providers?: Record<string, ProviderConfig>;
}

/** JSON fetch with a hard timeout; returns undefined on any failure. */
function fetchJson(url: string, headers: Record<string, string>, timeoutMs: number): Promise<unknown> {
  const fn = url.startsWith("http://") ? http : https;
  return new Promise((resolve) => {
    const req = fn.get(url, { headers, timeout: timeoutMs }, (res) => {
      if ((res.statusCode ?? 500) >= 400) {
        res.resume();
        resolve(undefined);
        return;
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(undefined);
        }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(undefined));
  });
}

function isLoopback(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const host = new URL(baseUrl).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

/** Resolve models.json's `$ENV_VAR` apiKey convention. */
function resolveApiKey(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  if (raw.startsWith("$")) return process.env[raw.slice(1)] || undefined;
  return raw;
}

/**
 * DeepSeek: GET /user/balance with the account key.
 * https://api-docs.deepseek.com/api/get-user-balance
 */
async function checkDeepseek(config: ProviderConfig): Promise<Partial<ProviderQuota>> {
  const key = resolveApiKey(config.apiKey);
  if (!key) return { note: "no API key configured" };
  // models.json carries the bare origin ("https://api.deepseek.com"); tolerate
  // a "/v1" suffix so either form works.
  const base = (config.baseUrl ?? "https://api.deepseek.com").replace(/\/v1\/?$/, "");
  const data = (await fetchJson(`${base}/user/balance`, { Authorization: `Bearer ${key}` }, 6000)) as
    | {
        is_available?: boolean;
        balance_infos?: { currency?: string; total_balance?: string; granted_balance?: string; topped_up_balance?: string }[];
      }
    | undefined;
  if (!data) return { note: "balance API unreachable or errored" };
  const info = data.balance_infos?.[0];
  const currency = info?.currency ?? "USD";
  const balance = `balance $${info?.total_balance ?? "?"} ${currency}` +
    (info?.granted_balance && Number(info.granted_balance) > 0 ? ` (of which $${info.granted_balance} granted)` : "");
  return { queried: true, available: data.is_available === true, balance };
}

/** Local llama.cpp (or any local OpenAI-compatible server): liveness only. */
async function checkLocal(config: ProviderConfig): Promise<Partial<ProviderQuota>> {
  if (!config.baseUrl) return { note: "free — local server" };
  const reachable = await new Promise<boolean>((resolve) => {
    const fn = config.baseUrl!.startsWith("http://") ? http : https;
    const req = fn.get(`${config.baseUrl!.replace(/\/$/, "")}/models`, { timeout: 3000 }, (res) => {
      res.resume();
      resolve((res.statusCode ?? 500) < 500);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
  });
  return {
    queried: true,
    available: reachable,
    note: reachable ? "free — local server, no quota" : "free — local server unreachable",
  };
}

/**
 * Check every provider the bridge can query. `models` is the auth-filtered
 * list from the model runtime (listModels()); providers with no models there
 * are skipped — they can't be queried anyway.
 */
export async function checkProviderQuotas(
  models: readonly { provider: string; id: string }[],
): Promise<ProviderQuota[]> {
  const byProvider = new Map<string, string[]>();
  for (const m of models) {
    const list = byProvider.get(m.provider) ?? [];
    list.push(m.id);
    byProvider.set(m.provider, list);
  }

  // Connection details from models.json in the agent dir.
  let configs: Record<string, ProviderConfig> = {};
  try {
    const file = path.join(getAgentDir(), "models.json");
    if (fs.existsSync(file)) {
      configs = (JSON.parse(fs.readFileSync(file, "utf8")) as AgentModelsFile).providers ?? {};
    }
  } catch {
    // No details: still report the providers, just without probes.
  }

  // The topic titler is a second programmatic caller; surface it on the
  // provider it shares a host with.
  const titlerModel = process.env.BRIDGE_TOPIC_SUMMARY === "0" ? undefined : process.env.BRIDGE_TOPIC_SUMMARY_MODEL;
  const titlerUrl = process.env.BRIDGE_TOPIC_SUMMARY_BASE_URL;
  const titlerHost = (() => {
    try {
      return titlerUrl ? new URL(titlerUrl).host : undefined;
    } catch {
      return undefined;
    }
  })();

  const results = await Promise.all(
    [...byProvider.entries()].map(async ([provider, modelIds]): Promise<ProviderQuota> => {
      const config = configs[provider] ?? {};
      const models = [...modelIds];
      if (titlerModel && titlerHost) {
        try {
          if (config.baseUrl && new URL(config.baseUrl).host === titlerHost) {
            models.push(`${titlerModel} (topic titler)`);
          }
        } catch {
          // bad URLs just skip the titler annotation
        }
      }
      const paid = (config.models ?? []).some(
        (m) => (m.cost?.input ?? 0) > 0 || (m.cost?.output ?? 0) > 0,
      );
      const quota: ProviderQuota = {
        provider,
        models,
        paid,
        topUpUrl: paid ? TOP_UP_URLS[provider] : undefined,
        queried: false,
      };
      let check: Partial<ProviderQuota>;
      try {
        if (provider === "deepseek") {
          check = await checkDeepseek(config);
        } else if (isLoopback(config.baseUrl)) {
          check = await checkLocal(config);
        } else {
          check = { note: "no quota API known for this provider — check the console" };
        }
      } catch (err) {
        check = { note: `quota check failed: ${(err as Error).message}` };
      }
      return { ...quota, ...check };
    }),
  );

  return results.sort((a, b) => a.provider.localeCompare(b.provider));
}
