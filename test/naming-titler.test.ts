/**
 * The titler call, through the durable path.
 *
 * There are two implementations of "ask the titler for a title" — the legacy one
 * and the durable one — and only the legacy one passed the API key, so a hosted
 * titler answered 401 from the durable path while working everywhere else. This
 * pins the key to the request for the path that actually runs.
 */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { summarizeConversationTopic } from "../src/durable/topic.js";

test("the durable titler sends the configured key", async () => {
  const seen: { authorization?: string; body?: string } = {};
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.authorization = req.headers.authorization;
      seen.body = body;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "Disk images" } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;

  try {
    const title = await summarizeConversationTopic(
      { userText: "how do I shrink a disk image", assistantText: "truncate" },
      { baseUrl: `http://127.0.0.1:${port}/v1`, model: "m", timeoutMs: 5000, apiKey: "test-key" },
    );
    assert.equal(title, "Disk images");
    assert.equal(seen.authorization, "Bearer test-key", "a hosted titler needs the key, or it answers 401");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("no key means no authorization header, for the local titler", async () => {
  let authorization: string | undefined = "unset";
  const server = http.createServer((req, res) => {
    authorization = req.headers.authorization;
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "Title" } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    await summarizeConversationTopic(
      { userText: "hello", assistantText: "hi" },
      { baseUrl: `http://127.0.0.1:${port}/v1`, model: "m", timeoutMs: 5000 },
    );
    assert.equal(authorization, undefined, "llama.cpp takes no auth; an empty header is noise");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
