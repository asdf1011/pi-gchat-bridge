/**
 * M2 smoke test: the harness host, end to end, from the command line.
 *
 *   npx tsx src/durable/smoke.ts <db> <chatKey> <provider/modelId> "<prompt>"
 *
 * Run it twice with the same db and chatKey: the second run must reuse the same
 * conversation (bindings document) and must not re-answer the same prompt
 * (`requestId`). That is the whole content of M2's exit criteria — the parts
 * that will later be driven by Google Chat events are driven by argv here.
 */
import { AssistantEntry } from "@earendil-works/pi-durable";

import { BridgeHost, parseModelRef } from "./host.js";

const [dbPath, chatKey, modelRef, prompt] = process.argv.slice(2);
if (!dbPath || !chatKey || !modelRef || !prompt) {
  console.error('usage: smoke.ts <db> <chatKey> <provider/modelId> "<prompt>"');
  process.exit(2);
}

const textOf = (message: any): string =>
  (message?.content ?? [])
    .flatMap((block: any) => (block.type === "text" ? [block.text] : []))
    .join("");

const host = await BridgeHost.open({
  dbPath,
  cwd: process.env.PI_CWD ?? "/workspace",
});

const { conversation, binding } = await host.conversationFor(chatKey, {
  model: parseModelRef(modelRef),
  thinkingLevel: (process.env.SMOKE_THINKING as never) ?? undefined,
});
console.log(`[bind] ${chatKey} -> conversation ${binding.conversationId} (${binding.model})`);

// The Chat sink's future input: watch the view and paint the partial answer.
const view = await conversation.viewState(host.context);
let painted = "";
view.subscribe((value: any) => {
  const partial = textOf(value?.docs?.["pi.live"]?.generation?.message);
  if (partial !== painted) {
    painted = partial;
  }
});

const requestId = `smoke-${Buffer.from(prompt).toString("base64url").slice(0, 24)}`;
const submission = await conversation.submit(
  { type: "input", content: prompt, requestId },
  host.context,
);
console.log(`[submit] requestId=${requestId} submission=${submission.id}`);
const settled = await submission.wait(host.context);
console.log(`[submit] settled: ${settled.status}`);

const answer = await conversation.commit(
  (tx: any) => tx.entry(AssistantEntry, settled.answer),
  host.context,
);
console.log(`[answer] ${JSON.stringify(textOf(answer?.model?.[0]).slice(0, 200))}`);

const all = await host.bindings();
console.log(`[bindings] ${Object.keys(all.byChatKey).length} key(s):`, JSON.stringify(all.byChatKey[chatKey]));

view.dispose();
await host.close();
console.log("[done]");
