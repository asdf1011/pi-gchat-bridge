// Who owns a horizontal drag. Included here as well as in `region.js` — both are separate
// script blocks in the image document — and guarded there so the state survives both.
/* @@include:gesture.js@@ */

  // --- Swiping between artifacts --------------------------------------------
  //
  // Two gestures share this surface, and getting the test wrong is what makes a
  // document feel broken: a horizontal swipe must page, and a vertical drag must
  // still scroll. So nothing is decided until the gesture is over, and then only if
  // the movement was dominantly horizontal and long enough to be deliberate.
  //
  // "Over" is touchend OR touchcancel, and that distinction is the whole reason
  // this is not a dozen lines. On iOS a touch the system claims — which includes a
  // horizontal drag that turns into a back-navigation swipe, and any gesture the
  // scroll view decides it owns — is ended with touchcancel, and touchend never
  // arrives. A handler that only listens for touchend therefore works on desktop
  // Chromium and does nothing on the phone, which is exactly the bug this rewrite
  // fixes: the position is tracked on every touchmove, so a cancelled gesture can
  // still be judged from where it had got to.
  (function () {
    var DISTANCE = 60;       // how far a swipe has to travel to count (a tap is ~0)
    var RATIO = 1.5;         // horizontal must beat vertical by this much
    var SLOW = 800;          // longer than this is a drag, not a flick
    var start = null;
    var last = null;
    /**
     * Whether a horizontal drag is the *page's* to claim right now.
     *
     * Two things can own a horizontal movement on this surface, and only one of them can
     * have it. While a rectangle is being selected, the drag is drawing that box. While
     * the picture is zoomed in, the drag pans it. In both cases the document consumes the
     * gesture, and paging must not begin underneath it — which is what made a drag feel
     * like a coin toss between moving the picture and moving to the next artifact.
     *
     * The document is also the only party that can answer: it knows whether it is armed,
     * and only it knows how much of the picture is left to pan. So it reports both, and
     * this script simply obeys.
     */
    /**
     * Whether the document owns a drag whose finger moves `dx` pixels horizontally.
     *
     * Asked, not held. This script used to keep its own copy of the answer — `pageLocked`
     * and `sides`, refreshed by a message from its sibling — which meant the same fact in
     * two places, and the copy was only refreshed when something happened to publish it. On
     * load, and after a window resize, the two disagreed until a gesture settled it.
     *
     * `gestureOwner` is in the same scope, so this is a function call. In documents with no
     * zoom and no rectangle (the source and rendered views) the object is absent and nothing
     * there can own a horizontal drag, which is what that question returns.
     */
    function owned(dx) {
      if (typeof gestureOwner === "undefined") return false;
      return gestureOwner.owns(dx);
    }

    function pointOf(event) {
      // changedTouches is where a touch really is; clientX is 0 on some browsers
      // for a touchend, which would read every swipe as a huge one.
      var touch = event.changedTouches && event.changedTouches[0];
      if (touch) return { x: touch.clientX, y: touch.clientY };
      var live = event.touches && event.touches[0];
      if (live) return { x: live.clientX, y: live.clientY };
      if (typeof event.clientX === "number") return { x: event.clientX, y: event.clientY };
      return null;
    }

    /** Judge the gesture that just ended, from wherever it had reached. */
    function settle(event) {
      if (!start) return;
      var from = start;
      var to = last || pointOf(event);
      start = null;
      last = null;
      if (!to) return;
      var dx = to.x - from.x;
      var dy = to.y - from.y;
      var absX = Math.abs(dx);
      var absY = Math.abs(dy);
      // Anything that does not qualify leaves the pane wherever the drag put it,
      // so it has to be released before each of these early returns.
      function abort() {
        parent.postMessage({ t: "pi-artifact-drag-end", commit: false }, "*");
      }
      // The document owned this gesture, so it never was a page turn. Released with
      // commit false like any other abort, because the pane may have been nudged before
      // the ownership was known.
      if (owned(dx)) return abort();
      if (absX < DISTANCE) return abort();
      if (absX < absY * RATIO) return abort();   // mostly vertical: a scroll
      if (Date.now() - from.at > SLOW) return abort();
      // A selection the reader is making is not a page turn either.
      var selection = window.getSelection && window.getSelection();
      if (selection && !selection.isCollapsed) {
        // Not a page turn, so the pane must go back where it was.
        parent.postMessage({ t: "pi-artifact-drag-end", commit: false }, "*");
        return;
      }
      // commit says the drawer may keep the movement and finish the slide; the
      // direction tells it which way to bring the next document in.
      parent.postMessage(
        { t: "pi-artifact-swipe", direction: dx < 0 ? "left" : "right", commit: true },
        "*",
      );
    }

    document.addEventListener("touchstart", function (event) {
      // Two fingers is a pinch or a system gesture, not a page turn.
      if (event.touches && event.touches.length > 1) { start = null; last = null; return; }
      var point = pointOf(event);
      start = point ? { x: point.x, y: point.y, at: Date.now() } : null;
      last = point;
    }, { passive: true });

    // Tracking on move does two things: it keeps a cancelled gesture judgeable, and
    // it is what lets the drawer follow the finger. Every move reports the offset
    // once the gesture has committed to being horizontal — before that, the reader
    // may still be scrolling, and moving the page then would fight them.
    document.addEventListener("touchmove", function (event) {
      if (!start) return;
      var point = pointOf(event);
      if (!point) return;
      last = point;
      var dx = point.x - start.x;
      var dy = point.y - start.y;
      var absX = Math.abs(dx);
      var absY = Math.abs(dy);
      // The document owns this direction, so the pane does not follow the finger at all. The
      // old slop test used to decide this by accident — the pane only moved once the drag was
      // horizontal enough — but a selection or a pan is horizontal too, so the slop cannot
      // tell them apart. The document can, and says so.
      if (owned(dx)) return;
      // Past the slop, and clearly more horizontal than vertical. Both conditions
      // have to hold before anything moves: a diagonal drag that keeps scrolling
      // must not drag the document sideways while it does.
      if (absX < 8 || absX < absY * RATIO) return;
      parent.postMessage({ t: "pi-artifact-drag", dx: dx }, "*");
    }, { passive: true });

    document.addEventListener("touchend", settle, { passive: true });
    // iOS ends an interrupted gesture here; judge it on the way out rather than
    // throwing the whole swipe away.
    document.addEventListener("touchcancel", settle, { passive: true });

    // A trackpad's two-finger swipe arrives as a wheel event with a horizontal
    // delta, and it is the same gesture to the person making it. Events stream, so
    // this accumulates until the momentum dies down and fires once.
    var travel = 0;
    // NOT named "settle": that is the touch handler's name, and var hoists — a
    // second "var settle" in this same scope overwrote the function with null
    // before addEventListener("touchend", settle) ran, so every swipe bound null
    // and no gesture was ever judged. This is the bug that made swiping do nothing
    // on a real device while the code read correctly.
    var wheelTimer = null;
    document.addEventListener("wheel", function (event) {
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) { travel = 0; return; }
      if (event.ctrlKey) return;              // ctrl+wheel is zoom
      if (owned(event.deltaX)) { travel = 0; return; } // the document owns this direction
      var selection = window.getSelection && window.getSelection();
      if (selection && !selection.isCollapsed) return;
      travel += event.deltaX;
      if (wheelTimer) clearTimeout(wheelTimer);
      wheelTimer = setTimeout(function () {
        var moved = travel;
        travel = 0;
        wheelTimer = null;
        if (Math.abs(moved) < 60) return;
        parent.postMessage({ t: "pi-artifact-swipe", direction: moved > 0 ? "left" : "right" }, "*");
      }, 120);
    }, { passive: true });
  })();
