/**
 * End-to-end smoke test: one real prompt, one real model, one scratch database.
 *
 *   npx tsx src/durable/smoke.ts /tmp/smoke.sqlite smoke/1 deepseek/deepseek-flash "hello"
 *
 * Run it twice with the same db, chatKey and prompt. The second run must reuse
 * the same conversation (the binding) and must not re-answer the prompt (the
 * `requestId`), which are the two properties the whole harness exists for and
 * the two that are hardest to see from a unit test.
 *
 * It is a *diagnostic*, not a test: no Chat app, no Pub/Sub, no Pub/Sub
 * credentials, and it is the only path in this repository that exercises a real
 * model end to end. That is why it survives while the one-shot migration tools
 * did not — it answers "is this box's stack working?" in one command, and stays
 * useful for as long as there are models to call.
 *
 * Written against the seam on purpose: if this stops compiling, the seam changed
 * underneath every adapter.
 */
import { BridgeHost } from "./host.js";
import { parseModelRef } from "./host.js";
import { inProcessSessionHost } from "../session-host/inprocess.js";

const [dbPath, chatKey, modelRef, prompt] = process.argv.slice(2);
if (!dbPath || !chatKey || !modelRef || !prompt) {
  console.error('usage: smoke.ts <db> <chatKey> <provider/modelId> "<prompt>"');
  process.exit(2);
}

const host = await BridgeHost.open({
  dbPath,
  cwd: process.env.PI_CWD ?? "/workspace",
});
const seam = inProcessSessionHost({ host, roots: [] });

try {
  const conversation = await seam.getOrCreate(chatKey, {
    model: parseModelRef(modelRef),
    ...(process.env.SMOKE_THINKING === undefined ? {} : { thinkingLevel: process.env.SMOKE_THINKING }),
  });
  console.log(`[bind] ${chatKey} -> conversation ${conversation.conversationId} (${conversation.model})`);

  // Watch the answer arrive, the way a sink does: frames, then the settled text.
  const handle = await seam.attach(conversation.conversationId, (frame) => {
    if (frame.liveText) process.stdout.write(`\r[stream] ${frame.liveText.length} chars`);
  });
  console.log();

  const requestId = `smoke-${Buffer.from(prompt).toString("base64url").slice(0, 24)}`;
  const submitted = await seam.submit(conversation.conversationId, { content: prompt, requestId });
  if ("error" in submitted) throw new Error(submitted.error);
  console.log(`[submit] requestId=${requestId} submission=${submitted.submissionId}`);

  const settled = await seam.awaitSubmission(submitted.submissionId);
  console.log(`[settled] ${settled.status}${settled.status === "unanswered" ? ` (${settled.reason ?? "no reason"})` : ""}`);
  if (settled.status === "done") {
    console.log(`[answer] ${JSON.stringify(settled.text.slice(0, 200))}`);
  }

  handle?.detach();
  const bindings = await seam.list();
  console.log(`[bindings] ${bindings.length} key(s):`, JSON.stringify(await seam.resolve(chatKey)));
} finally {
  await host.close();
}
console.log("[done]");
