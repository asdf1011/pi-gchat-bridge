import test from "node:test";
import assert from "node:assert/strict";

import { runCommand } from "../src/adapter/command-surface.js";
import type { ModelInfo, SessionHost } from "../src/session-host/api.js";

/**
 * The command surface, driven without a surface.
 *
 * These assert *shapes*, which is the whole claim of the design: a command answers with text, a list,
 * a choice or a form, and every surface renders those four. So the tests care that `/model` with no
 * arguments is a form carrying both the model and the thinking level — not that it is a card, or a
 * sentence, or a panel.
 */

const models: ModelInfo[] = [
  { provider: "deepseek", id: "deepseek-chat", label: "deepseek-chat", thinkingLevels: ["off", "low", "medium"] },
  { provider: "anthropic", id: "claude-sonnet-4", label: "Claude Sonnet 4", thinkingLevels: ["off", "low", "high"] },
];

interface Fake {
  seam: SessionHost;
  calls: { setModel: unknown[]; bind: unknown[]; create: unknown[]; label: unknown[]; compact: unknown[]; abort: number };
}

function fakeSeam(overrides: Partial<Record<keyof SessionHost, unknown>> = {}): Fake {
  const calls: Fake["calls"] = { setModel: [], bind: [], create: [], label: [], compact: [], abort: 0 };
  const seam = {
    state: async () => ({
      conversationId: 7,
      model: "deepseek/deepseek-chat",
      provider: "deepseek",
      modelId: "deepseek-chat",
      thinkingLevel: "medium",
      usage: { input: 1200, output: 340, cacheRead: 0, cacheWrite: 0, total: 1540, cost: 0.0123 },
      entries: 42,
    }),
    models: async () => models,
    list: async () => [
      { conversationId: 7, name: "web:here", label: "this one", model: "deepseek/deepseek-chat", createdAt: 1, lastActivityAt: 2 },
      { conversationId: 9, name: "web:there", preview: "hello there", model: "anthropic/claude-sonnet-4", createdAt: 1, lastActivityAt: 3 },
    ],
    setModel: async (...args: unknown[]) => {
      calls.setModel.push(args);
      return { model: "anthropic/claude-sonnet-4", thinkingLevel: "high" };
    },
    bind: async (...args: unknown[]) => {
      calls.bind.push(args);
      return { conversationId: 9, name: "web:here", model: "anthropic/claude-sonnet-4", createdAt: 1 };
    },
    create: async (...args: unknown[]) => {
      calls.create.push(args);
      return { conversationId: 12, name: "web:here", model: "deepseek/deepseek-chat", createdAt: 1 };
    },
    // The view is where "is something running" comes from: `/abort` asks it, because `abort` itself
    // is idempotent and only reports whether the conversation exists.
    snapshot: async () => ({ liveText: "", busy: false, lastAssistantText: "", tools: [] }),
    quota: async () => [
      { provider: "deepseek", models: ["flash"], paid: true, queried: true, available: true, balance: "12.40 CNY", topUpUrl: "https://platform.deepseek.com/top_up" },
      { provider: "local", models: ["tiny"], paid: false, queried: false, note: "no quota API" },
    ],
    label: async (...args: unknown[]) => {
      calls.label.push(args);
      return true;
    },
    compact: async (...args: unknown[]) => {
      calls.compact.push(args);
    },
    abort: async () => {
      calls.abort += 1;
      return true;
    },
    ...overrides,
  } as unknown as SessionHost;
  return { seam, calls };
}

const subject = { conversationId: 7, name: "web:here" };

test("/help is a list of commands, each one clickable", async () => {
  const { seam } = fakeSeam();
  const response = await runCommand(seam, subject, { text: "/help" });
  assert.equal(response.kind, "list");
  assert.ok(response.kind === "list");
  const labels = response.rows.map((row) => row.label);
  assert.ok(labels.includes("/status"), labels.join(", "));
  // Every row carries the command it runs, so a surface renders one button per command and needs to
  // know none of their names.
  assert.ok(response.rows.every((row) => typeof row.command === "string" && row.command.startsWith("/")));
});

test("/status is text, and says the things a status is for", async () => {
  const { seam } = fakeSeam();
  const response = await runCommand(seam, subject, { text: "/status" });
  assert.equal(response.kind, "text");
  assert.ok(response.kind === "text");
  assert.match(response.text, /deepseek\/deepseek-chat/);
  assert.match(response.text, /thinking medium/);
  assert.match(response.text, /Messages: 42/);
  assert.match(response.text, /Cost: \$0\.01/);
});

test("/model with no arguments is one form with both choices", async () => {
  // The design decision, in a test: model and thinking level are one decision asked once. Two
  // questions in sequence is a state machine in every surface, and the second depends on the first.
  const { seam } = fakeSeam();
  const response = await runCommand(seam, subject, { text: "/model" });
  assert.equal(response.kind, "form");
  assert.ok(response.kind === "form");
  assert.equal(response.command, "/model");
  const byId = new Map(response.fields.map((field) => [field.id, field]));
  assert.deepEqual([...byId.keys()], ["model", "thinking"]);

  const modelField = byId.get("model")!;
  assert.equal(modelField.kind, "select");
  assert.equal(modelField.value, "deepseek/deepseek-chat", "the current model is the selected one");
  assert.deepEqual(
    modelField.options?.map((option) => option.id),
    ["deepseek/deepseek-chat", "anthropic/claude-sonnet-4"],
  );

  const thinkingField = byId.get("thinking")!;
  // The union, because a form cannot re-render when a dropdown changes: the choice is checked on
  // submit instead, and "high" is only offered by one of the two models.
  assert.deepEqual(thinkingField.options?.map((option) => option.id), ["off", "low", "medium", "high"]);
  assert.equal(thinkingField.value, "medium");
});

test("submitting the form applies both answers in one call", async () => {
  const { seam, calls } = fakeSeam();
  const response = await runCommand(seam, subject, {
    text: "/model",
    values: { model: "anthropic/claude-sonnet-4", thinking: "high" },
  });
  assert.equal(response.kind, "text");
  assert.deepEqual(calls.setModel[0], [
    "web:here",
    { provider: "anthropic", modelId: "claude-sonnet-4", thinkingLevel: "high" },
  ]);
  assert.match(response.kind === "text" ? response.text : "", /claude-sonnet-4.*thinking high/);
});

test("a thinking level the chosen model does not have is refused with the ones it does", async () => {
  // A dropdown offered "high"; deepseek-chat has no such level. The refusal is data — a text response
  // the surface already knows how to render — and it lists the alternatives.
  const { seam, calls } = fakeSeam();
  const response = await runCommand(seam, subject, {
    text: "/model",
    values: { model: "deepseek/deepseek-chat", thinking: "high" },
  });
  assert.equal(response.kind, "text");
  const text = response.kind === "text" ? response.text : "";
  assert.match(text, /does not support thinking level "high"/);
  assert.match(text, /off, low, medium/);
  assert.equal(calls.setModel.length, 0, "nothing was applied");
});

test("a typed model name is matched, and an ambiguous or unknown one gets a clickable list", async () => {
  const { seam, calls } = fakeSeam();
  await runCommand(seam, subject, { text: "/model claude-sonnet-4" });
  assert.deepEqual(
    (calls.setModel[0] as unknown[])[1],
    { provider: "anthropic", modelId: "claude-sonnet-4" },
    "a bare id is enough when only one model has it",
  );

  const unknown = await runCommand(seam, subject, { text: "/model gpt-9" });
  assert.equal(unknown.kind, "list");
  assert.ok(unknown.kind === "list");
  assert.match(unknown.title ?? "", /gpt-9/);
  assert.ok(unknown.rows.every((row) => row.command?.startsWith("/model ")));
});

test("/sessions lists conversations, marks this one, and each row resumes its own", async () => {
  const { seam } = fakeSeam();
  const response = await runCommand(seam, subject, { text: "/sessions" });
  assert.equal(response.kind, "list");
  assert.ok(response.kind === "list");
  assert.equal(response.rows.length, 2);
  assert.deepEqual(
    response.rows.map((row) => row.command),
    ["/resume 7", "/resume 9"],
  );
  assert.equal(response.rows[0]!.current, true, "the conversation being read is marked");
  assert.match(response.rows[1]!.label, /hello there/, "an unnamed conversation shows what it started with");
});

test("/resume binds by name and says where it went", async () => {
  const { seam, calls } = fakeSeam();
  const response = await runCommand(seam, subject, { text: "/resume 9" });
  assert.deepEqual(calls.bind[0], ["web:here", 9]);
  assert.equal(response.kind === "text" ? response.goto : undefined, 9, "the surface is told where to go");
});

test("/new starts a conversation on the model already in use", async () => {
  const { seam, calls } = fakeSeam();
  const response = await runCommand(seam, subject, { text: "/new" });
  assert.deepEqual(calls.create[0], [
    "web:here",
    { model: { provider: "deepseek", modelId: "deepseek-chat" }, thinkingLevel: "medium" },
  ]);
  assert.equal(response.kind === "text" ? response.goto : undefined, 12);
});

test("the small commands answer in text and actually call the host", async () => {
  const { seam, calls } = fakeSeam();
  assert.match((await runCommand(seam, subject, { text: "/name research notes" })).kind, /^text$/);
  assert.deepEqual(calls.label[0], ["web:here", "research notes"]);

  await runCommand(seam, subject, { text: "/compact keep the decisions" });
  assert.deepEqual(calls.compact[0], [7, "keep the decisions"]);

  const idle = await runCommand(seam, subject, { text: "/abort" });
  assert.equal(idle.kind === "text" ? idle.text : "", "Nothing was running.");
  assert.equal(calls.abort, 0, "and nothing was stopped, because nothing was running");

  const { seam: busySeam, calls: busyCalls } = fakeSeam({
    snapshot: async () => ({ liveText: "…", busy: true, lastAssistantText: "", tools: [] }),
  });
  const busy = await runCommand(busySeam, subject, { text: "/abort" });
  assert.equal(busy.kind === "text" ? busy.text : "", "Stopped.");
  assert.equal(busyCalls.abort, 1);
});

test("an unknown command is a list of the real ones, not an error", async () => {
  const { seam } = fakeSeam();
  const response = await runCommand(seam, subject, { text: "/frobnicate" });
  assert.equal(response.kind, "list");
  assert.ok(response.kind === "list");
  assert.match(response.title ?? "", /No command called \/frobnicate/);
  assert.ok(response.rows.some((row) => row.label === "/status"));
});

test("an empty line is help, because a surface may submit one", async () => {
  const { seam } = fakeSeam();
  const response = await runCommand(seam, subject, { text: "   " });
  assert.equal(response.kind, "list");
});

test("/quota is a list of providers, with what each one has left", async () => {
  // The command existed in Chat and not here, which is how a command set drifts: one surface grows a
  // command and the others quietly do not have it. The check itself is the seam's, since it reads
  // `models.json` and calls the providers.
  const { seam } = fakeSeam();
  const response = await runCommand(seam, subject, { text: "/quota" });
  assert.equal(response.kind, "list");
  assert.ok(response.kind === "list");
  assert.deepEqual(
    response.rows.map((row) => row.label),
    ["deepseek (paid)", "local (free)"],
  );
  assert.match(response.rows[0]!.detail ?? "", /12\.40 CNY/);
  assert.match(response.rows[0]!.detail ?? "", /top_up/, "a paid provider says where to add credit");
  assert.match(response.rows[1]!.detail ?? "", /no quota API/, "and an unqueried one says why");
});
