# Artifacts: the files a conversation touched

Status: implemented; the origin is not exposed yet — the Cloudflare steps below
are what remains.

## What it is

One conversation's edited and created files, derived from its own transcript, and
a GET-only HTTP origin that serves them.

- `npx tsx src/scripts/artifacts.ts <conversationId>` lists them (add `--json`).
- `GET /c/:id/` is the index; `GET /c/:id/<key>` is a file; `?render` renders
  Markdown as a sandboxed document.

Deliberately **not** a file browser: the derived list *is* the allow-list, so a
request for anything the conversation did not write — however it is spelled — is
a 404 rather than a path to sanitise.

## Two ledgers, joined

**Tool calls (exact).** Every `write` and `edit` tool call already names its file,
and tool calls are durable entries. So there is no per-call bookkeeping, no second
list to drift, conversations older than this feature already have lists (measured:
19 for the largest conversation, ~120 ms to derive), and the list survives a file
being deleted.

**The filesystem (complete).** A tool call only names a file when the tool does.
`sed -i`, a `>` redirect, a formatter, a build writing into `dist/` — those leave
no path in the transcript, so nothing can be derived from it. What cannot be
bypassed is the filesystem itself, so around each turn:

1. read the wall clock, then submit;
2. when the submission settles, walk the roots and keep every regular file whose
   mtime is at or after that reading (`src/durable/observed-files.ts`);
3. store the paths on the conversation's binding, newest first, capped at 200.

No command parsing, no per-tool special cases: a new way of writing a file is
covered the day it is used. The walk is 8.6k files here (~0.4 s, directories in
parallel, stats in batches) and runs off the reply path, after the answer has
settled.

What the walk cannot do is tell a write from an edit — mtime says only "changed".
So observed files carry no counts, and any path a tool call already named keeps
the counts the transcript gave it (`mergeArtifacts`). Directories named
`node_modules`, `.git` and `.jj` are skipped, as are the handful of files this
bridge writes itself (`bridge.sqlite*`, our logs, the pid file) — otherwise every
conversation would list them as artifacts of its own bookkeeping.

Attribution is by time window: a file changed during a turn belongs to that turn.
Two conversations running at once both see a file they both touched, which is
true; a file changed by something else on the machine during a long turn will
appear as well, which is the price of asking the filesystem instead of the
transcript.

## Configuration

```bash
# .env.durable (and .env for the SDK host)
BRIDGE_ARTIFACTS_PORT=8082          # 0/unset disables the listener entirely
BRIDGE_ARTIFACT_ROOTS=              # optional, colon-separated; default below
BRIDGE_WEB_DEV=1                    # optional: re-read page.html per request
```

Roots default to `PI_CWD` plus the agent config dir (`getAgentDir()`), because
this deployment edits files in both — `AGENTS.md` lives outside `PI_CWD` and a
root list of just `PI_CWD` would silently hide it.

## Exposing it (the remaining work)

Keep it off `pi.hl.id.au`: a separate hostname means a separate origin, so the
artifact route table cannot be reached through the app.

1. **DNS.** `cloudflared tunnel route dns pi-bridge artifacts.hl.id.au`, or a
   proxied CNAME in the dashboard. One level below the zone, so Universal SSL
   covers it — no certificate to buy.
2. **Ingress** in `cloudflared.yml`, above the catch-all:

   ```yaml
     - hostname: artifacts.hl.id.au
       service: http://127.0.0.1:8082
       originRequest:
         # No event stream here, so none of the /web SSE tuning applies.
         connectTimeout: 30s
   ```

3. **Access.** Self-hosted application for `artifacts.hl.id.au`, session duration
   the same as the chat app (a shorter one buys nothing: the chat session is the
   stronger credential), policy = your email, or an IdP group if this grows.
4. **Restart** the bridge with the env var set. `start-bridge.sh` restarts node,
   and cloudflared reads its ingress at startup, so both need it.

Check before pointing DNS at it:

```bash
curl -s http://127.0.0.1:8082/healthz                      # ok
curl -s http://127.0.0.1:8082/c/8508/ | head -20           # the index
```

## Security posture

Artifact content is untrusted by construction: the agent is steerable by what it
reads, so a rendered document must be assumed hostile.

- **Every response carries `sandbox`.** Documents become opaque origins: no
  cookies, no `localStorage`, no access to the parent page — including when the
  URL is opened in its own tab, because the header applies to top-level
  navigation too.
- **`default-src 'none'`, `form-action 'none'`.** A rendered document cannot
  fetch, frame or post anything, so it has no exfiltration channel.
- **`nosniff`, `no-store`, `no-referrer`, `frame-ancestors 'self'`.**
- **Markdown is escaped before it is parsed.** The renderer turns source into
  tags only after HTML-escaping it, so there is no path from source text to
  markup. Links keep `http`/`https`/`mailto`/relative and drop everything else.
- **Redaction runs on the way out**, resolved per request, because this viewer
  reads files the harness never sees. The artifact reader is the one place in the
  deployment where a secret could otherwise walk straight out of a file.
- **The listener is GET-only and bound to `127.0.0.1`.** The tunnel is the only
  way in, and the mutating API is not reachable on this port at all.

## Review comments

A comment is a position **in history**, not in a file, and everything here follows
from that.

**The anchor.** Each selected line becomes `(change id, original line, that
line's text)` from `jj file annotate`. All three are needed: the change id narrows
to "this revision touched it", the line numbers pick which of that revision's
lines it was, and the text rules out a different line sliding into the same
number after a deletion. `original_line_number` — not `line_number` — is the
field that matters: insert three lines above a comment and the current number
shifts while the original one does not, so an insertion does not orphan a review
(`test/artifact-vcs.test.ts`).

**Liveness.** A comment is `visible` while every anchor still resolves in the
revision being displayed, `orphaned` when it does not, and `resolved` only by an
explicit action. Orphaned is not resolved: a comment whose line was rewritten is
still open, still listed, and still shown — it just has no position to highlight.
Nothing is ever auto-resolved, because a deleted line is not an answered question.

**What the address means.** `conversation/7/note.md#L3C13-L3C19` — 1-based,
inclusive, counted in code points; character offsets only within one line, since
a two-dimensional span (`#L3C13-L5C4`) is a shape no viewer knows how to draw. The
model receives that address plus the absolute path and the quoted text in a
blockquote; Chat receives the same address as a link, so a reader can open the
exact line.

**Where comments live.** `gchat.comments`, a session-scoped document
(`src/durable/comments-doc.ts`), written *before* the turn is submitted: losing an
answer is recoverable, losing the reviewer's words is not. The turn's text is a
normal submission (`whenBusy: "steer"`, `requestId: comment:<id>` so a double click
cannot start two), and the submission id is recorded so a thread can recover its
answers with `awaitSubmission` instead of copying the transcript.

**The agent's replies are plumbing, and that is enforced by construction.** The
agent has one tool, `comment_reply(commentId, text)`, and it writes a `replies[]`
entry on the comment document — not a submission, not a transcript entry, and never a
transcript message. So its reply shows in the drawer and nowhere else: it does not
reach Chat, and it cannot come back to the model as context on a later turn and
read like something the user said.

A *reviewer's* reply is the other half of that asymmetry, and it is an ordinary
submission (`whenBusy: "followUp"`) because a person speaking is a message, not an
annotation. Nothing in this route posts to Chat: the painter reads the entry past its
cursor and posts the answer, quoting the prompt, because the entry carries the browser
as its origin. Replies were once left unmirrored, which made them the one kind of
message Chat never saw — the thread showed the agent answering something only the
drawer held. The conversation sees only the turn's own answer,
which is what makes a Chat thread read as "here is the change, and here is why".

That is why the model is told the comment id — `[comment a123dcee]` on the
address line — and why the prefix is resolved host-side: a model should not have
to reproduce thirty-six characters, and an ambiguous prefix is refused rather
than guessed.

There is deliberately **no `comment_resolve` tool and no `comment_list`**.
Resolving says nothing actionable, so the agent neither needs it nor may close a
reviewer's note; resolve stays a human action, recorded where the model cannot
see it. A list tool would invite an agent to invent work from other people's open
notes.

**Who can submit.** Not the artifact origin. The framed document is a different
origin, sandboxed with `allow-scripts` and without `allow-same-origin`, and it can
only `postMessage` a selection to its parent — it has no network at all
(`default-src 'none'`). The composer, the thread and the resolve button live in
the chat UI, which owns the session and the API. The parent verifies
`event.source === frame.contentWindow`, because a sandboxed frame's origin is
`"null"` and an origin check would have to accept everything.

**The source view.** `?view=source` serves numbered lines with the comments already
marked: whole-line comments highlight the line, a character range highlights
exactly those characters, and a superscript number opens the thread. It is the one
document on this origin that runs script, so it carries a per-response nonce
(`script-src 'nonce-…'`) and every byte of the file is escaped into it as text.
The plain `text/plain` view and `?render` are unchanged.

**Revisions.** `?rev=<changeId>` serves the file as a revision held it, out of jj
rather than off the disk; the live file remains the default. Bindings record the
newest revision each conversation produced (`ArtifactRevision`), which is what a
revision picker will list.

## PDFs

A PDF is not an image and not text: it is a document with pages. Clicking one in the
drawer shows **page 1, rendered** — not "looks binary", which is what it used to say.

- **The page is a PNG**, rendered by PyMuPDF (the library the conversion that prompted
  this feature used: `pymupdf.open(...).get_pixmap(dpi=150)`). A rasterised page cannot
  become a document, so the artifact origin keeps `default-src 'none'` — the one
  property that made client-side rendering with pdf.js unattractive, since it would
  have needed `worker-src` and wasm on the strictest surface in the deployment.
- **`?page=N` is the document**, `?page=N&png` is the page as an image, and `?raw` is
  the PDF itself. ↗ opens `?raw`: a raster is for *reviewing*, where a rectangle is
  something you can draw; the PDF is for *reading*, where the browser's own viewer has
  text selection, links and zoom.
- **Rendering is lazy and per page.** A 40-page document is one page's work, not forty;
  the pixel budget is capped at 40 megapixels, and a page that would exceed it is
  rendered at the largest DPI that fits rather than refused.
- **The page count is read from the document**, so the strip under the page says "page
  2 of 7" and offers the pages either side.
- **A comment on a page names the page**: `resume.pdf#p3,x120,y64,w320,h180`. The page
  leads the address because it is the first thing that locates the rectangle — page 3
  and page 1 are different places, and no amount of coordinates recovers which.

### Starting a comment

**One button, bottom right, on every artifact.** It replaced a bar that *appeared* when
text was selected, and the reasons are worth keeping:

- Appearing-on-selection made the selection do two jobs. Selecting text to read it
  summoned a comment prompt.
- On a phone the only place such a bar could go was the strip the platform's own
  selection menu and drag handles occupy, so it was covered — or had to be moved to a
  place unrelated to what was selected.
- A persistent button can be pressed **with nothing selected**, which is the only way to
  say "a comment about this file". That is now a real position: no region, no anchors.

What it does depends on what is selected when it is pressed:

- **nothing** → a comment on the file itself (`notes.md — the whole file`).
- **text** → a comment on that text, as before.
- **a picture or a PDF page** → the composer opens *and* the picture is armed, so a drag
  drawn after pressing is the rectangle the comment carries.

The button is hidden while the composer is open — the composer is the same action
continued, and two of them would compete for the same corner. Pressing it again closes
the composer and disarms, which is the way out on a device with no Escape key.

### Zooming looks at the picture, not at the drawer

Zoom is the picture document's own — a scale transform on the `<img>`, driven by two
pointers (a pinch), `ctrl`+wheel (a trackpad), or a double-tap — and **never the
browser's**.

The distinction matters because of a bug with a non-obvious cause: `touch-action:
pinch-zoom` in the frame lets the *browser* zoom, and a browser's pinch-zoom scales the
**visual viewport**, which belongs to the top-level page. So pinching a picture zoomed
the drawer's header and the comment button along with it. A transform cannot escape the
frame, so the chrome stays put.

- **About a point, not the centre.** A pinch holds the thing under the fingers still; a
  scale about the centre drifts away from what the reader is looking at.
- **The scroll extent is given to the stage by hand**, because a transform does not
  change the layout box — without it a zoomed picture could not be panned to its edges.
- **`overscroll-behavior: contain`** stops a pan reaching the picture's edge from
  continuing into the drawer behind it.
- **Arming disarms the zoom gestures**: `touch-action: none` is about to take the
  touches, so a pinch under way would end mid-scale.

### Arming, and why gestures work again

`touch-action: none` on a picture is what makes a rectangle possible on a phone, and it
is also what made **panning and pinching impossible** — one finger cannot mean both
"select" and "pan", and a page that cannot be zoomed is a page that cannot be read.

So the picture belongs to the browser until somebody says they are commenting. The
arming arrives as a message (`pi-artifact-arm`), because the document is a different
frame and the page cannot reach in to change its stylesheet. Unarmed: pan, pinch-zoom,
double-tap and the drawer's own swipe all work, and a drag does nothing. Armed: the CSS
class makes every touch the region script's, and the cursor says what a drag will do.

This is why the arming is *not* driven by a selection. A selection is a thing you do
while reading; arming is a statement of intent, and only a press can make it.

### Commenting on part of a picture

A picture has no lines, so the unit is a rectangle dragged over it. The gesture
runs *inside* the image document (`REGION_SCRIPT`), because a document framed from
another origin gets no pointer events; it reports the rectangle to the parent, the
same way a text selection is reported.

**The rectangle is in the picture's own pixels, not screen pixels.** A picture is
scaled to fit the drawer, so the pixels under the finger are not the pixels in the
file, and a rectangle counted on screen would frame a different thing at a
different drawer width. The document knows both numbers and does the conversion;
nothing downstream ever sees a screen coordinate.

- **A tap is not a selection.** Below `MIN_REGION_SIDE` the gesture was a click,
  so no region is offered. A click instead *measures* the picture, which is how
  the drawer can say the picture is commentable at all — a drag is the only
  gesture that can select, but it is not the only gesture a reader makes.
- **The rectangle is checked twice.** `normalizeRegion` clamps it to the picture
  and drops a shape too small to be one; the crop clamps again, because that is
  the code that would index past the end of the decoded pixels.
- **`?region=x,y,w,h` serves the crop.** The artifact origin does the cutting,
  because the bytes are already there and the allow-list has already approved the
  file. This is also the composer's preview, so a wrong rectangle is visible
  *before* it is sent — the same URL in both places.
- **The address is `shot.png#x120,y64,w320,h180`** (`regionSuffix`), and it is
  parsed back by `parseRegion`. No ratio: the four numbers are pixels, which a
  reader can hold against the picture.
- **Liveness is the picture's dimensions.** A rectangle in the picture's own
  pixels does not move when the file is edited, so there is nothing to re-anchor
  to a revision — an image comment is `visible` while the file keeps the size it
  was measured against and `orphaned` once it does not. The size travels with the
  rectangle for exactly that check, and a deployment that cannot measure the file
  reports `visible` rather than claiming a comment is dead.

**What the model receives.** The text the region comment becomes (`imageRegionText`,
reached through `modelText`) names the file, the rectangle, the picture's size, and
says the selection is attached. The attachment is the crop itself, as an
`ImageContent` part beside the text — so a seeing model is shown what was pointed
at, and a text-only model still gets the rectangle and a path to `read`.

**`view_image`** is for the rest of that story: a model that cannot see the
attachment, or that wants the region fresh after the file changed, asks for it by
*comment id*, never by coordinates. The rectangle comes from the record, because
the part of a picture a person drew is the one fact here that cannot be re-derived.

### Not done yet

- **The drawer opens the live file.** Pinning by default to "the revision this
  conversation produced" needs the picker, and the pins are already recorded.
- **No dropdown.** `revisionLog()` (jj `files()` revset) lists a file's revisions
  in one call; the UI for choosing one is not written.
- **Commenting is source-view only, for *text*.** A rendered Markdown page has no
  line numbers to anchor to, so `?render` shows no marks yet. A picture is
  commentable (`?render` does not apply to one), but its rectangle is not drawn
  back onto the picture when the thread is opened. The comment is not lost — the
  address names the rectangle and the crop attachment shows it — but the picture
  itself carries no mark, unlike a commented source file.
- **A rectangle on a replaced picture cannot be mapped.** Changing a PNG's
  *content* without changing its dimensions leaves an old rectangle `visible`
  over different pixels. jj has the old bytes and the same crop code could
  compare them, but nothing does yet.
- **The crop is best-effort.** A format Photon cannot decode, or a deployment
  without the wasm module, sends the comment without the attachment. The words
  are the part that must not be lost, so this is a missing picture rather than a
  failed comment.
- **A PDF page is a picture once rendered, and is commented on as one.** There is no
  snapping to text blocks or paragraphs: the PDF's text layer is available, and a drag
  could quote the paragraph under it, but the rectangles a person draws are what the
  address records. Reading a page is what ↗ and the browser's viewer are for.
- **HTML is not rendered.** The mechanism would be the same (Chromium via Playwright,
  then the identical page-image path) but it needs a browser process per render, so it
  is a separate decision rather than a missing branch.
- **`BRIDGE_WEB_ENGINE=link`** publishes the comment operations over the chord
  link (see `link-contract.ts`); the other adapter-side operations still do not.
- **One action at a time on a picture.** Pressing the button arms the document; there is
  no per-page or per-element arming, so a swipe to the next artifact disarms.
- **Replying has no idempotency key.** A double-click on "Reply" can start two
  turns; the comment's own turn is keyed, the replies are not.
- **The agent cannot resolve**, and cannot see resolved state at all — by design
  (above), but it means it will happily re-fix something you already resolved if
  the same line is commented on again.

## Known limits

- `bash`-made changes are not listed (above).
- Raw artifacts are always `text/plain`, never sniffed: serving the wrong thing
  as HTML is the one mistake this viewer cannot afford.
- `.html` artifacts are **not** served as HTML yet. The sandboxed document path
  exists and is tested; enabling generated apps is a deliberate follow-up, with
  `sandbox allow-scripts` and `connect-src 'none'` for the app case.
- No per-conversation origin isolation: all conversations share
  `artifacts.hl.id.au`. That is the cost of picking paths over subdomains, and it
  only matters if one conversation's artifact must not be readable from another.
- The index re-derives on every request. Fine at 19-100 artifacts (milliseconds);
  a conversation with thousands would want a cache.
