/**
 * model-call.mjs — POST a chat completion to an OpenAI-compatible endpoint.
 *
 * Mirrors the transport in `pi-gchat-bridge/src/topic-summary.ts` on purpose: the
 * eval must talk to the model the same way production does, or the numbers mean
 * nothing. That transport is NOT `fetch` — llama.cpp buffers the whole
 * completion and sends response headers only at the END, and undici aborts after
 * a 300s `headersTimeout`, which a slow CPU model exceeds on every image prompt.
 * Using fetch here would score a timeout as a model failure.
 */

import http from "node:http";
import https from "node:https";

export function postJson(url, body, timeoutMs) {
  const target = new URL(url);
  const transport = target.protocol === "https:" ? https : http;
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = transport.request(
      target,
      {
        method: "POST",
        // No connection pooling: llama.cpp closes the socket after a buffered
        // response, and node's keep-alive agent will happily reuse the dead one
        // for the next request — failing that request instantly with "socket
        // hang up". Seen here as every second case failing.
        agent: false,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) return reject(new Error(`HTTP ${status}: ${text.slice(0, 200)}`));
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error(`unparsable response: ${text.slice(0, 200)}`));
          }
        });
        res.on("error", reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`)));
    req.on("error", reject);
    req.end(payload);
  });
}
