import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { StateStore } from "../src/state.js";

function tempStateFile(): string {
  return `/tmp/pi-gchat-state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
}

test("topic cards are taken exactly once, so a card can't be re-titled", () => {
  const file = tempStateFile();
  try {
    const store = new StateStore(file);
    store.setTopicCard("spaces/S/threads/T", { messageName: "spaces/S/messages/M", modelLabel: "LFm (local)" });
    assert.deepEqual(store.takeTopicCard("spaces/S/threads/T"), {
      messageName: "spaces/S/messages/M",
      modelLabel: "LFm (local)",
    });
    // Gone: the next turn must not run the summarizer again.
    assert.equal(store.takeTopicCard("spaces/S/threads/T"), undefined);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("a pending topic card survives a restart (bridge may exit before the title lands)", () => {
  const file = tempStateFile();
  try {
    const first = new StateStore(file);
    first.setTopicCard("key", { messageName: "m1", modelLabel: "model" });
    // A fresh instance re-reads state.json, as after a restart.
    const second = new StateStore(file);
    assert.deepEqual(second.takeTopicCard("key"), { messageName: "m1", modelLabel: "model" });
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("topic cards survive alongside existing state (no clobbering of dedupe or resume state)", () => {
  const file = tempStateFile();
  try {
    const store = new StateStore(file);
    store.markProcessed("spaces/S", "spaces/S/messages/A");
    store.setResumeTarget("key", "/tmp/other.jsonl");
    store.setTopicCard("key", { messageName: "m1", modelLabel: "model" });
    store.save();

    const reopened = new StateStore(file);
    assert.deepEqual(reopened.getSpaceState("spaces/S").processed, ["spaces/S/messages/A"]);
    assert.equal(reopened.getResumeTarget("key"), "/tmp/other.jsonl");
    assert.equal(reopened.takeTopicCard("key")?.messageName, "m1");
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("an unreadable or legacy state file still yields an empty topic-card map", () => {
  const file = tempStateFile();
  try {
    // Pre-feature state.json: no topicCards key at all.
    fs.writeFileSync(file, JSON.stringify({ spaces: {}, resumeMap: {} }));
    const store = new StateStore(file);
    assert.equal(store.takeTopicCard("key"), undefined);
    store.setTopicCard("key", { messageName: "m1", modelLabel: "model" });
    assert.equal(store.takeTopicCard("key")?.messageName, "m1");
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("the pending topic-card map is bounded so it can't grow forever", () => {
  const file = tempStateFile();
  try {
    const store = new StateStore(file);
    for (let i = 0; i < 250; i++) {
      store.setTopicCard(`key-${i}`, { messageName: `m${i}`, modelLabel: "model" });
    }
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as { topicCards: Record<string, unknown> };
    assert.equal(Object.keys(saved.topicCards).length, 200);
    // Newest survive, oldest are dropped.
    assert.ok(saved.topicCards["key-249"]);
    assert.equal(saved.topicCards["key-0"], undefined);
  } finally {
    fs.rmSync(file, { force: true });
  }
});
