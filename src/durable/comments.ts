/**
 * Review comments: the anchor text, and the two messages one becomes.
 *
 * A comment is a *position in history*, not a position in a file. It names one
 * anchor per selected line, each `(change id, original line, that line's text)`,
 * and `artifact-vcs.ts` turns those into a verdict. Everything here is the layer
 * above that: how an anchor is written down where a human and a model both have
 * to read it, and how a selection becomes anchors in the first place.
 *
 * The anchor format is deliberately GitHub's, because that is the one a reader
 * already knows:
 *
 *     foo.md#L20             a whole line
 *     foo.md#L20-L24         a run of lines
 *     foo.md#L20C15-L20C30   characters 15..30 of line 20
 *
 * 1-based, inclusive at both ends, counted in **code points** rather than bytes
 * so a comment on a line of CJK or emoji points where the cursor was. Character
 * offsets are only ever recorded within a single line: a two-dimensional span
 * (`#L20C15-L24C3`) is a shape no viewer knows how to draw, so a selection that
 * crosses lines degrades to line granularity.
 *
 * The other half of the job is that these strings are read by a *model* as well
 * as by a person, and the quoted text is untrusted: it came out of a file the
 * agent may itself have been steered into writing. So the quote is fenced into a
 * blockquote with `>` stripped out of its own content, capped, and never allowed
 * to look like it is the person speaking.
 */
import { randomUUID } from "node:crypto";

import type { AnnotatedLine, ArtifactAnchor, ArtifactComment } from "./artifact-vcs.js";

/** Most a comment may say. Long enough for a paragraph, short enough to be a turn. */
export const MAX_COMMENT_CHARS = 4000;

/**
 * Most of a line/selection a comment carries as a quote.
 *
 * A signpost, not a copy: the anchor says where to look, and the model has the
 * file. Long quotes cost tokens and add nothing the file does not already have.
 */
export const MAX_QUOTE_CHARS = 300;

/**
 * A selection, as a viewer reports it.
 *
 * A source view knows line numbers and reports those. A *rendered* document does
 * not — a paragraph is not a line — so it reports the selected **text** instead,
 * and `deriveQuoteSelection` finds where that text came from. One of the two is
 * required; everything else is an optional refinement.
 */
export interface Selection {
  /** First selected line, 1-based. Absent for a rendered-document selection. */
  line?: number;
  /** Last selected line, inclusive. Defaults to `line`. */
  endLine?: number;
  /** First selected character within `line`, 1-based and inclusive. */
  charStart?: number;
  /** Last selected character within `line`, 1-based and inclusive. */
  charEnd?: number;
  /** The selected text, as the reader sees it. */
  quote?: string;
  /**
   * Which occurrence of `quote` was selected, 0-based, when the same text appears
   * more than once in the file.
   *
   * The viewer counts occurrences in the document it rendered; the host counts
   * them in the source. They agree for prose, and this is what keeps a comment on
   * the second "return null" attached to the second one.
   */
  occurrence?: number;
}

export type Anchored = Pick<ArtifactComment, "anchors" | "quote" | "charStart" | "charEnd">;

/**
 * A rectangle of a picture, in pixels of the picture as it was drawn.
 *
 * Not in the frame's pixels and not in screen pixels: a picture is scaled to fit the
 * drawer, so the same picture in a narrow window is a different number of screen
 * pixels and a rectangle counted there would mean nothing on the next read. The
 * rectangle is only ever produced by a *document* displayed by **the server that
 * serves the picture**, and it carries the size it was measured against for the one
 * check that matters: a rectangle larger than the picture cannot have come from the
 * picture.
 */
export interface Region {
  /** Left edge, in pixels of the original picture. */
  x: number;
  /** Top edge, in pixels of the original picture. */
  y: number;
  width: number;
  height: number;
  /**
   * The picture's own size, as the document knew it when the reader dragged.
   *
   * Recorded with the rectangle because it is the only way to notice later that the
   * file was replaced by one of different dimensions — in which case the rectangle
   * no longer frames what the person pointed at, and saying so is better than
   * drawing a highlight over the wrong part of the new picture.
   */
  imageWidth: number;
  imageHeight: number;
  /**
   * Which page of a document this rectangle is on, 1-based.
   *
   * Absent for a picture, present for a PDF. Unlike the rectangle it is not a
   * *position* so much as part of the document's identity: page 3 of a PDF is a
   * different place from page 1, and a rectangle without its page would mean "some
   * 320x180 box somewhere in the document".
   */
  page?: number;
}

/**
 * The smallest rectangle worth calling one.
 *
 * A tap is not a selection. Below this the gesture was a click — which is how a
 * person opens a picture, not how they choose part of it — so the honest reading is
 * "no region", and the comment is about the file.
 */
export const MIN_REGION_SIDE = 8;

/**
 * A rectangle clamped to the picture, or `undefined` when it is not a selection.
 *
 * The viewer computes this from where the finger was, so it can be off the picture
 * by a pixel or two at an edge, or nonsense from a stale document that measured a
 * different size. Everything is kept inside the picture's bounds and rounded to
 * whole pixels; a shape that ends up too small after that is not a rectangle.
 */
export function normalizeRegion(value: unknown): Region | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  const number = (field: unknown): number | undefined =>
    typeof field === "number" && Number.isFinite(field) ? field : undefined;
  const x = number(input.x);
  const y = number(input.y);
  const width = number(input.width);
  const height = number(input.height);
  const imageWidth = number(input.imageWidth);
  const imageHeight = number(input.imageHeight);
  if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined;
  if (imageWidth === undefined || imageHeight === undefined) return undefined;
  // A page is 1-based when it is there at all; `0` is not "before page one", it is a
  // number somebody got wrong.
  const page = number(input.page);
  if (input.page !== undefined && (page === undefined || page < 1)) return undefined;
  if (imageWidth < 1 || imageHeight < 1) return undefined;
  if (width <= 0 || height <= 0) return undefined;
  // Inside the picture: a rectangle that starts off it describes nothing.
  const left = Math.max(0, Math.min(Math.round(x), Math.round(imageWidth) - 1));
  const top = Math.max(0, Math.min(Math.round(y), Math.round(imageHeight) - 1));
  const right = Math.min(Math.round(imageWidth), Math.max(Math.round(x + width), left + 1));
  const bottom = Math.min(Math.round(imageHeight), Math.max(Math.round(y + height), top + 1));
  const clamped = { x: left, y: top, width: right - left, height: bottom - top };
  if (clamped.width < MIN_REGION_SIDE || clamped.height < MIN_REGION_SIDE) return undefined;
  return {
    ...clamped,
    imageWidth: Math.round(imageWidth),
    imageHeight: Math.round(imageHeight),
    ...(page === undefined ? {} : { page: Math.round(page) }),
  };
}

/**
 * The rectangle as an address: `shot.png#x120,y64,w320,h180`.
 *
 * The same shape as the line address, and for the same reason: it is a fragment, so it
travels as a link and can be parsed back. `x,y,w,h` rather than a ratio, because a
person reading it can hold the four numbers against a picture, and because a ratio
would silently behave differently for the same comment after a crop.
 */
export function regionSuffix(region: Region): string {
  // A page leads: `resume.pdf#p1,x120,y64,w320,h180`. First because it is the part a
  // person reads to know *where in the document* they are being sent, and because it
  // matches how a page is addressed on its own (`?page=1`).
  const page = region.page === undefined ? "" : `p${region.page},`;
  return `#${page}x${region.x},y${region.y},w${region.width},h${region.height}`;
}

/** The rectangle an address names, or `undefined` when it names a line instead. */
export function parseRegion(fragment: string): Region | undefined {
  const match = /^#?(?:p(\d+),)?x(\d+),y(\d+),w(\d+),h(\d+)$/.exec(fragment.trim());
  if (!match) return undefined;
  const page = match[1] === undefined ? undefined : Number(match[1]);
  if (page !== undefined && page < 1) return undefined;
  const region = {
    ...(page === undefined ? {} : { page }),
    x: Number(match[2]),
    y: Number(match[3]),
    width: Number(match[4]),
    height: Number(match[5]),
    // The size is not in the address: a reader sees the rectangle, and the size it was
    // measured against is a fact about the file, not about the comment.
    imageWidth: 0,
    imageHeight: 0,
  };
  if (region.width < 1 || region.height < 1) return undefined;
  return region;
}

/**
 * What a formatter needs, structurally.
 *
 * Deliberately looser than `ArtifactComment`: this module formats comments that
 * came from the store, from the seam (where arrays are readonly), and from a
 * request body, and none of those should have to be reshaped to be printed.
 */
export interface Printable {
  /** The comment's id. A reply tool needs it, so the model is told it. */
  id?: string;
  file: string;
  anchors: readonly { originalLine: number }[];
  quote?: string;
  charStart?: number;
  charEnd?: number;
  /**
   * The part of a picture this comment is about, when it is about part of one.
   *
   * A picture has no lines, so `anchors` is empty for an image comment and this is
   * the position instead. Kept apart from the line fields rather than folded into
   * them: the two are different kinds of address, and a reader that could not tell
   * them apart would draw a highlight in the wrong place.
   */
  region?: Region;
  text: string;
  author?: string;
}

/** The suffix of a comment's address: `#L20C15-L20C30`, `#L20-L24`, or `#x0,y0,w8,h8`. */
export function anchorSuffix(
  comment: Pick<Printable, "anchors" | "charStart" | "charEnd" | "region">,
): string {
  if (comment.region !== undefined) return regionSuffix(comment.region);
  const first = comment.anchors[0];
  const last = comment.anchors[comment.anchors.length - 1];
  if (!first || !last) return "";
  const single = comment.anchors.length === 1;
  // Only the *rendered* line numbers matter here; the file has moved on, and
  // this string is for a reader, not for matching.
  const lineOf = (anchor: { originalLine: number }): number => anchor.originalLine;
  if (single && comment.charStart !== undefined && comment.charEnd !== undefined) {
    return `#L${lineOf(first)}C${comment.charStart}-L${lineOf(last)}C${comment.charEnd}`;
  }
  if (single) return `#L${lineOf(first)}`;
  return `#L${lineOf(first)}-L${lineOf(last)}`;
}

/**
 * The first eight characters of an id.
 *
 * Long enough to be unique among a conversation's comments in practice, and the
 * host refuses an ambiguous prefix rather than guessing — so a collision costs a
 * failed tool call, not a reply in the wrong thread.
 */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** The last path segment: what a reader calls the file. */
export function shortName(file: string): string {
  const at = file.lastIndexOf("/");
  return at === -1 ? file : file.slice(at + 1);
}

/** The full address: `foo.md#L20C15-L20C30`, or `shot.png#x120,y64,w320,h180`. */
export function anchorAddress(
  comment: Pick<Printable, "file" | "anchors" | "charStart" | "charEnd" | "region">,
): string {
  return `${comment.file}${anchorSuffix(comment)}`;
}

/**
 * An address that points where the comment *is now*, not where it started.
 *
 * `anchorAddress` is written against the line numbers the comment was made on, which is right at
 * creation and wrong the moment a later edit shifts the file: a comment on line 121 that now sits
 * on 142 was still cited as `#L121`, so the link a person tapped highlighted a line nobody had
 * commented on. The resolved positions are already known at read time (`classifyComments`), so the
 * citation follows them — and falls back to the original when nothing resolved.
 */
export function currentAddress(
  comment: Pick<Printable, "file" | "anchors" | "charStart" | "charEnd" | "region">,
  positions: readonly number[],
): string {
  // A picture does not move: its rectangle is in the picture's own pixels, so there is
  // no "where it is now" to resolve — the same numbers address it until the file is
  // replaced, which is what `imageWidth`/`imageHeight` are for.
  if (comment.region !== undefined) return anchorAddress(comment);
  if (positions.length === 0) return anchorAddress(comment);
  const first = positions[0] as number;
  const last = positions[positions.length - 1] as number;
  const single = positions.length === 1;
  if (single && comment.charStart !== undefined && comment.charEnd !== undefined) {
    return `${comment.file}#L${first}C${comment.charStart}-L${last}C${comment.charEnd}`;
  }
  if (single) return `${comment.file}#L${first}`;
  return `${comment.file}#L${first}-L${last}`;
}

export interface ParsedAnchor {
  lines: [number, number];
  chars?: [number, number];
}

/**
 * Parse the `#L20C15-L20C30` part of an address.
 *
 * Used for links into the viewer and for tests of the formatter; a malformed
 * anchor returns `undefined` rather than a guess, because a guessed line number
 * puts a highlight somewhere the person did not comment on.
 */
export function parseAnchor(anchor: string): ParsedAnchor | undefined {
  const text = anchor.startsWith("#") ? anchor.slice(1) : anchor;
  const match = /^L(\d+)(?:C(\d+))?(?:-L(\d+)(?:C(\d+))?)?$/.exec(text);
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = match[3] === undefined ? start : Number(match[3]);
  if (start < 1 || end < start) return undefined;
  if (match[2] !== undefined && match[4] !== undefined) {
    const from = Number(match[2]);
    const to = Number(match[4]);
    // Character offsets only mean anything within one line; anything else is
    // refused rather than silently downgraded by a parser.
    if (end !== start || from < 1 || to < from) return undefined;
    return { lines: [start, end], chars: [from, to] };
  }
  if (match[2] !== undefined || match[4] !== undefined) return undefined;
  return { lines: [start, end] };
}

/**
 * Turn a selection into anchors, against the annotation of the current revision.
 *
 * The annotation is the authority, not the browser: the viewer reports which
 * lines a person dragged across, and this decides which revisions those lines
 * came from and what they say. A stale viewer that names a line which no longer
 * exists gets a refusal rather than anchors pointing into the wrong file.
 *
 * Character offsets are clamped to the line and dropped entirely for a
 * multi-line selection, which is the same restriction the format has.
 */
export function anchorsForSelection(
  lines: readonly AnnotatedLine[],
  selection: Selection,
): Anchored | { error: string } {
  if (selection.line === undefined) {
    return { error: "a selection needs a line, or a quote to derive one from" };
  }
  const startLine = selection.line;
  const endLine = selection.endLine ?? startLine;
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) {
    return { error: "invalid line selection" };
  }
  if (endLine < startLine) return { error: "endLine is before line" };

  const ceiling = lines.length;
  if (startLine < 1 || endLine > ceiling) {
    return { error: `selection is outside the file (1..${ceiling})` };
  }

  const anchors: ArtifactAnchor[] = [];
  for (let number = startLine; number <= endLine; number += 1) {
    const line = lines[number - 1];
    if (!line) return { error: `no line ${number} in this revision` };
    anchors.push({ changeId: line.changeId, originalLine: line.originalLine, content: line.content });
  }

  const first = lines[startLine - 1]!;
  const single = endLine === startLine;
  const codepoints = [...first.content];
  let charStart: number | undefined;
  let charEnd: number | undefined;

  if (single && selection.charStart !== undefined && selection.charEnd !== undefined) {
    charStart = Math.max(1, Math.min(selection.charStart, codepoints.length || 1));
    charEnd = Math.max(charStart, Math.min(selection.charEnd, codepoints.length || 1));
  }

  const selected =
    charStart !== undefined && charEnd !== undefined
      ? codepoints.slice(charStart - 1, charEnd).join("")
      : lines
          .slice(startLine - 1, endLine)
          .map((line) => line.content)
          .join("\n");

  const quote = truncate(selected.trim(), MAX_QUOTE_CHARS);
  return {
    anchors,
    ...(quote === "" ? {} : { quote }),
    ...(charStart === undefined ? {} : { charStart }),
    ...(charStart === undefined || charEnd === undefined ? {} : { charEnd }),
  };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** A new comment id. Opaque; the viewer only has to keep it in a URL. */
export function newCommentId(): string {
  return randomUUID();
}

/** A quote made safe to sit in a blockquote, and short enough to be one. */
function quoteBlock(quote: string | undefined): string {
  if (!quote) return "";
  const cleaned = quote
    // A newline inside a quote would end the blockquote and let file content
    // address the reader in their own voice; `>` would open a nested one.
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/^(\s*)>+/, "$1"))
    .join(" ")
    .trim();
  return cleaned === "" ? "" : `> ${truncate(cleaned, MAX_QUOTE_CHARS)}\n\n`;
}

/**
 * What the model is sent when someone comments on part of a picture.
 *
 * The rectangle is on the first line as an address a person could also read, and the
 * picture itself is described behind a blank line so a model with image input is not
 * left reading the field name as part of an instruction. The file is named in full:
 * a crop shown without its source is a floating fragment, and the point of the
 * attachment is to show *which part of which picture*.
 *
 * Nothing here depends on the model being able to see. The rectangle and the path are
 * the whole message for a text-only model, and they are enough for `read`; the extra
 * line tells a seeing model there is something attached rather than that the reader
 * is being confusingly precise.
 */
export function imageRegionText(comment: Printable & { region: Region }, options: { path: string }): string {
  const who = comment.author ?? "the user";
  const region = comment.region;
  const address = anchorAddress(comment);
  const tag = comment.id === undefined ? "" : ` [comment ${shortId(comment.id)}]`;
  const where = options.path === comment.file ? address : `${address} (${options.path})`;
  const size =
    region.imageWidth > 0 && region.imageHeight > 0
      ? ` of a ${region.imageWidth}x${region.imageHeight} image`
      : "";
  // A PDF is a document, not a picture, and the page is the first thing a model needs
  // to know about the rectangle: "page 3" is where the reader was, and a rectangle
  // quoted without it would be a box in a document of unknown length.
  const onPage = region.page === undefined ? "" : `, on page ${region.page} of the document`;
  return [
    `${who} commented on the selected region of ${where}${tag}`,
    `Selected region: ${region.width}x${region.height} at (${region.x}, ${region.y})${size}${onPage}.`,
    "The selection is attached to this message as an image: it is that rectangle of the page, rendered and cut out, so you can see exactly what was pointed at even if you cannot view the whole file.",
    comment.text.trim(),
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}

/**
 * What the model is sent when someone comments.
 *
 * The address on the first line is the one a person sees, with the absolute path
 * beside it so a tool-using model does not have to guess which file `a.sh` is.
 * The quoted line is fenced, because it is untrusted text from a file — the same
 * trust level as reading the file, and it must not read as an instruction from
 * the person.
 */
export function modelText(comment: Printable, options: { path: string }): string {
  if (comment.region !== undefined) return imageRegionText({ ...comment, region: comment.region }, options);
  const who = comment.author ?? "the user";
  const address = anchorAddress(comment);
  // The short id is how the agent replies into this thread: the tool takes it, and
  // a 36-character uuid in every message is noise a model then has to copy exactly.
  const tag = comment.id === undefined ? "" : ` [comment ${shortId(comment.id)}]`;
  // The parenthetical is only worth reading when it says something the address
  // does not. When the host could not resolve a real path the two are the same
  // string, and repeating it buried the part a reader scans for.
  const where = options.path === comment.file ? address : `${address} (${options.path})`;
  // A whole-file comment has no address suffix to name a part, so it says so in words.
  // Otherwise the message reads `someone commented on a.sh` with no indication of
  // whether that means the file or some position in it that failed to print — and a
  // model that guesses "a position" will hunt for one that does not exist.
  const wholeFile = comment.anchors.length === 0 && comment.charStart === undefined;
  return [
    `${who} commented on ${wholeFile ? `the whole of ${where}` : where}${tag}`,
    quoteBlock(comment.quote).trimEnd(),
    comment.text.trim(),
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}

/**
 * What Chat is told about a comment, so the thread reads as a conversation.
 *
 * The address is a link into the viewer, which is the only reason it is a whole
 * URL: a person reading Chat should be able to look at the line being discussed.
 * The redaction and quoting rules are the shared ones, so nothing here can leak
 * more than the model-facing text does.
 */
export function chatText(comment: Printable, options: { url: string; speaker: string }): string {
  // The *label* is the file's name, not its path: Chat is a narrow column, the
  // artifact key is an implementation spelling (`conversation/19500/static.md`),
  // and the path a person needs is one tap away in the link. The visible sentence
  // is then `static.md#L3C126-L3C131`, which is the thing being commented on.
  const label = `${shortName(comment.file)}${anchorSuffix(comment)}`;
  const linked = options.url === "" ? label : `[${label}](${options.url})`;
  // A picture gets one sentence of its own: the address is a rectangle rather than a
  // line, and a reader of a Chat thread is owed the plain version of that. The quoted
  // text stays above it, because a comment on a picture may still quote the caption
  // it was written about.
  const region = comment.region;
  const subject =
    region === undefined
      ? []
      : [
          `the ${region.width}×${region.height} region at (${region.x}, ${region.y})` +
            (region.imageWidth > 0 ? ` of a ${region.imageWidth}×${region.imageHeight} image` : ""),
        ];
  return [
    `**${options.speaker}** commented on ${linked}`,
    ...subject,
    quoteBlock(comment.quote).trimEnd(),
    comment.text.trim(),
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}

/**
 * What Chat is told when a reviewer *replies* in a comment thread.
 *
 * A reply is a turn like any other, so it has to reach the thread or Chat shows a
 * conversation with the answer to something nobody can see. It is worded as a
 * reply rather than a fresh comment: the comment it belongs to is a few messages
 * up in the same thread, already carrying the quoted line, so repeating the quote
 * here would read as a second review note.
 */
export function chatReplyText(
  comment: Printable,
  reply: string,
  options: { url: string; speaker: string },
): string {
  const label = `${shortName(comment.file)}${anchorSuffix(comment)}`;
  const linked = options.url === "" ? label : `[${label}](${options.url})`;
  return [`**${options.speaker}** replied on ${linked}`, reply.trim()]
    .filter((part) => part !== "")
    .join("\n\n");
}

/** Newest first, resolved last: the order a review pane wants to show. */
export function sortForReview<T extends { at: number; resolved?: boolean }>(comments: readonly T[]): T[] {
  return [...comments].sort((a, b) => {
    if (Boolean(a.resolved) !== Boolean(b.resolved)) return a.resolved ? 1 : -1;
    return b.at - a.at;
  });
}

/**
 * One canonical form of a document, plus a map back to the source.
 *
 * Rendered text and source text differ in exactly two ways that matter here:
 * whitespace (source lines are joined into a paragraph) and inline markup
 * (`**bold**` renders as `bold`). So the source is reduced to a canonical string
 * that removes both, and `map[i]` is the offset in the source that canonical
 * character `i` came from. A match in canonical space converts back to exact
 * source offsets, which is what an anchor needs.
 *
 * `occurrence` is what makes this safe: canonical text is lossy, so the same
 * phrase can appear more than once, and the reader's own count resolves it.
 */
interface Canonical {
  text: string;
  map: number[];
}

/** Inline constructs whose markers never survive into rendered text. */
const INLINE_MARKERS = new Set(["*", "_", "`", "~"]);

/** Reduce a document to searchable text, remembering where each character was. */
export function canonicalize(source: string): Canonical {
  const text: string[] = [];
  const map: number[] = [];
  let index = 0;
  let pendingSpace = false;
  let pendingSpaceAt = 0;

  const push = (character: string, at: number): void => {
    if (pendingSpace) {
      text.push(" ");
      map.push(pendingSpaceAt);
      pendingSpace = false;
    }
    text.push(character);
    map.push(at);
  };

  while (index < source.length) {
    const character = source[index]!;

    // Whitespace: collapse every run to one space, including the newlines that
    // join a paragraph's source lines.
    if (/\s/.test(character)) {
      if (!pendingSpace && text.length > 0) {
        pendingSpace = true;
        pendingSpaceAt = index;
      }
      index += 1;
      continue;
    }

    // Inline markup markers: dropped, so `**bold**` and `bold` canonicalise alike.
    if (INLINE_MARKERS.has(character)) {
      // A fence or a double marker can be two characters in a row; skipping one
      // at a time keeps the map contiguous.
      index += 1;
      continue;
    }

    // `[label](target)` contributes the label, not the link machinery.
    if (character === "[") {
      const close = source.indexOf("]", index + 1);
      if (close !== -1 && source[close + 1] === "(") {
        const end = source.indexOf(")", close + 2);
        if (end !== -1) {
          for (let at = index + 1; at < close; at += 1) push(source[at]!, at);
          index = end + 1;
          continue;
        }
      }
    }

    push(character, index);
    index += 1;
  }

  return { text: text.join(""), map };
}

/**
 * Where a selected phrase lives in the source, as a source-offset range.
 *
 * Returns `undefined` when the text cannot be found at all — an empty selection,
 * or one that crosses a construct canonicalisation does not model. That is a
 * refusal rather than a guess: an anchor in the wrong place is worse than no
 * anchor, because it will look right.
 */
export function deriveQuoteSelection(
  source: string,
  quote: string,
  occurrence = 0,
): { start: number; end: number } | undefined {
  const needle = canonicalize(quote).text.trim();
  if (needle === "") return undefined;
  const haystack = canonicalize(source);

  let from = 0;
  let found = -1;
  for (let seen = 0; seen <= occurrence; seen += 1) {
    found = haystack.text.indexOf(needle, from);
    if (found === -1) return undefined;
    from = found + 1;
  }

  const start = haystack.map[found];
  const lastCanonical = found + needle.length - 1;
  const end = haystack.map[lastCanonical];
  if (start === undefined || end === undefined) return undefined;
  return { start, end: end + 1 };
}

/**
 * A source-offset range as a line/character selection.
 *
 * Line numbers are 1-based; characters are 1-based and inclusive, counted in code
 * points, and only recorded for a range within a single line — the same
 * restriction the address format has.
 */
export function selectionFromOffsets(
  source: string,
  start: number,
  end: number,
): { line: number; endLine: number; charStart?: number; charEnd?: number } {
  const before = source.slice(0, start);
  const line = before.split("\n").length;
  const lineStart = before.lastIndexOf("\n") + 1;
  const endLine = source.slice(0, end).split("\n").length;

  if (line !== endLine) return { line, endLine };
  // Both offsets come from the *match*, not from the line: `charEnd` computed
  // from "line start to match end" silently swallowed everything else on the
  // line, which showed up as a highlight on the rest of the paragraph.
  const charStart = [...source.slice(lineStart, start)].length + 1;
  const charEnd = charStart + [...source.slice(start, end)].length - 1;
  return { line, endLine, charStart, charEnd };
}
