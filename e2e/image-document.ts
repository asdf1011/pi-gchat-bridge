/**
 * The image wrapper document, for tests that need the real gesture.
 *
 * Built from the same pieces the artifact origin interpolates (`REGION_SCRIPT`,
 * `SWIPE_SCRIPT`), so a test drives the code that ships rather than a stub with no
 * handlers — the failure mode that made swiping a picture look tested while doing
 * nothing on a phone.
 *
 * Written here rather than fetched from the server because the page under test is
 * stubbed at the network: no bridge, no artifact origin, only `page.route`.
 */
import { REGION_SCRIPT, SWIPE_SCRIPT } from "../src/web/artifacts-server.js";

export function imageDocumentFor(key: string): string {
  const name = key.split("/").at(-1) ?? key;
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
  :root { color-scheme: light dark; }
  html { touch-action: pan-y pinch-zoom; }
  html, body { height: 100%; box-sizing: border-box; }
  body { margin: 0; display: flex; align-items: center; justify-content: center;
         padding: 1rem; background: Canvas; color: CanvasText; }
  img { max-width: 100%; max-height: 100%; object-fit: contain; background: #8881; }
  img.crop-target { touch-action: none; cursor: crosshair; user-select: none; -webkit-user-select: none; }
  .marquee { position: fixed; pointer-events: none; border: 2px solid #4c9aff; background: #4c9aff33; }
</style></head>
<body data-file="${key}">
<img class="crop-target" src="${name}?raw" alt="${key}" draggable="false">
<script>${SWIPE_SCRIPT}</script>
<script>${REGION_SCRIPT}</script>
</body></html>`;
}

/**
 * The PDF page document, as the artifact origin builds it for `?page=N`.
 *
 * Same gesture surface as a picture — that is the whole point, since a page is a picture
 * once rendered — plus the paging strip, so a test can turn a page the way a reader does
 * and check that a comment lands on the page it was drawn on.
 */
export function pdfPageDocumentFor(key: string, page: number, pageCount: number): string {
  const name = key.split("/").at(-1) ?? key;
  const at = (n: number) => `${name}?page=${n}`;
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
  :root { color-scheme: light dark; }
  html { touch-action: pan-y pinch-zoom; }
  html, body { height: 100%; box-sizing: border-box; }
  body { margin: 0; display: flex; align-items: center; justify-content: center;
         padding: 1rem; background: Canvas; color: CanvasText; }
  img { max-width: 100%; max-height: 100%; object-fit: contain; background: #8881; }
  img.crop-target { touch-action: none; cursor: crosshair; user-select: none; -webkit-user-select: none; }
  .marquee { position: fixed; pointer-events: none; border: 2px solid #4c9aff; background: #4c9aff33; }
  .pages { position: fixed; bottom: 0; left: 0; right: 0; display: flex; gap: .5rem;
           align-items: center; justify-content: center; padding: .35rem; background: Canvas; }
</style></head>
<body data-file="${key}">
<nav class="pages">${
    page > 1 ? `<a href="${at(page - 1)}" rel="prev">← page ${page - 1}</a>` : "<a aria-disabled=\"true\">←</a>"
  }<span>page ${page} of ${pageCount}</span>${
    page < pageCount ? `<a href="${at(page + 1)}" rel="next">page ${page + 1} →</a>` : "<a aria-disabled=\"true\">→</a>"
  }</nav>
<img class="crop-target" src="${name}?page=${page}&amp;png" alt="${key}" draggable="false">
<p class="note">page ${page} of ${pageCount}</p>
<script>${SWIPE_SCRIPT}</script>
<script>${REGION_SCRIPT}</script>
</body></html>`;
}
