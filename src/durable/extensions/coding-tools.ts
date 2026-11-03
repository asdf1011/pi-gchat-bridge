/**
 * The bridge's tool set: pi-durable's coding tools, with bash wired for secret
 * delivery.
 *
 * `CodingTools` is `createBashTool()` with no options, and a `ToolRegistration`
 * carries no options bag — `prepare` is a closure captured by `createBashTool`.
 * So wrapping the finished tool cannot add it: the tool set is rebuilt here with
 * the one option that matters.
 *
 * Everything else stays exactly as pi-durable ships it. Keeping the list explicit
 * rather than `[...CodingTools.tools, bash]` is deliberate: if pi-durable adds a
 * tool upstream, this will not silently include it, and that is the safer failure
 * for a set that is exposed to a model with shell access.
 */
import { defineExtension } from "@earendil-works/pi-durable";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-durable/tools";

import { makePrepare, type DeliveryOptions } from "./deliver.js";

export function createCodingToolsWithDelivery(options: DeliveryOptions) {
  return defineExtension({
    name: "coding-tools",
    tools: [
      createReadTool(),
      createWriteTool(),
      createEditTool(),
      // The only difference from pi-durable's CodingTools.
      createBashTool({ prepare: makePrepare(options) }),
    ],
  });
}
