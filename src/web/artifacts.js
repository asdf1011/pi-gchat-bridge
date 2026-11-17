// --- The artifact drawer ------------------------------------------------------
//
// One conversation's files, the document they open into, and the gesture that pages
// between them. Inlined into `page.html` when the page is read (see `sink.ts`), so the
// browser still receives one document; kept separate here because it is the largest
// feature on the page and the only one with behaviour this involved.
//
// The list comes from this origin (`api/c/<id>/artifacts`), so no CORS. The document
// itself is framed from the artifact host, which is a *different* origin: it is
// sandboxed there and cannot read this page's DOM, cookies or storage. That sandbox is
// why the gesture is detected *inside* the frame and posted back here (see
// `SWIPE_SCRIPT` in `artifacts-server.ts`) rather than listened for on this side.
//
// Frames are pooled, one per artifact key, and never reloaded: switching document is a
// matter of which frame is in the middle of the strip. Everything below assumes that —
// `frameFor` is the only place a document is created, and parked frames are hidden
// rather than removed or re-parented, because both of those make an iframe fetch again.
//
// This part is concatenated into the page's single script, so it shares that script's
// scope. What it borrows from the rest of the page, and nothing more:
//
//   current       the conversation id being viewed
//   apiFetch, rel this origin's JSON routes (the artifact host is a different origin)
//   pageVersion   the deployment fingerprint, published by the environment route
//   loadComments, closeCommentBar, closeThread
//                 the review layer, which rides on the document opened here
//
// Everything else in this file is its own. Adding to that list is a real decision:
// these names are the seam between the drawer and the page around it.

// --- Artifacts: a drawer over the conversation, hidden until asked for. ---
//
// The list comes from this origin (`api/c/<id>/artifacts`), so no CORS. The file
// itself is framed from the artifact host, which is a *different* origin: it is
// sandboxed there and cannot read this page's DOM, cookies or storage.

let artifactsBase = '';
let artifactsOpen = false;
/** Whether this page pushed the history entry the open document lives in. */
let artifactsEntryPushed = false;

const artifactsButton = document.getElementById('artifacts-toggle');
const artifactsPanel = document.getElementById('artifacts');
const artifactsList = document.getElementById('artifact-list');
const artifactsDoc = document.getElementById('artifact-doc');
/** The strip inside it: this is the element that moves. `artifactsDoc` clips it. */
const artifactsTrack = document.getElementById('artifact-track');
/**
 * How many documents stay loaded.
 *
 * The working set is three — the current one and the two a gesture can reach — plus a
 * couple of steps of history, so going back and forth does not reload. Each entry is
 * a whole document with its own scripts and memory, so this is deliberately small.
 */
const FRAME_POOL_LIMIT = 5;

/**
 * One frame per artifact key, kept loaded.
 *
 * The drawer used to hold two fixed frames and reload one of them to change
 * document. That always leaves a gap: an iframe whose `src` changes is blank until
 * the new document paints, and no amount of sequencing hides it when the element is
 * the one on screen. So frames are never reloaded — a key gets a frame, and the frame
 * keeps its document for as long as the drawer remembers it. Moving to another
 * artifact is a matter of *which frame sits in the middle panel*, which is a visible
 * element changing position rather than a visible element changing content.
 */
const framesByKey = new Map();

/** The frame currently in the middle pane, or null. */
let currentFrame = null;

/** The key `currentFrame` holds, which is the document being read. */
function currentKey() {
  return currentFrame ? currentFrame.dataset.key || '' : '';
}

/**
 * The frame for `key`, loading it if this is the first time.
 *
 * Reused rather than recreated, because a reload is exactly what must not happen. The
 * pool is capped: every entry is a live document with its own scripts and memory, and
 * a conversation with forty artifacts should not keep forty of them.
 */
function frameFor(key, markdown, image, url, pdf = false) {
  const existing = framesByKey.get(key);
  if (existing) return existing;
  const frame = document.createElement('iframe');
  frame.className = 'artifact-frame';
  frame.setAttribute('sandbox', 'allow-scripts allow-popups');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.dataset.key = key;
  frame.dataset.image = image ? '1' : '';
  frame.dataset.pdf = pdf ? '1' : '';
  frame.classList.toggle('image', image || pdf);
  // Created *inside* the strip and never moved: an iframe that changes parent is
  // re-fetched, so the pool has to be positional rather than shuffled between
  // containers.
  artifactsTrack.append(frame);
  loadFrameIn(frame, url);
  watchFrameLoads(frame);
  framesByKey.set(key, frame);
  // Oldest first: the cap trims documents nobody has looked at recently.
  if (framesByKey.size > FRAME_POOL_LIMIT) {
    for (const [oldKey, oldFrame] of framesByKey) {
      if (oldKey === key || oldFrame === currentFrame) continue;
      dropFrame(oldFrame);
      framesByKey.delete(oldKey);
      break;
    }
  }
  return frame;
}

/**
 * Put a frame in the strip's middle slot.
 *
 * The strip is transformed, not re-laid out: the frame that is current occupies the
 * same place at rest regardless of how it got there, so this only decides which
 * element is in that place.
 */
/**
 * Take a frame out of the strip without destroying the document it is showing.
 *
 * It stays *in the strip* and is hidden: an iframe that is removed from the document
 * loses its content, and — less obviously — one that is *moved to another parent* is
 * re-fetched, which was measured before this was written. Either way the document
 * would have to load again, which is the whole cost this pool exists to avoid. So
 * frames are only ever hidden and unhidden, never moved.
 */
function parkFrame(frame) {
  if (!frame) return;
  frame.style.order = '';
  frame.hidden = true;
}

/**
 * Throw a frame away for good.
 *
 * The only place a document is actually discarded — the pool's eviction. `remove()`
 * destroys an iframe's content, which is exactly what is wanted here and exactly what
 * made parking by removal a bug.
 */
function dropFrame(frame) {
  if (!frame) return;
  if (frame === currentFrame) currentFrame = null;
  frame.remove();
}

function setCurrentFrame(frame) {
  const previous = currentFrame;
  currentFrame = frame;
  if (!frame) return;
  // Back to the neutral slot. A frame that was a neighbour still carries the `order`
  // that parked it on one side, and left there the *current* document would sit in
  // the strip's second slot with an empty pane before it — the strip would then show
  // the wrong document at rest.
  frame.style.order = '';
  frame.hidden = false;
  // Whatever was current steps out of the strip. This is the non-gesture path — a
  // hash change, a click on a row — where there is no slide to carry the old document
  // off, and two frames left in the middle slot would have the strip showing whichever
  // came first.
  if (previous && previous !== frame) parkFrame(previous);
}
const artifactsHint = document.getElementById('artifact-hint');
const artifactsNewTab = document.getElementById('artifacts-newtab');
const artifactsBack = document.getElementById('artifacts-back');
const artifactsTitle = document.getElementById('artifacts-title');

/**
 * Where the framed document is fetched from.
 *
 * The drawer always asks for the *source* view, which is the one with numbered
 * lines and the selection script — a rendered Markdown page has no lines to
 * anchor a comment to, and a bare `text/plain` response cannot carry a script at
 * all. `?view=source` is still inert HTML: every byte of the file is escaped into
 * it, and the only script is the one the artifact origin writes with a per-response
 * nonce.
 */
/**
 * Which view a file opens in.
 *
 * Markdown opens *rendered*, because that is what a person wants to read — and
 * the rendered document is commentable too: it reports the selected text and the
 * session host finds the source lines it came from, so neither side has to know
 * how the other numbered anything. Everything else opens as the source view,
 * where a line number is the obvious unit.
 */
function artifactUrl(key, markdown, image, pdf) {
  const path = key.split('/').map(encodeURIComponent).join('/');
  // `pdf` is a third kind beside markdown and image: a document with pages, which the
  // server renders one page at a time. It is framed exactly like a picture — the
  // document it builds is a picture with paging around it — so the two share a branch.
  // An image has no view to choose, but it does have two URLs: the plain one is a
  // document that centres the picture on this theme's background (a browser paints
  // an image document's own backdrop white, which is a white slab in a dark drawer),
  // and `?raw` is the bytes themselves. The drawer frames the first and ↗ opens the
  // second, which is what a person means by "open the picture".
  //
  // A PDF is framed the same way, one page at a time: the document the server builds
  // around the *rendered* page. Which page lives in the frame's URL, and the paging
  // links inside the document are how it changes — so reloading, or following a link
  // to `?page=3`, lands on the page it names.
  if (image || pdf) return artifactsBase + '/c/' + current + '/' + path;
  return artifactsBase + '/c/' + current + '/' + path + (markdown ? '?render' : '?view=source');
}

/**
 * Where a PDF's own bytes live — what ↗ opens.
 *
 * Deliberately not the rendered page: a rasterised page is for *reviewing*, where a
 * rectangle is a thing you can draw. A PDF itself is for *reading*, and the browser's
 * viewer gives text selection, links and zoom that a picture cannot.
 */
function pdfRawUrl(key) {
  return artifactsBase + '/c/' + current + '/' + key.split('/').map(encodeURIComponent).join('/') + '?raw';
}

/** Where an image's own bytes live, for the new-tab button and for download links. */
function rawArtifactUrl(key) {
  return artifactUrl(key, false, true) + '?raw';
}

/**
 * The selected part of a picture, as an image URL.
 *
 * The artifact origin does the cutting, because the bytes are already there and the
 * allow-list has already approved the file: fetching them a second time to crop them
 * elsewhere would be a second read of the same untrusted file, and the crop would have
 * to travel back as base64 over the session API to be attached to anything.
 *
 * `region` is in the picture's own pixels — see `REGION_SCRIPT` — and never in screen
 * pixels, so the same URL means the same rectangle in a narrow drawer and a wide one.
 */
function regionArtifactUrl(key, region) {
  const path = key.split('/').map(encodeURIComponent).join('/');
  // A PDF's rectangle is a rectangle of *one page*, so the page travels with it: the
  // crop is cut from `?page=N&png`, and without the page a comment on page 3 would crop
  // page 1. The page is the one on the *region*, which the document itself reported —
  // reading it back out of the frame's URL was the bug, because a page turn navigates
  // the frame and a cross-origin frame's location cannot be read from here at all.
  const reported = Number(region.page);
  const page = Number.isFinite(reported) && reported > 0 ? reported : pageOfFrame(key);
  const query = [
    ...(page === undefined ? [] : ['page=' + page, 'png']),
    'region=x' + region.x + ',y' + region.y + ',w' + region.width + ',h' + region.height,
  ];
  return artifactsBase + '/c/' + current + '/' + path + '?' + query.join('&');
}

/**
 * Which page a PDF frame is on, as a *fallback*.
 *
 * The document reports its own page in the region message, and that is the answer used:
 * it is the only party that knows, because a page turn navigates the frame and a
 * cross-origin frame's location cannot be read from here at all. This exists for a
 * document that does not report one — an older cached build, or a frame still on its
 * first page, where `src` is whatever this page set and so is right.
 */
function pageOfFrame(key) {
  const frame = framesByKey.get(key);
  if (!frame) return undefined;
  // The frame's *current* location where it can be read, else its `src`. A paging link
  // navigates the frame without touching the parent's DOM, so `getAttribute('src')` keeps
  // saying page 1; cross-origin `contentWindow.location` throws, and the attribute is then
  // all there is. Read when the two agree, which is why the message's own report is the
  // real answer and this is only the fallback.
  let href = '';
  try {
    href = frame.contentWindow?.location?.href ?? '';
  } catch {
    href = '';
  }
  if (href === '') href = frame.getAttribute('src') || '';
  const match = /[?&]page=(\d+)/.exec(href);
  if (!match) return undefined;
  const page = Number(match[1]);
  return Number.isFinite(page) && page > 0 ? page : undefined;
}

/**
 * The URL the composer and the thread preview for a rectangle, or '' when there is none.
 *
 * Takes either shape: a pending selection (which has `file`) and a stored comment (which
 * has `file` too, as the artifact key) are the same two facts, and the crop is the same
 * URL for both — so what is about to be sent and what was sent cannot differ.
 */
function regionPreviewUrl(selection) {
  if (!selection || !selection.region || !selection.file || artifactsBase === '') return '';
  return regionArtifactUrl(selection.file, selection.region);
}

/**
 * The picture the drawer is showing, when it is showing one.
 *
 * The composer sits over the whole drawer, so a message from a frame is a selection in
 * *that* frame's document; a rectangle from a parked frame would be a comment on a
 * picture nobody is looking at.
 */
function imageFrameFor(source) {
  if (!currentFrame || !source) return null;
  if (currentFrame.contentWindow === source) return currentFrame;
  // A frame that has *navigated* is the same frame with a different window. Identity on
  // `contentWindow` holds for the initial document and then fails — and cross-origin it
  // fails harder, because `contentWindow` reads as `null` once the frame is on another
  // host. That is not an edge case here: the drawer frames the artifact host, so every
  // page turn is a cross-origin navigation, and the region message would be dropped
  // exactly when a reader had paged forward.
  //
  // So the pool is searched instead: a message from any frame this drawer owns is a
  // message about a document the drawer is showing. It is not weaker than the identity
  // check it replaces — `default-src 'none'` and the sandbox mean these frames can only
  // talk to this window, and `window.addEventListener('message')` on the parent already
  // decides everything else by `data.t`.
  for (const frame of framesByKey.values()) {
    if (frame.contentWindow === source) return frame;
  }
  return null;
}

/**
 * A rectangle the reader dragged over a picture.
 *
 * This is the one selection the host cannot derive for itself: a source view reports a
 * line and the host finds it in the file, a rendered view reports text and the host
 * finds *that*, but a rectangle is a fact about the picture's pixels that only the
 * document which drew it knows. So the rectangle is measured in there (in the
 * picture's own pixels) and taken as given here — the host still refuses a shape that
 * is not a region inside the picture.
 */
function commentOnRegion(message) {
  const region = message && message.region;
  if (!region || typeof region !== 'object') return;
  if (typeof message.file !== 'string' || message.file === '') return;
  // A rectangle replaces whatever was selected: the reader armed the picture and drew on
  // it, which is a more specific choice than a stray text selection made earlier.
  //
  // Only while a comment is being written. A drag drawn with no composer open cannot be
  // a selection — the picture is not armed, so the document does not offer one — but a
  // stale message from a frame could still arrive, and opening a composer for it would
  // start a comment nobody asked for.
  if (commentBar.hidden) return;
  // Which page this rectangle is on. The *document* says, in its message, because it is
  // the only party that knows: a page turn navigates the frame, and cross-origin the
  // parent cannot read where the frame ended up. `pageOfFrame` is the fallback for a
  // document that does not report one (an image, or an older cached build).
  const reported = Number(message.page);
  const page = Number.isFinite(reported) && reported > 0 ? reported : pageOfFrame(message.file);
  showCommentBar({
    file: message.file,
    region: {
      x: Number(region.x) || 0,
      y: Number(region.y) || 0,
      width: Number(region.width) || 0,
      height: Number(region.height) || 0,
      imageWidth: Number(region.imageWidth) || 0,
      imageHeight: Number(region.imageHeight) || 0,
      ...(page === undefined ? {} : { page }),
    },
    intent: message.intent === 'comment' ? 'comment' : undefined,
  });
}

/** The last path segment: what the file is actually called. */
function baseName(key) {
  const parts = key.split('/');
  return parts[parts.length - 1] || key;
}

/** The directory part, which may be empty at the root. */
function dirName(key) {
  const parts = key.split('/');
  parts.pop();
  return parts.join('/');
}

/**
 * Frame loads we caused, and loads we have seen.
 *
 * A back gesture can be delivered to the *frame's* own transcript rather than the
 * page's, in which case no `popstate` fires here and the frame simply walks back
 * to `about:blank` — the drawer then showed a file's name over an empty page. A
 * load nobody asked for is that navigation, and the honest response is to treat it
 * as "back to the list", which is what the gesture meant.
 */
let frameLoadsCaused = 0;
let frameLoadsSeen = 0;

/**
 * The guard for a frame that navigated itself.
 *
 * A back gesture can be delivered to a *frame's* own transcript rather than the
 * page's, in which case no `popstate` fires here and the frame simply walks back to
 * `about:blank` — the drawer then showed a file's name over an empty page. A load
 * nobody asked for is that navigation, and the honest response is to treat it as
 * "back to the list".
 *
 * Counted across the whole pool: only loads this page caused are expected, and
 * anything else came from a document navigating itself.
 */
function watchFrameLoads(frame) {
  frame.addEventListener('load', () => {
    // A frame in the park is not on screen, so a load there is not a navigation the
    // reader made — it is a document finishing its initial fetch, or a reload this
    // page started for comments. Counting it would close the drawer over a document
    // nobody is looking at.
    if (frame.hidden) return;
    frameLoadsSeen += 1;
    if (frameLoadsSeen <= frameLoadsCaused) return; // one of ours
    // A *page turn* is a navigation this page did not cause and does not mean "back".
    // A PDF's paging links navigate the frame itself, so without this every page turn
    // closed the drawer back to the list — the document was readable only on page 1.
    // Counted as ours, because it is the drawer's own document moving within itself.
    if (frame.dataset.pdf === '1' && frame === currentFrame) {
      frameLoadsCaused = frameLoadsSeen;
      return;
    }
    frameLoadsCaused = frameLoadsSeen;
    if (artifactsOpen && artifactsPanel.classList.contains('showing-doc')) applyListState();
  });
}

/** Point a frame at a URL, counting the load as ours. */
function loadFrameIn(frame, url) {
  frameLoadsCaused += 1;
  frame.src = url;
}

/**
 * Show one document in the drawer.
 *
 * `push` is false when this is a *restore* — the page just loaded with the fragment already naming
 * this file, so the entry exists and pushing another would make one back gesture do nothing.
 *
 * `image` is the third kind of thing this drawer shows, beside rendered Markdown and
 * source text: a picture, framed as itself. It is passed rather than re-derived
 * from the key so there is one place — the server's list — that decides what counts
 * as an image, and the page cannot disagree with the content type it will be served
 * under.
 *
 * `from` is the side a *newly arriving* document slides in from: `right` for the
 * first one and for stepping backwards, `left` for stepping forwards. The gesture
 * and the keyboard both go through here, so "next" looks the same however you
 * asked for it.
 */
function showArtifact(key, markdown, push = true, image = false, from = 'right', pdf = false) {
  for (const li of artifactsList.children) li.classList.toggle('on', li.dataset.key === key);
  // The document slides over the list and takes the drawer's full width, so a
  // name-heavy list stops competing with the thing being read.
  artifactsPanel.classList.add('showing-doc');
  // Which edge it enters from, for the first document only. A *step* between two
  // documents is a different movement — the strip carrying one out and the other in
  // — and never passes through here.
  artifactsTrack.style.setProperty('--doc-shift', from === 'left' ? '-100%' : '100%');
  artifactsTitle.textContent = baseName(key);
  artifactsTitle.title = key;
  artifactsBack.hidden = false;
  artifactsNewTab.hidden = false;
  // A transcript entry per document, so the browser's own back gesture means what it
  // looks like it means: close the document, show the list.
  try {
    const state = { artifact: key };
    const address = '#' + encodeURIComponent(key);
    if (push) history.pushState(state, '', address);
    else history.replaceState(state, '', address);
  } catch {
    // A sandboxed or file: context can refuse either call; the drawer still works.
  }
  // Whether this page added the entry. After a reload it did not — the entry was restored from the
  // address — and one back gesture must not then leave the page entirely.
  artifactsEntryPushed = push;
  // Nothing is being dragged, so nothing should be parked beside it.
  hideNeighbour();
  // A picture is framed as itself; everything else is a document the artifact host
  // builds — Markdown rendered, or source with numbered lines. Never the file's own
  // bytes as HTML.
  //
  // A frame that already holds this document is reused, which is what makes going
  // back and forth instant — and, more importantly, what makes a *step* possible
  // without reloading anything that is on screen.
  showKey(key, markdown, image, pdf);
  closeCommentBar();
  closeThread();
  // A document is open, so there is something to comment on. Every artifact offers it,
  // including the ones shown as source: a whole-file comment needs no viewer support.
  setFabVisible(true);
  artifactsNewTab.dataset.key = key;
  artifactsNewTab.dataset.markdown = markdown ? '1' : '';
  artifactsNewTab.dataset.image = image ? '1' : '';
  artifactsNewTab.dataset.pdf = pdf ? '1' : '';
}

/**
 * Make `key` the document in the middle.
 *
 * Everything a step needs: the frame for that key (reused if it exists, created
 * otherwise), parked in the strip and made current. No existing frame is reloaded,
 * which is the whole point of the pool.
 */
function showKey(key, markdown, image, pdf) {
  const url = artifactUrl(key, markdown, image, pdf);
  const frame = frameFor(key, markdown, image, url, pdf);
  // The frame is in the strip before it is made current, so it is already laid out
  // and, on a re-visit, already painted. Neighbours are left loaded and detached:
  // that is what makes the next step instant instead of a reload.
  setCurrentFrame(frame);
}

/** The list state, without touching transcript. */
function applyListState() {
  artifactsPanel.classList.remove('showing-doc');
  // Nothing is open, so there is nothing to comment on. The composer closes with it:
  // its subject is the document that has just been put away.
  closeCommentBar();
  setFabVisible(false);
  artifactsTitle.textContent = 'Artifacts';
  artifactsTitle.removeAttribute('title');
  artifactsBack.hidden = true;
  artifactsNewTab.hidden = true;
  // The frames stay loaded and out of the strip; only the *current* one is shown, so
  // returning to the list is a matter of hiding the strip rather than unmounting a
  // document that going back would have to reload.
  artifactsEntryPushed = false;
}

/**
 * Back to the list.
 *
 * Goes through transcript when we own an entry, so the drawer's ← and the browser's
 * back gesture end in the same place.
 */
function showArtifactList() {
  // A back gesture only means "close the document" when this page made the entry it would undo.
  // Otherwise — a reload, a pasted link — going back would leave the conversation.
  if (artifactsEntryPushed && history.state && history.state.artifact) {
    history.back();
    return;
  }
  applyListState();
  try {
    history.replaceState({}, '', location.pathname);
  } catch {
    // Refused in a sandboxed context; the drawer is already showing the list.
  }
}

// A back gesture after opening a document lands here.
window.addEventListener('popstate', () => {
  if (artifactsOpen) applyListState();
});

// The fragment is the address of a document, so a change to it is a request to show that document —
// whether it came from a pasted link, an edited address, or forward/back between two files.
window.addEventListener('hashchange', () => {
  const key = artifactKeyFromHash();
  if (!key) {
    if (artifactsOpen && artifactsPanel.classList.contains('showing-doc')) applyListState();
    return;
  }
  if (!artifactsOpen || currentKey() !== key) void restoreArtifact(key);
});

/**
 * The artifact the URL fragment names.
 *
 * The fragment is the artifact key — that is what opening a document writes there — so a reload or a
 * pasted link can put the reader back on the file they were reading. Keys contain slashes, so the
 * encode/decode pair is not decoration: `#conversation/1/notes.md` and `#conversation%2F1%2Fnotes.md`
 * are the same file, and only the encoded one survives being copied out of an address bar intact.
 */
function artifactKeyFromHash() {
  const raw = location.hash.replace(/^#/, '');
  if (!raw) return '';
  // `#e<number>` names a transcript entry, not a document. Both live in one fragment, so without
  // this an entry link would be read as a key, found in no list, and the page would drop the
  // fragment — silently losing the position it was asked to show.
  if (/^e\d+$/.test(raw)) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw; // not percent-encoded, but still names something
  }
}

/** The entry id the URL fragment names (`#e1234`), or undefined. */
function entryIdFromHash() {
  const match = /^#e(\d+)$/.exec(location.hash);
  return match ? Number(match[1]) : undefined;
}

/**
 * Open the document the URL names.
 *
 * Waits for the environment (the artifact host's address is fetched) and for the list, because a
 * document opens *from* the list: its row is what says whether it renders. A key that is no longer
 * one of this conversation's files leaves the list showing and drops the fragment, so the address bar
 * never claims something the page is not showing.
 */
async function restoreArtifact(key) {
  if (!key) return;
  await artifactsReady;
  if (artifactsBase === '' || !current) return;
  await setArtifactsOpen(true);
  const row = [...artifactsList.children].find((li) => li.dataset.key === key);
  if (!row) {
    try {
      history.replaceState({}, '', location.pathname);
    } catch {
      // Same as everywhere else: a refusal costs the address, not the drawer.
    }
    return;
  }
  showArtifact(key, row.dataset.markdown === '1', false, row.dataset.image === '1', 'right', row.dataset.pdf === '1');
}

/**
 * Rebuild the list.
 *
 * `preserve` is for a refresh the reader did not ask for: it keeps the document
 * they are reading open and restores the highlight, instead of dropping them back
 * to the list every time a turn ends.
 */
async function loadArtifacts(preserve) {
  const framed = preserve ? currentKey() : '';
  artifactsList.innerHTML = '';
  if (!current) return;
  let rows;
  try {
    rows = await (await apiFetch(rel('api/c/' + current + '/artifacts'))).json();
  } catch {
    rows = [];
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    artifactsHint.hidden = false;
    artifactsHint.textContent = 'No files were written or edited in this conversation.';
    return;
  }
  artifactsHint.hidden = rows.length > 0;
  for (const row of rows) {
    const li = document.createElement('li');
    li.dataset.key = row.key;
    li.dataset.markdown = row.markdown ? '1' : '';
    li.dataset.image = row.image ? '1' : '';
    li.dataset.pdf = row.pdf ? '1' : '';
    li.innerHTML = '<span class="col"><span class="name"></span><span class="dir"></span></span><span class="counts"></span>';
    // The name first and the directory underneath: a list of full paths is mostly
    // directory, and the drawer only needs enough to tell two files apart.
    li.querySelector('.name').textContent = baseName(row.key);
    li.querySelector('.dir').textContent = dirName(row.key);
    const counts = [];
    if (row.wrote) counts.push(row.wrote + (row.wrote === 1 ? ' write' : ' writes'));
    if (row.edited) counts.push(row.edited + (row.edited === 1 ? ' edit' : ' edits'));
    // What it is, beside what was done to it. A list of names gives no clue that
    // `logo.png` opens as a picture rather than as a page of source, and the
    // distinction is the whole reason the viewer needed a new kind of row.
    if (row.image) counts.unshift('image');
    else if (row.pdf) counts.unshift('pdf');
    else if (row.markdown) counts.unshift('markdown');
    li.querySelector('.counts').textContent = counts.join(', ');
    li.title = row.key;
    li.onclick = () =>
      showArtifact(row.key, Boolean(row.markdown), true, Boolean(row.image), 'right', Boolean(row.pdf));
    artifactsList.append(li);
  }
  if (preserve && framed !== '') {
    // Same document, same place: only the rows are new.
    for (const li of artifactsList.children) li.classList.toggle('on', li.dataset.key === framed);
    return;
  }
  // Open on the list: choosing is the first act, and the document takes the screen
  // once chosen.
  showArtifactList();
}

async function setArtifactsOpen(open) {
  artifactsOpen = open;
  artifactsPanel.hidden = !open;
  if (open) {
    void loadComments();
    await loadArtifacts();
  } else {
    applyListState();
    if (history.state && history.state.artifact) history.replaceState({}, '', location.pathname);
  }
}


/* How wide the drawer is: a choice, remembered, in pixels. `min(38rem, 45%)` is
   the starting point until you drag it — a percentage so a narrow window gets a
   proportional slice rather than a panel wider than the conversation. */
const ARTIFACTS_WIDTH_KEY = 'pi-artifacts-width';
const ARTIFACTS_MIN_W = 16 * 16;
const CONVERSATION_MIN_W = 15 * 16;
const artifactsResize = document.getElementById('artifacts-resize');
const workspace = document.getElementById('workspace');

try {
  const saved = Number(localStorage.getItem(ARTIFACTS_WIDTH_KEY));
  if (saved > 0) artifactsPanel.style.width = saved + 'px';
} catch {
  // Private mode: the default width is fine.
}

artifactsResize.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  artifactsResize.setPointerCapture(event.pointerId);
  artifactsPanel.classList.add('resizing');
  document.body.classList.add('resizing');
  const startX = event.clientX;
  const startWidth = artifactsPanel.getBoundingClientRect().width;
  // Leave the conversation something to live in: on a small window a panel that
  // can eat the whole width is the overlay problem again, by hand.
  const widest = Math.max(ARTIFACTS_MIN_W, workspace.clientWidth - CONVERSATION_MIN_W);
  const move = (moveEvent) => {
    const width = Math.min(widest, Math.max(ARTIFACTS_MIN_W, startWidth - (moveEvent.clientX - startX)));
    artifactsPanel.style.width = width + 'px';
  };
  const end = () => {
    artifactsPanel.classList.remove('resizing');
    document.body.classList.remove('resizing');
    artifactsResize.removeEventListener('pointermove', move);
    artifactsResize.removeEventListener('pointerup', end);
    artifactsResize.removeEventListener('pointercancel', end);
    try {
      localStorage.setItem(ARTIFACTS_WIDTH_KEY, String(Math.round(artifactsPanel.getBoundingClientRect().width)));
    } catch {
      // The width is a convenience; not worth failing over.
    }
  };
  artifactsResize.addEventListener('pointermove', move);
  artifactsResize.addEventListener('pointerup', end);
  artifactsResize.addEventListener('pointercancel', end);
});

artifactsButton.onclick = () => setArtifactsOpen(!artifactsOpen);
document.getElementById('artifacts-close').onclick = () => setArtifactsOpen(false);
artifactsBack.onclick = () => showArtifactList();

/**
 * Every artifact, in the order the list shows them.
 *
 * The list is the source of order, not the DOM's current highlight: the reader sees
 * these rows, and "next" has to mean the row below the one they are on, whether or
 * not it has been opened before.
 */
function artifactOrder() {
  return [...artifactsList.children].map((li) => ({
    key: li.dataset.key,
    markdown: li.dataset.markdown === '1',
    image: li.dataset.image === '1',
    pdf: li.dataset.pdf === '1',
  }));
}

/**
 * Move one artifact along, and say whether there was anywhere to go.
 *
 * `step` is +1 for the next row and -1 for the previous. It returns false at either
 * end rather than wrapping: a swipe past the last file that silently jumps back to
 * the first is a gesture people blame themselves for, and "there is nothing here" is
 * better said by nothing happening.
 */
function stepArtifact(step) {
  if (!artifactsPanel.classList.contains('showing-doc')) return false;
  const { order, at } = artifactAt();
  if (at < 0) return false;
  const to = at + step;
  if (to < 0 || to >= order.length) return false;

  // A keyboard step has no gesture, so nothing is loaded yet: park the neighbour,
  // bring the strip to rest beside it, then commit. The same carousel the finger
  // uses, so both arrive the same way and only one code path has to be right.
  const side = step > 0 ? 'next' : 'previous';
  gesture.side = null;         // force a fresh neighbour for this direction
  gesture.frame = null;
  prepareNeighbour(side);
  artifactsTrack.classList.add('no-animate');
  // With a neighbour on the left the strip's home is one pane along; at rest with a
  // neighbour on the right it is 0. Setting the right one *before* the animation
  // starts is what makes the slide travel from where the document actually sits.
  artifactsTrack.style.transform = side === 'previous' ? `translateX(${-paneWidth()}px)` : '';
  // Back to animating, and a frame for the browser to notice the position change —
  // without the flush the transform set above and the one the commit sets below
  // coalesce, and the step lands with no movement at all.
  artifactsTrack.classList.remove('no-animate');
  void artifactsTrack.offsetWidth;
  if (commitArtifactStep(side)) return true;
  hideNeighbour();
  return false;
}

/**
 * A step arriving from the framed document.
 *
 * The document is a sandboxed cross-origin frame, so its pointer events never reach
 * this page — the swipe is detected by the script inside it and posted here, the
 * same way a selection is. `event.source` identifies the frame because a sandboxed
 * frame's origin is the string "null", which no origin check could distinguish.
 */
function stepFromFrame(direction, commit) {
  if (!artifactsOpen) return;
  // `direction` is which way the *finger* travelled, which is how the document
  // reports it: moving left means the next artifact arrives from the right. Accepting
  // both spellings because the page's own vocabulary ("next"/"previous") is what the
  // keyboard uses, and the two are one step with two names.
  const side =
    direction === 'next' || direction === 'left'
      ? 'next'
      : direction === 'previous' || direction === 'right'
        ? 'previous'
        : '';
  if (!commit || !side) {
    // A release that is not a page turn, or the end of the list: the strip travels
    // back and the neighbour steps out of the way. That bounce is the honest answer
    // when there is nothing to move to.
    releaseArtifactPane();
    return;
  }
  // The neighbour is already loaded and the strip is part-way there, so the step is
  // the rest of the journey rather than a fresh slide.
  if (!commitArtifactStep(side)) releaseArtifactPane();
}

/**
 * The gesture's state, which lives only while a finger is down.
 *
 * `side` is which neighbour is loaded ('next', 'previous', or null for none) and
 * `frame` is that neighbour. Both are cleared by `hideNeighbour`, and a gesture that
 * is not dragging has neither — there is no such thing as a neighbour parked with
 * nothing going on.
 */
const gesture = {
  /** Which neighbour is loaded: 'next', 'previous', or null for none. */
  side: null,
  /** That neighbour's frame, or null. */
  frame: null,
  /**
   * True while a step is animating between two documents.
   *
   * The bounce timer and the step both want to tidy up the neighbour, and only one of
   * them should: a step owns its neighbour until it has swapped it in.
   */
  sliding: false,
};

/** The artifact the drawer is showing, in list order, and its neighbours. */
function artifactAt() {
  const order = artifactOrder();
  const at = order.findIndex((entry) => entry.key === currentKey());
  return {
    order,
    at,
    previous: at > 0 ? order[at - 1] : undefined,
    next: at >= 0 && at < order.length - 1 ? order[at + 1] : undefined,
  };
}

/**
 * Park the neighbour that a drag in *that* direction would reveal.
 *
 * Both sides cannot be loaded at once: that is two more frames, two more documents
 * and two more sets of scripts for a gesture that only ever goes one way. So the
 * side is chosen once the direction is known — on the first move of the gesture —
 * and a drag the other way is damped, because there genuinely is nothing there to
 * show until the finger turns round.
 *
 * The frame is positioned by order in the strip, not by CSS: the previous artifact
 * sits to the left of the current pane and the next to its right, so the same
 * `translateX` reveals whichever one is loaded.
 */
function prepareNeighbour(side) {
  if (gesture.side === side) return;
  const { previous, next } = artifactAt();
  const entry = side === 'next' ? next : side === 'previous' ? previous : undefined;
  if (!entry) {
    hideNeighbour();
    return;
  }
  gesture.side = side;
  // The neighbour is a frame from the pool, exactly like the current document — often
  // one that is already loaded from an earlier visit, which is why a step costs
  // nothing and shows a real page from the first pixel of the drag.
  gesture.frame = frameFor(
    entry.key,
    entry.markdown,
    entry.image,
    artifactUrl(entry.key, entry.markdown, entry.image, entry.pdf),
    entry.pdf,
  );
  gesture.frame.hidden = false;
  // Order in the strip: `order: -1` puts it before the current pane (left), the
  // default order after it (right).
  gesture.frame.style.order = side === 'previous' ? '-1' : '1';
}

/** Drop the neighbour: nothing is being dragged any more, so nothing should sit beside. */
function hideNeighbour() {
  gesture.side = null;
  // Parked, not unloaded: the document stays in the pool, so returning to it is
  // instant. Only the *place in the strip* is given up.
  if (gesture.frame && gesture.frame !== currentFrame) parkFrame(gesture.frame);
  gesture.frame = null;
}

/**
 * Move the strip with the finger.
 *
 * No transition: the reader is holding the document at a position of their own
 * choosing, and easing after their finger would feel like lag. The pane follows
 * one-to-one while there is a neighbour to reveal, and is damped where there is
 * not — at the ends of the list, and in a direction whose neighbour has not been
 * loaded yet, because a document that slides away to show blank space is a promise
 * with nothing behind it.
 */
function dragArtifactPane(dx) {
  if (!artifactsPanel.classList.contains('showing-doc')) return;
  const { previous, next } = artifactAt();
  // Which way is this going? Decided from the first few pixels and kept, so a
  // gesture that wobbles does not reload the neighbour frame mid-drag.
  const side = dx < 0 ? 'next' : 'previous';
  const available = side === 'next' ? next : previous;
  if (available) prepareNeighbour(side);

  // Negative dx drags towards the next document, which is where the neighbour sits.
  // Damped where there is no neighbour to reveal, and capped at one pane so a long
  // drag cannot pull the strip completely off — beyond a pane there is nothing to show.
  const limit = paneWidth();
  const offset = Math.max(-limit, Math.min(limit, available === undefined ? dx * 0.25 : dx));

  // Where the strip *rests* depends on which side the neighbour is on: with one
  // parked to the left (order: -1) it occupies the first slot, so the current
  // document sits one pane along and the strip's home is one pane to the left.
  const home = gesture.side === 'previous' ? -paneWidth() : 0;
  artifactsTrack.classList.add('no-animate');
  artifactsTrack.style.transform = `translateX(${home + offset}px)`;
}

/**
 * The width of one pane, which is the drawer's own width.
 *
 * Clamped to something positive because a DOM with no layout reports 0 for both the
 * drawer and the window — and a zero pane width makes every drag offset clamp to
 * zero, so gestures silently do nothing.
 */
function paneWidth() {
  return artifactsDoc.getBoundingClientRect().width || window.innerWidth || 320;
}

/**
 * Put the strip back, animated.
 *
 * The bounce at the ends of the list, and the release of a drag that did not go far
 * enough. The neighbour is dropped after the bounce rather than before, so the pane
 * does not snap to blank while it is still travelling home.
 */
function releaseArtifactPane() {
  artifactsTrack.classList.remove('no-animate');
  // Home, which is not always zero: a neighbour parked on the left means the strip
  // lives one pane along. A CSS class cannot express that, so it is a value.
  artifactsTrack.style.transform = gesture.side === 'previous' ? `translateX(${-paneWidth()}px)` : '';
  // Once home — 200ms is the transition — the neighbour has nothing to be beside.
  clearTimeout(releaseArtifactPane.timer);
  releaseArtifactPane.timer = setTimeout(() => {
    // Not while a step is finishing; that keeps its own neighbour until it swaps.
    if (!gesture.sliding) hideNeighbour();
  }, 220);
}

/**
 * Finish the gesture: carry the strip one pane along, then make the neighbour
 * current.
 *
 * This is the "no bounce" the request asked for — the document keeps travelling the
 * way the finger was going and leaves the screen, with the neighbour arriving behind
 * it. The swap of what `#artifact-frame` holds happens at the end, while the strip is
 * a pane away, so nothing is seen to reload.
 */
function commitArtifactStep(side) {
  if (!gesture.side || side !== gesture.side) return false;
  const { previous, next } = artifactAt();
  const entry = side === 'next' ? next : side === 'previous' ? previous : undefined;
  if (!entry) return false;

  // The strip travels the rest of the way, with the neighbour arriving in its wake.
  gesture.sliding = true;
  artifactsTrack.classList.remove('no-animate');
  // Travel the rest of the way in the gesture's direction, one pane. In pixels, not
  // percentages: a percentage translates by the strip's *own* width, and the strip is
  // as wide as the frames attached to it — two panes once a neighbour is parked — so
  // `-100%` would be two documents rather than one.
  const pane = paneWidth();
  const home = gesture.side === 'previous' ? -pane : 0;
  const target = side === 'next' ? home - pane : home + pane;
  artifactsTrack.style.transform = `translateX(${target}px)`;

  // Whether anything will actually animate. Reduced motion, a hidden tab, and a DOM
  // with no layout at all (the tests) all mean the transition never fires — and
  // waiting on a timer there is both slow and, in a test, the reason a step looked
  // like it did nothing. With no animation to wait for, the swap is done now.
  const animates = typeof artifactsTrack.getAnimations === 'function'
    && window.matchMedia
    && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    && document.visibilityState === 'visible';

  const settle = () => {
    artifactsTrack.removeEventListener('transitionend', settle);
    clearTimeout(commitArtifactStep.park);
    // The strip has finished travelling: the neighbour now fills the window and the
    // old document is off-screen. Making the neighbour *current* is therefore only a
    // change of which frame is at rest in the middle — nothing is loaded here, and
    // nothing visible changes content. That is what removes the flicker for good: the
    // document that slides in was already painted before the gesture began.
    artifactsTrack.classList.add('no-animate');
    artifactsTrack.style.transform = '';
    // The frame that was current is parked out of the strip by `setCurrentFrame` —
    // hidden, not removed, so going back is instant.
    setCurrentFrame(gesture.frame);
    artefactsAfterStep(entry);
    hideNeighbour();
    gesture.sliding = false;
  };

  if (!animates) {
    settle();
    return true;
  }
  artifactsTrack.addEventListener('transitionend', settle, { once: true });
  // A transition that never fires must not leave the strip parked off-screen.
  clearTimeout(commitArtifactStep.park);
  commitArtifactStep.park = setTimeout(() => {
    if (gesture.sliding) settle();
  }, 260);
  return true;
}

/** The page-level bookkeeping that follows a completed step. */
function artefactsAfterStep(entry) {
  for (const li of artifactsList.children) li.classList.toggle('on', li.dataset.key === entry.key);
  artifactsTitle.textContent = baseName(entry.key);
  artifactsTitle.title = entry.key;
  artifactsNewTab.dataset.key = entry.key;
  artifactsNewTab.dataset.markdown = entry.markdown ? '1' : '';
  artifactsNewTab.dataset.image = entry.image ? '1' : '';
  artifactsNewTab.dataset.pdf = entry.pdf ? '1' : '';
  closeCommentBar();
  closeThread();
}

artifactsNewTab.onclick = () => {
  const key = artifactsNewTab.dataset.key;
  if (key) {
    // An image opens as itself, not as the wrapper that frames it: a new tab is
    // where you want the picture, and the browser's own viewer gives it the whole
    // window and a right-click "Save as".
    //
    // A PDF opens as the PDF. The drawer shows one rasterised page because a page is
    // what a rectangle can be drawn on, but a tab is for reading, and the browser's
    // own viewer has text selection, links and zoom that a rendered image cannot.
    const isImage = artifactsNewTab.dataset.image === '1';
    const isPdf = artifactsNewTab.dataset.pdf === '1';
    window.open(
      isImage
        ? rawArtifactUrl(key)
        : isPdf
          ? pdfRawUrl(key)
          : artifactUrl(key, artifactsNewTab.dataset.markdown === '1', false),
      '_blank',
      'noopener',
    );
  }
};
document.addEventListener('keydown', (event) => {
  if (!artifactsOpen) return;
  // Left and right walk the artifacts — the keyboard's version of the swipe, and
  // the only way to page through them without a pointer.
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    // Not while typing: the composer and the comment box are both on this page, and
    // an arrow key in one of them belongs to the text.
    const target = event.target;
    const typing = target instanceof HTMLElement
      && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    if (typing) return;
    // Only when there is a document to page through; otherwise the key does what it
    // always did and scrolls whatever has focus.
    if (!artifactsPanel.classList.contains('showing-doc')) return;
    if (!stepArtifact(event.key === 'ArrowRight' ? 1 : -1)) return;
    // Claimed, so the pane behind the drawer does not also scroll.
    event.preventDefault();
    return;
  }
  if (event.key !== 'Escape') return;
  // Escape steps back one screen: document → list → closed.
  if (artifactsPanel.classList.contains('showing-doc')) showArtifactList();
  else setArtifactsOpen(false);
});

// The panel is pointless without an artifact host to point at, so it stays
// hidden unless the deployment says where that is.
const artifactsReady = (async () => {
  try {
    const environment = await (await apiFetch(rel('api/environment'))).json();
    artifactsBase = String(environment.artifactsBaseUrl || '').replace(/\/$/, '');
    artifactsButton.hidden = artifactsBase === '';
    pageVersion = String(environment.pageVersion || '');
  } catch {
    artifactsButton.hidden = true;
  }
})();
