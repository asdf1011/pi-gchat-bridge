// Who owns a horizontal drag in this document.
//
// Two gestures want the same finger. The drawer pages between artifacts on a horizontal
// swipe; this document draws a comment rectangle when armed, and pans a zoomed picture. Only
// one of them can have any given drag, and getting that wrong is what made a drag feel like a
// coin toss between moving the picture and moving to the next artifact.
//
// This used to be settled by the two scripts posting messages at each other. That worked, but
// it meant the same fact existed in four places — `armed` and `zoom` in `region.js`, and
// `pageLocked` plus `sides` in `swipe.js` — which could disagree, and did: the state was only
// published when something happened to call `report()`, so on load, or after a resize, the
// two scripts disagreed until the reader's first gesture settled it.
//
// So the state lives here, once. `region.js` *sets* it; `swipe.js` *asks* it. Neither holds a
// copy, and there is no message between them.
//
// Loaded into the image document only — the source and rendered views have no zoom and no
// rectangle, so their swipe script asks a question with one possible answer and this is not
// included there.

/**
 * The drag owner.
 *
 * `armed` is a comment rectangle being drawn: it owns every horizontal drag, because a
 * rectangle has no direction.
 *
 * `panLeft` and `panRight` say whether the zoomed picture still has somewhere to go that way.
 * A finger moving right scrolls the content right, which needs content to the left — so
 * `panLeft` is what a rightward drag needs. When neither is true nothing can be panned and
 * the drawer owns the drag: "page only when we cannot drag any further", which is the rule
 * the whole thing exists to express.
 */
// A guarded declaration: `swipe.js` and `region.js` may both include this file, and in the
// image document they are two script blocks, so a bare `var` would be re-run rather than
// re-declared. Re-running it would reset the state to unowned the moment the second block
// executed, which is a silent version of the bug this file exists to remove.
var gestureOwner = typeof gestureOwner === "undefined" ? {
  armed: false,
  panLeft: false,
  panRight: false,

  /**
   * Update the state, and say so, so nothing else has to poll it.
   *
   * The subscriber is the swipe script, which is in the same scope — one function, called
   * directly, rather than a message that could arrive late or not at all.
   */
  report: function (next) {
    this.armed = next.armed === true;
    this.panLeft = next.panLeft === true;
    this.panRight = next.panRight === true;
    if (typeof this.onChange === "function") this.onChange();
  },

  /** Whether the document owns a drag whose finger moves `dx` pixels horizontally. */
  owns: function (dx) {
    if (this.armed) return true;
    return dx > 0 ? this.panLeft : this.panRight;
  }
} : gestureOwner;
