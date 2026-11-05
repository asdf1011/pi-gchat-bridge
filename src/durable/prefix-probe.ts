import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { BridgeHost } from "./host.js";
import { defaultSettings } from "../adapter/commands.js";
import { inProcessSessionHost } from "../session-host/inprocess.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pfx-"));
const host = await BridgeHost.open({ dbPath: path.join(dir, "p.sqlite"), cwd: process.cwd() });
const seam = inProcessSessionHost({ host, roots: [] });
const d = await defaultSettings(seam);
const model = { provider: d.provider!, modelId: d.modelId! };

for (const key of ["probe/a", "probe/b"]) {
  const bound = await host.conversationFor(key, { model });
  await bound.conversation.submit({ type: "input", content: [{ type: "text", text: "hi" }] }, host.context).then((s) => s.wait(host.context));
  const view = await bound.conversation.viewState(host.context);
  const systems = (view.value.entries ?? []).filter((e: any) => (e.kind ?? "").includes("system") || (e.model?.[0]?.role === "system"));
  console.log(`\n== ${key} == entries=${(view.value.entries ?? []).length} system-ish=${systems.length}`);
  console.log("  docs:", Object.keys(view.value.docs ?? {}).join(","));
  for (const e of systems.slice(0, 3)) {
    const c = e.model?.[0]?.content;
    const t = typeof c === "string" ? c : (Array.isArray(c) ? c.map((b: any) => b.text ?? "").join("") : "");
    console.log(`  kind=${e.kind} len=${t.length} keys=${JSON.stringify(Object.keys(e))} modelRole=${e.model?.[0]?.role}`);
  }
}
await host.close(); fs.rmSync(dir, { recursive: true, force: true });
