/**
 * Rendering a page of a PDF to a PNG.
 *
 * The renderer is **PyMuPDF**, and it is a subprocess rather than a library because it
 * is a Python library: the converter that produced the artifact this feature was
 * designed from (`resume.tex` → `resume.pdf` → `resume-page1.png`) used exactly this,
 * `pymupdf.open(...).get_pixmap(dpi=150)`, and it is already installed on the host.
 * Adding a second PDF engine in Node to avoid `python3` would be a second thing to
 * keep working for no gain.
 *
 * What a page renders as is a picture, deliberately. A PDF is a *document*, and the
 * artifact origin's whole safety story is `default-src 'none'`: a page arrives as a
 * bitmap, so it cannot become a document that fetches, frames or runs anything. The
 * reader who wants the real PDF opens it in a tab (↗), where the browser's own viewer
 * gives them text selection, links and zoom — see `?raw` in `artifacts-server.ts`.
 *
 * Nothing here trusts the file: the page number is clamped, the output is capped in
 * pixels, and a timeout kills a render that will not finish. A PDF the agent wrote is
 * as untrusted as any other artifact.
 */
import { spawn } from "node:child_process";

import { logger } from "../logger.js";

/**
 * How long one page may take.
 *
 * PyMuPDF renders a normal page in tens of milliseconds; 20 s is a page so pathological
 * that showing nothing is the honest answer, and it bounds what a stuck process can
 * cost. The timer is on the whole subprocess, not on the pixel work, because the
 * failure being guarded is a hang (a corrupt file, a missing interpreter), not slowness.
 */
const RENDER_TIMEOUT_MS = 20_000;

/**
 * The most pixels one page may be.
 *
 * 40 megapixels is roughly an A4 page at 600 dpi — beyond it a "page" is a poster, and
 * the PNG is larger than anything worth sending to a model or drawing in a drawer. The
 * DPI is reduced rather than refusing, so an oversized page still renders, just
 * coarser.
 */
const MAX_PIXELS = 40_000_000;

/** The DPI a page is rendered at when it fits: legible when fitted to a drawer. */
const DEFAULT_DPI = 150;

/**
 * The Python that does the work.
 *
 * Written as a constant rather than a file in the repo because it is twenty lines that
 * exist only to be `exec`ed, and a `.py` file in `src/` would be a thing to move,
 * package and keep in step with this TypeScript for no benefit. Its contract is stdin
 * (a path and a page number) and stdout (a PNG on fd 1, a one-line error on fd 2).
 *
 * `sys.stdout.buffer` rather than `print`: the pixmap's bytes are binary, and `print`
 * would mangle them. The error path is a `SystemExit` with a message, so a caller gets
 * a non-zero exit and a reason instead of a traceback.
 */
const RENDER_SCRIPT = `
import sys
import pymupdf

path = sys.argv[1]
page_number = int(sys.argv[2])
max_pixels = int(sys.argv[3])
dpi = int(sys.argv[4])

try:
    document = pymupdf.open(path)
except Exception as error:
    print("cannot open: %s" % error, file=sys.stderr)
    raise SystemExit(3)

try:
    if page_number < 1 or page_number > document.page_count:
        print("no page %d (document has %d)" % (page_number, document.page_count), file=sys.stderr)
        raise SystemExit(4)

    page = document[page_number - 1]
    # Scaled by the page's own size, not fixed: an A4 and a slide deck want different
    # DPIs for the same pixel budget, and a page that would exceed the cap is rendered
    # at the largest DPI that fits rather than refused.
    width_inches = max(page.rect.width, 1.0) / 72.0
    height_inches = max(page.rect.height, 1.0) / 72.0
    fits = (dpi * width_inches) * (dpi * height_inches)
    if fits > max_pixels:
        dpi = max(1, int(dpi * ((max_pixels / fits) ** 0.5)))

    pixmap = page.get_pixmap(dpi=dpi)
    sys.stdout.buffer.write(pixmap.tobytes("png"))
    sys.stdout.buffer.flush()
finally:
    document.close()
`;

export interface RenderedPage {
  bytes: Buffer;
  width: number;
  height: number;
  /** How many pages the document has, so a viewer can say "page 1 of 3". */
  pageCount: number;
}

/** The width and height a PNG declares in its IHDR, without decoding it. */
function pngSize(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47) return undefined;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * One page of `file` as a PNG, or `undefined` when it cannot be rendered.
 *
 * `undefined` and not a throw: every caller is a viewer answering a request, and "this
 * page did not render" is an ordinary answer that should reach the reader as a 404
 * with a reason rather than as a 500. The reason is logged.
 */
export function renderPdfPage(
  file: string,
  page: number,
  options: { dpi?: number } = {},
): Promise<RenderedPage | undefined> {
  const pageNumber = Number.isFinite(page) ? Math.trunc(page) : 1;
  const dpi = options.dpi ?? DEFAULT_DPI;

  return new Promise((resolve) => {
    const child = spawn(
      "python3",
      ["-c", RENDER_SCRIPT, file, String(pageNumber), String(MAX_PIXELS), String(dpi)],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    const chunks: Buffer[] = [];
    let stderr = "";
    let settled = false;

    const finish = (result: RenderedPage | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      // Killed rather than abandoned: a render that runs past the cap is holding the
      // whole document decoded in memory, and leaving it running would cost that per
      // hung request.
      child.kill("SIGKILL");
      logger.error(`[artifacts] pdf render timed out after ${RENDER_TIMEOUT_MS}ms: ${file} page ${pageNumber}`);
      finish(undefined);
    }, RENDER_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      // Capped: a PyMuPDF warning storm on a damaged file should not grow unbounded.
      if (stderr.length < 4096) stderr += chunk.toString("utf8");
    });

    child.on("error", (error: Error) => {
      logger.error(`[artifacts] cannot run python3 for PDF rendering: ${error.message}`);
      finish(undefined);
    });

    child.on("close", (code: number | null) => {
      if (code !== 0) {
        logger.error(
          `[artifacts] pdf render failed (exit ${code ?? "signal"}): ${file} page ${pageNumber}: ${stderr.trim().slice(0, 300)}`,
        );
        finish(undefined);
        return;
      }
      const bytes = Buffer.concat(chunks);
      const size = pngSize(bytes);
      if (size === undefined) {
        logger.error(`[artifacts] pdf render produced no PNG: ${file} page ${pageNumber}`);
        finish(undefined);
        return;
      }
      // The page count is not known here — the script prints only the image — so the
      // caller asks for it through `pdfPageCount`. Kept apart so a render stays one
      // cheap subprocess.
      finish({ bytes, width: size.width, height: size.height, pageCount: 0 });
    });
  });
}

/**
 * How many pages `file` has, or `undefined` when it cannot be opened.
 *
 * Read from the document, not guessed: a viewer shows "page 2 of 3" and has to know
 * whether there is a next page to offer.
 */
export function pdfPageCount(file: string): Promise<number | undefined> {
  const script = `
import sys
import pymupdf
try:
    document = pymupdf.open(sys.argv[1])
except Exception as error:
    print("cannot open: %s" % error, file=sys.stderr)
    raise SystemExit(3)
try:
    print(document.page_count)
finally:
    document.close()
`;
  return new Promise((resolve) => {
    const child = spawn("python3", ["-c", script, file], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let settled = false;
    const finish = (value: number | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(undefined);
    }, RENDER_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", () => finish(undefined));
    child.on("close", (code: number | null) => {
      if (code !== 0) return finish(undefined);
      const count = Number.parseInt(out.trim(), 10);
      finish(Number.isFinite(count) && count > 0 ? count : undefined);
    });
  });
}
