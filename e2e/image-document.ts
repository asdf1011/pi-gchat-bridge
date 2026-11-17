/**
 * The artifact documents, for tests that need the real gesture.
 *
 * **These call the server's own builders.** They used to be hand-written copies of the
 * document markup and CSS, and they drifted twice: once carrying duplicate rules from an
 * earlier layout that made a browser test measure a bug existing only in the fixture, and
 * once still advertising `pinch-zoom` after the real document had stopped. Both produced
 * confident green tests about a page nobody had ever shipped.
 *
 * The copy existed because the page under test is stubbed at the network — no bridge, no
 * artifact origin, only `page.route` — so there was no server to ask. But the *builders* need
 * no server: `imageDocument` is a pure function from a key and a nonce to HTML, and it is
 * exported for exactly this. The tests now serve what the origin serves, and a change to the
 * document shape reaches them without anyone remembering to copy it across.
 */
import { imageDocument, pageControls } from "../src/web/artifacts-server.js";

/** The document the artifact origin serves for a picture. */
export function imageDocumentFor(key: string): string {
  const name = key.split("/").at(-1) ?? key;
  return imageDocument({ key, href: `${name}?raw`, nonce: "test-nonce" });
}

/**
 * The document the artifact origin serves for one page of a PDF.
 *
 * The paging strip is built by the server (`pageControls`), so a test that clicks "next page"
 * is clicking the control that ships rather than a plausible-looking stand-in.
 */
export function pdfPageDocumentFor(key: string, page: number, pageCount: number): string {
  const name = key.split("/").at(-1) ?? key;
  return imageDocument({
    key,
    href: `${name}?page=${page}&png`,
    note: `page ${page} of ${pageCount}`,
    // The strip the server builds, so a test clicking "next page" clicks the real control.
    controls: pageControls(key, page, pageCount),
    nonce: "test-nonce",
  });
}
