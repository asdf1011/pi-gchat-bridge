/**
 * Cutting the part of a picture a person pointed at out of the picture.
 *
 * A comment on a region of an image has to show that region, not only describe it.
 * The rectangle is in the file's own pixels, so the crop is the file's own pixels
 * too — no scaling, no resampling, nothing between what was drawn on screen and what
 * a model is handed.
 *
 * Photon (Rust in WebAssembly, already a dependency of pi-durable for `read`) does
 * the decode and the crop, and it is initialised lazily: the wasm module costs a few
 * hundred kilobytes of memory that a deployment which never comments on a picture
 * should not pay for at startup. Its rectangle output is PNG whatever the source
 * format was, which is one of the four types every provider takes inline.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type { Region } from "../durable/comments.js";
import { logger } from "../logger.js";

/** Formats Photon decodes. SVG is not among them, and it is not an image this viewer draws. */
const DECODABLE = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-icon",
]);

/** A type Photon can decode by its own signature, as far as the module reports. */
interface PhotonModule {
  initSync(input: { module: Uint8Array }): void;
  PhotonImage: {
    new_from_byteslice(bytes: Uint8Array): PhotonImageLike;
  };
  crop(image: PhotonImageLike, x1: number, y1: number, x2: number, y2: number): PhotonImageLike;
}

interface PhotonImageLike {
  get_width(): number;
  get_height(): number;
  /** PNG-encoded bytes. */
  get_bytes(): Uint8Array;
  free(): void;
}

let photon: PhotonModule | undefined;
let photonFailed = false;

/**
 * Photon, loaded once, or `undefined` if it cannot be loaded here.
 *
 * A deployment without the wasm file (a single-file build, a stripped image) can
 * still comment on pictures: the comment keeps its rectangle and only the attached
 * crop is missing. That is the right failure — losing the words would be worse than
 * losing the picture.
 */
function loadPhoton(): PhotonModule | undefined {
  if (photon !== undefined || photonFailed) return photon;
  try {
    const require = createRequire(import.meta.url);
    // `require`, not `import()`: the package declares only `module`, and Node resolves
    // it through `createRequire` the same way pi-durable's own image path does.
    const module = require("@silvia-odwyer/photon/photon_rs.js") as PhotonModule;
    module.initSync({ module: readFileSync(require.resolve("@silvia-odwyer/photon/photon_rs_bg.wasm")) });
    photon = module;
    return photon;
  } catch (error) {
    photonFailed = true;
    logger.error(`[artifacts] image cropping unavailable: ${(error as Error).message}`);
    return undefined;
  }
}

export interface Cropped {
  bytes: Buffer;
  mimeType: string;
  width: number;
  height: number;
}

/**
 * The rectangle of `bytes` the region describes, as a PNG.
 *
 * `undefined` on anything that is not a decodable picture: a `.png` that holds text is
 * a file the browser would not draw either, and pretending to crop it would produce
 * an attachment of noise. The caller treats that as "no crop", not as an error — the
 * comment is still about a rectangle of the file.
 *
 * The region has already been clamped to the picture by `normalizeRegion`; the clamp
 * is repeated here because this function is the one that would index past the end of
 * the decoded pixels, and a wasm panic is not an error boundary.
 */
export function cropRegion(bytes: Buffer, mimeType: string, region: Region): Cropped | undefined {
  if (!DECODABLE.has(mimeType)) return undefined;
  const module = loadPhoton();
  if (module === undefined) return undefined;

  let image: PhotonImageLike | undefined;
  let cropped: PhotonImageLike | undefined;
  try {
    image = module.PhotonImage.new_from_byteslice(new Uint8Array(bytes));
    const width = image.get_width();
    const height = image.get_height();
    if (width < 1 || height < 1) return undefined;
    const left = Math.max(0, Math.min(region.x, width - 1));
    const top = Math.max(0, Math.min(region.y, height - 1));
    const right = Math.max(left + 1, Math.min(region.x + region.width, width));
    const bottom = Math.max(top + 1, Math.min(region.y + region.height, height));
    cropped = module.crop(image, left, top, right, bottom);
    const png = Buffer.from(cropped.get_bytes());
    return { bytes: png, mimeType: "image/png", width: cropped.get_width(), height: cropped.get_height() };
  } catch (error) {
    logger.error(`[artifacts] could not crop a region: ${(error as Error).message}`);
    return undefined;
  } finally {
    // Photon's images live in wasm memory that never shrinks while the process does;
    // a crop and its source are two copies of the picture, so both are freed.
    try {
      cropped?.free();
    } catch {
      // Already gone: freeing is not worth failing over.
    }
    try {
      image?.free();
    } catch {
      // Same.
    }
  }
}
