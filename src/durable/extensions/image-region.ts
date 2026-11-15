/**
 * The one tool an agent has for looking at the part of a picture a person pointed at.
 *
 * **Why a tool at all.** A comment on a region of an image carries a rectangle, and a
 * rectangle is an address — but the person is looking at a crop, and a model that only
 * receives four numbers is being told about a picture instead of shown one. So the crop
 * is attached to the comment's message as an image for the models that can see, and
 * this tool exists for the rest of the story: a model that cannot see the attachment,
 * or that wants the region *fresh* after the file changed, can ask for it by name.
 *
 * The rectangle is the comment's own, and the reading is done through the artifact
 * origin (a URL), never from a path the model supplies: an artifact key is the only
 * thing that resolves, and the origin applies the same allow-list it serves everything
 * with. That is the whole reason this takes a comment id rather than coordinates.
 */
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { Type } from "typebox";

/** A cropped region, as the artifact origin serves it. */
export interface CroppedRegion {
  /** Base64 bytes — what an `ImageContent` part carries. */
  data: string;
  mimeType: string;
  width: number;
  height: number;
}

/** What the tool needs from the host: the comment's rectangle and the picture's bytes. */
export interface ImageRegionTarget {
  /**
   * The rectangle a comment names, and the file it names it in.
   *
   * `undefined` when the id is unknown, or when the comment is not about a region —
   * both are answers a model can act on, not errors.
   */
  regionOf(
    conversationId: number,
    commentId: string,
  ): Promise<
    | { file: string; x: number; y: number; width: number; height: number; imageWidth: number; imageHeight: number }
    | undefined
  >;
  /** That rectangle, cut out of the picture. `undefined` when it cannot be decoded. */
  crop(conversationId: number, file: string, region: { x: number; y: number; width: number; height: number }): Promise<CroppedRegion | undefined>;
}

export function createImageRegionTools(target: ImageRegionTarget) {
  return defineExtension({
    name: "image-region",
    tools: [
      defineTool({
        name: "view_image",
        description:
          "Look at the part of a picture a review comment is about. Takes the comment id from the comment " +
          "you were sent; it returns that exact rectangle of the image as a picture. Use it when the comment " +
          "mentions a region you cannot see in the message — a model with image input usually already has the " +
          "crop attached, and does not need this.",
        parameters: Type.Object({
          commentId: Type.String({
            description: "The id shown in the comment you were sent, e.g. `2f4f5da0`.",
          }),
        }),
        // A read: rerunning it after a restart costs a decode and changes nothing.
        replay: "safe",
        async execute(args, api) {
          const conversationId = api.conversationId as unknown as number;
          const region = await target.regionOf(conversationId, args.commentId);
          if (region === undefined) {
            return {
              output: [
                {
                  type: "text" as const,
                  text: `Comment ${args.commentId} is not a selection of an image, or no longer exists.`,
                },
              ],
              isError: true,
            };
          }
          const cropped = await target
            .crop(conversationId, region.file, region)
            .catch(() => undefined);
          const describe = `The ${region.width}x${region.height} region at (${region.x}, ${region.y}) of ${region.file}.`;
          if (cropped === undefined) {
            return {
              output: [{ type: "text" as const, text: `${describe} It could not be decoded, so here is where it is.` }],
            };
          }
          // Two parts: the picture, and the sentence that says which part of which file
          // it is — a bare image leaves a model guessing at the larger picture.
          return {
            output: [
              { type: "text" as const, text: describe },
              { type: "image" as const, data: cropped.data, mimeType: cropped.mimeType },
            ],
          };
        },
      }),
    ],
    sections: [
      section("image_region", (input) => {
        // Only where the tool is on offer.
        if (!input.agent.tools.some((tool) => tool.name === "view_image")) return undefined;
        return [
          "`view_image` fetches the part of a picture a comment selected, as a picture.",
          "A comment on a region arrives with the crop already attached when the model can see images; `view_image` is for the rest.",
        ].join("\n");
      }),
    ],
  });
}
