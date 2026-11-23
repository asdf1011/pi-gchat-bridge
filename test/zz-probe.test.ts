import { test } from "node:test";
import { JSDOM } from "jsdom";
import { WEB_PAGE } from "../src/web/sink.js";
test("probe", async () => {
  const dom = new JSDOM(WEB_PAGE, { url: "http://127.0.0.1:8081/7/", runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(win) { (win as unknown as Record<string, unknown>).fetch = async () => ({ ok: true, status: 200, json: async () => ({}) }); } });
  const f = dom.window.document.getElementById("speech-host") as HTMLIFrameElement;
  f.setAttribute("src", "/apps/7/webtalk/speech.html");
  const res: string[] = [];
  const t = Date.now();
  while (Date.now() - t < 30000) { await new Promise((r) => setTimeout(r, 500)); res.push("t " + (Date.now() - t) + " " + (f.contentWindow?.location?.href ?? "null")); if (res.length > 5) break; }
  console.log("result:", res.join(" | "));
  dom.window.close();
});
