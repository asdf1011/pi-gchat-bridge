/**
 * A whole turn, over the protocol, end to end.
 *
 * The per-operation tests each passed while the *sequence* lied — the quote lost its prompt, then the
 * placeholder stopped opening, both in the seams between operations that were individually fine. This
 * is the one test that drives the sequence: a prompt is committed, a view goes busy, drafts arrive,
 * the turn settles, and the answer is what the painter posts.
 *
 * It runs against a real HTTP server speaking `/v1` and the real `observeTurn` loop. What is faked is
 * the harness underneath (no model, no store): the point is the protocol and the loop, not the agent.
 */
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import type { AddressInfo } from "node:net";

import { handleV1 } from "../src/adapter/v1-routes.js";
import { observeTurn } from "../src/durable/observe.js";
import type { SessionHost } from "../src/session-host/api.js";

/** A conversation whose turn is driven by the test, one step at a time. */
function turnHost() {
  const messages: { entryId: number; role: "user" | "assistant"; text: string; at?: number; origin?: string }[] = [];
  const frames = new Set<(view: unknown) => void>();
  const state = { liveText: "", busy: false };
  const view = () => ({ liveText: state.liveText, busy: state.busy, lastAssistantText: "", tools: [] });
  const publish = (): void => {
    for (const frame of frames) frame(view());
  };

  const seam = {
    snapshot: async () => view(),
    attach: async (_id: number, onFrame: (view: unknown) => void) => {
      frames.add(onFrame);
      return {
        snapshot: view(),
        detach: () => frames.delete(onFrame),
      };
    },
    history: async (_id: number, options?: { limit?: number; offset?: number }) => {
      const limit = options?.limit ?? 50;
      const offset = options?.offset ?? 0;
      const end = Math.max(0, messages.length - offset);
      return messages.slice(Math.max(0, end - limit), end);
    },
    list: async () => [{ conversationId: 7, name: "spaces/S/threads/T", model: "deepseek/flash", createdAt: 1 }],
  } as unknown as SessionHost;

  return {
    seam,
    /** The handler's half: a prompt is written and the turn begins. */
    async prompt(text: string, origin = "gchat") {
      messages.push({ entryId: 100, role: "user", text, origin, at: 1 });
      state.busy = true;
      publish();
    },
    /** A draft the model committed: no entry, only a view change. */
    async draft(text: string) {
      state.liveText = text;
      publish();
    },
    /** The turn ends: the answer is committed, then the view goes idle. */
    async answer(text: string, entryId = 101) {
      messages.push({ entryId, role: "assistant", text, origin: "gchat", at: 2 });
      state.liveText = "";
      state.busy = false;
      publish();
    },
  };
}

async function serve(seam: SessionHost): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void handleV1(req, res, url, {
      seam,
      conversations: async () => [{ conversationId: 7, address: "spaces/S/threads/T" }],
    })
      .then((handled) => {
        if (!handled && !res.headersSent) {
          res.writeHead(404);
          res.end("unhandled");
        }
      })
      .catch((error: unknown) => {
        if (!res.headersSent) res.writeHead(500);
        res.end(String(error));
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const settle = async (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

test("a turn arrives as frames, settles once, and its answer arrives as an entry", async () => {
  const host = turnHost();
  const served = await serve(host.seam);
  const frames: { liveText: string; busy: boolean }[] = [];
  const entries: { entryId: number; text: string }[] = [];
  let settled = 0;
  const stop = new AbortController();
  try {
    observeTurn(
      {
        baseUrl: served.baseUrl,
        conversationId: 7,
        since: () => (entries.at(-1)?.entryId ?? 0),
        // Short waits on purpose: a poll answers *state*, so an edge that lands between two requests
        // is caught by the next one. A real deployment holds for 25s, but nothing here needs that.
        waitSeconds: 0.3,
        onFrame: (view) => frames.push({ liveText: view.liveText, busy: view.busy }),
        onSettled: () => (settled += 1),
        onEntries: (rows) => {
          for (const row of rows) entries.push({ entryId: row.entryId, text: row.text });
        },
      },
      stop.signal,
    );
    await settle(50);

    await host.prompt("hello");
    await settle(100);
    await host.draft("half an ans");
    await settle(100);
    await host.draft("half an answer");
    await settle(100);
    await host.answer("half an answer, finished");
    await settle(400);

    // The draft crossed as a view, not as an entry: two different channels for two different things.
    assert.ok(
      frames.some((frame) => frame.busy && frame.liveText === "half an answer"),
      `the draft arrived as a frame: ${JSON.stringify(frames)}`,
    );
    assert.equal(settled, 1, "the settle edge fired once, not per frame");
    assert.deepEqual(
      entries.map((entry) => entry.text),
      ["hello", "half an answer, finished"],
      "the prompt and the answer are entries; the drafts are not",
    );
    assert.deepEqual(
      entries.map((entry) => entry.entryId),
      [100, 101],
      "and each arrives once, in order",
    );
  } finally {
    stop.abort();
    await served.close();
  }
});

test("a watch that never sees a turn ends itself instead of polling for ever", async () => {
  // The case the old `busy` check was for: a prompt consumed for a turn that never started. The
  // deadline is the honest answer — nothing else would ever end the watch.
  const host = turnHost();
  const served = await serve(host.seam);
  let settled = 0;
  const stop = new AbortController();
  try {
    observeTurn(
      {
        baseUrl: served.baseUrl,
        conversationId: 7,
        since: () => 0,
        waitSeconds: 0.2,
        startGraceMs: 100,
        onFrame: () => {},
        onSettled: () => (settled += 1),
      },
      stop.signal,
    );
    await settle(600);
    assert.equal(settled, 1, "the watch gave up and said so");
  } finally {
    stop.abort();
    await served.close();
  }
});
