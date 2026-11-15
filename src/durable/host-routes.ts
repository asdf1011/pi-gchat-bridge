/**
 * The host's own HTTP surface, as a route table.
 *
 * It was written inline in `main.ts`, inside a 500-line function that also set up artifacts, forked
 * two adapters and owned shutdown — and it was the one route table in the repository without the
 * shape `web-routes.ts` and `v1-routes.ts` already had, which is why it was also the one without a
 * test. Nothing about it is special: a request comes in, one of four questions is asked, and `false`
 * means "not mine".
 *
 * What belongs here is what the **store** owns: the `/v1` protocol a second surface reads, the two
 * probes a deployment needs (`/healthz` for "is this process alive", `/status` for "are the models
 * working"), and `GET /idle` for the restart gate. `/notify` does not: it needs a Chat client, so it
 * lives with the Chat adapter — this table answers that address with where to find it, because a
 * silent 404 there is how scheduled notifications stopped once before.
 */
import type http from "node:http";

import { handleV1 } from "../session-host/v1-routes.js";
import { logger } from "../logger.js";
import type { Config } from "../config.js";
import type { RouteTable } from "../shared/serve-routes.js";
import type { ActivityFeed } from "./activity.js";
import type { BridgeHost } from "./host.js";
import type { SessionHost } from "../session-host/api.js";

export interface HostRoutesDeps {
  /** The store, for the binding list `/v1` and `/idle` both read. */
  host: BridgeHost;
  /** The host's own seam — not a link: this process owns the store. */
  seam: SessionHost;
  /** Wakes a held poll when a turn starts. */
  activity: ActivityFeed;
  config: Config;
  /** Where the Chat adapter listens, for the `/notify` tombstone's hint. */
  chatPort: number;
  model: { provider: string; modelId: string };
}

const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

export function hostRoutes(deps: HostRoutesDeps): RouteTable {
  return async ({ req, res, url }) => {
    // `/v1`: the conversation protocol a second surface reads. Its own module so the shapes are
    // testable without a bridge, mounted here because this is already the process that owns the
    // store.
    if (
      await handleV1(req, res, url, {
        seam: deps.seam,
        activity: deps.activity,
        conversations: async () => {
          const bindings = await deps.host.bindings();
          return Object.entries(bindings.byChatKey).map(([chatKey, binding]) => ({
            conversationId: binding.conversationId,
            address: chatKey,
            ...(binding.name === undefined ? {} : { name: binding.name }),
            lastActivityAt: binding.updatedAt ?? binding.createdAt,
          }));
        },
        // The deployment's default model, so a caller that only knows an address can still start a
        // conversation. `main.ts` already resolved this for the probes above; passing it is what
        // removes the copy of `defaultSettings()` that was in `chat-host.ts`.
        defaultAgent: { model: deps.model },
        ...(deps.config.webToken ? { token: deps.config.webToken } : {}),
      })
    ) {
      return true;
    }

    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return true;
    }

    // GET /idle: is any turn running right now?
    //
    // Exists for the restart gate. "No child processes" is not the same question: an agent thinking
    // between tool calls looks idle for a minute at a time, so a gate built on process silence fires
    // mid-turn and kills the work it was trying to protect. Only conversations touched recently are
    // asked, because a dormant thread cannot be mid-turn and each answer costs a view snapshot.
    if (req.method === "GET" && url.pathname === "/idle") {
      const busy: number[] = [];
      const since = Date.now() - 24 * 60 * 60 * 1000;
      try {
        const bindings = await deps.host.bindings();
        for (const binding of Object.values(bindings.byChatKey)) {
          if ((binding.updatedAt ?? binding.createdAt) < since) continue;
          if ((await deps.seam.snapshot(binding.conversationId))?.busy === true) {
            busy.push(binding.conversationId);
          }
        }
      } catch (error) {
        // Cannot tell is not idle: a restart that guesses would kill a turn. This is the one 503 that
        // means "ask again", and it is deliberately not the same answer as "a turn is running".
        json(res, 503, { idle: false, error: (error as Error).message });
        return true;
      }
      json(res, busy.length === 0 ? 200 : 503, { idle: busy.length === 0, busy });
      return true;
    }

    // GET /status: is anything wrong with the *models*, as opposed to with us?
    //
    // `/healthz` answers "is this process alive", which stayed `ok` through an entire outage where
    // every turn died on a 402 — the bridge was up and useless, and nothing watching it could tell.
    // This answers the other question, from the record the failure sink keeps: 200 when no provider
    // is failing, 503 when one is persistent (a balance or a key), so a monitor can distinguish
    // "restart me" from "go and pay".
    if (req.method === "GET" && url.pathname === "/status") {
      let failures;
      try {
        failures = await deps.seam.modelFailures();
      } catch (error) {
        json(res, 500, { ok: false, error: (error as Error).message });
        return true;
      }
      const blocked = failures.filter((failure) => failure.persistent === true);
      json(res, blocked.length === 0 ? 200 : 503, {
        ok: blocked.length === 0,
        model: `${deps.model.provider}/${deps.model.modelId}`,
        failing: blocked.length > 0,
        failures,
      });
      return true;
    }

    // /notify is served by the Chat adapter, where the Chat client is. This answers with where to
    // find it rather than a bare 404: a silent one here is how scheduled notifications stopped once
    // before, and the cron jobs now point at the adapter (`cron/.env`), so this only catches an
    // address somebody still has from before.
    if (req.method === "POST" && url.pathname === "/notify") {
      json(res, 404, {
        ok: false,
        error: "notify is served by the Chat adapter",
        hint: `POST http://${deps.config.bindAddress}:${deps.chatPort}/notify`,
      });
      return true;
    }

    return false;
  };
}

/** The listener `main.ts` wraps around the table, so the failure line names this process. */
export const hostRouteFailure = (error: unknown, res: http.ServerResponse): void => {
  logger.error("[bridge] http handler failed:", (error as Error).message);
  if (!res.headersSent) {
    json(res, 500, { ok: false, error: (error as Error).message });
  }
};
