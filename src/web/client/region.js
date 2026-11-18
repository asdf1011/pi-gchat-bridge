// The gesture owner: who gets a horizontal drag. Loaded before this script, in the same
// scope, so this one *sets* it and `swipe.js` *asks* it — one answer, no copies.
/* @@include:gesture.js@@ */

  // --- Choosing part of a picture ------------------------------------------
  //
  // A picture has no lines to select, so the commentable unit is a rectangle dragged
  // over it. What the parent needs is the rectangle **in the picture's own pixels**: a
  // picture is scaled to fit the drawer, so the pixels under the finger are not the
  // pixels in the file, and a rectangle counted in screen pixels would point somewhere
  // else the moment the drawer is a different width. The scale is naturalWidth /
  // drawnWidth, and it is applied here because this document is the only party that
  // knows both numbers.
  //
  // Every message here is report-only, like the selection script: this origin cannot
  // submit anything, and the parent decides what a rectangle means.
  (function () {
    var image = document.querySelector("img.crop-target");
    if (!image) return;

    var MIN_SIDE = 8;        // a tap is not a selection (see MIN_REGION_SIDE in comments.ts)
    var drag = null;         // { x, y } where the finger went down, in client coordinates
    var marquee = null;      // the box being drawn

    /** The drag so far, in the picture's own pixels, or null when it is not a selection. */
    function regionOf(from, to) {
      var naturalWidth = image.naturalWidth || 0;
      var naturalHeight = image.naturalHeight || 0;
      var box = image.getBoundingClientRect();
      if (naturalWidth < 1 || naturalHeight < 1 || box.width < 1 || box.height < 1) return null;
      // The picture is fitted, so one scale serves both axes and the letterbox is
      // outside box — a drag starting on the empty margin is clamped to the edge
      // rather than refused, because it obviously meant the picture.
      var scaleX = naturalWidth / box.width;
      var scaleY = naturalHeight / box.height;
      var left = Math.max(0, Math.min(from.x, to.x) - box.left) * scaleX;
      var top = Math.max(0, Math.min(from.y, to.y) - box.top) * scaleY;
      var right = Math.min(box.width, Math.max(from.x, to.x) - box.left) * scaleX;
      var bottom = Math.min(box.height, Math.max(from.y, to.y) - box.top) * scaleY;
      var region = {
        x: Math.round(left),
        y: Math.round(top),
        width: Math.round(right - left),
        height: Math.round(bottom - top),
        imageWidth: naturalWidth,
        imageHeight: naturalHeight
      };
      if (region.width < MIN_SIDE || region.height < MIN_SIDE) return null;
      return region;
    }

    /**
     * Take the box down and forget the drag.
     *
     * `keep` leaves the box on the picture, which is what happens when a selection is made:
     * the reader has just drawn a rectangle and needs to see it while they write the comment,
     * to check it covers what they meant. It was removed the moment the finger lifted, so the
     * region vanished at the exact moment it became the thing being commented on.
     */
    function clear(keep) {
      if (marquee && !keep && marquee.parentNode) marquee.parentNode.removeChild(marquee);
      if (!keep) marquee = null;
      drag = null;
    }

    /**
     * Tell the drawer this document can take a rectangle.
     *
     * Sent once, when the picture has loaded. What the drawer needs is a fact about the
     * document — whether pressing the comment button should arm it — and the button is on
     * screen from the moment the document is, so a message deferred until a tap would offer
     * it late, or for documents that cannot use it.
     *
     * Nothing else travels: the picture's size is already known to the zoom, which measures
     * it in this document, and the drawer has no use for it.
     */
    function announce() {
      parent.postMessage(
        { t: "pi-artifact-image", file: document.body.getAttribute("data-file") || "" },
        "*"
      );
    }
    if (image.complete) announce();
    else image.addEventListener("load", announce, { once: true });

    // --- Zooming the picture, and nothing else --------------------------------
    //
    // The browser's own pinch-zoom is deliberately off (see the stylesheet): it scales the
    // *visual viewport*, which belongs to the top-level page, so pinching a picture zoomed
    // the drawer's header and the comment button along with it. What a reader wants is to
    // look closely at the picture, so the zoom is applied here, as a transform on the img,
    // and the frame — and everything around it — stays exactly where it is.
    //
    // Two input paths, because the devices differ:
    //   - **two pointers** (touch screens) — track distance and midpoint;
    //   - **ctrl + wheel** (trackpads and desktops) — the conventional pinch, and what a
    //     keyboard-driven magnification sends.
    //
    // Double-tap and double-click toggle a comfortable 2x, which is the gesture people
    // reach for on a phone before they reach for two fingers.

    var stage = document.querySelector(".stage");
    var MIN_ZOOM = 1;
    var MAX_ZOOM = 8;
    var zoom = 1;
    var pointers = {};      // pointerId -> {x, y}, so a pinch knows how far apart they are
    var pinch = null;       // { distance, zoom } captured when the second finger landed
    var pan = null;         // { x, y, left, top } for a one-finger drag while zoomed

    /**
     * Tell the page whether a horizontal drag is the document's, or the drawer's.
     *
     * The drawer pages between artifacts on a horizontal swipe, and this document can also
     * own a horizontal drag — drawing a rectangle when armed, panning when zoomed in. Only
     * one of the two can have it, and the document is the only party that knows which.
     *
     * "Can we drag any further" is the reader's phrasing and it is the right rule: while
     * the picture still has somewhere to pan in that direction, the drag pans it; once it
     * is against the edge, the same drag pages. That is why this is not simply "armed or
     * zoomed" — a zoomed picture scrolled to its left edge has nothing left to give.
     */
        /**
     * Publish who owns a horizontal drag, into the one place that answers for it.
     *
     * This script is the only party that can answer: it knows whether a rectangle is being
     * drawn, and only it knows how much of a zoomed picture is left to pan. So it *sets*;
     * `swipe.js` asks `gestureOwner.owns()`, and holds no copy that could go stale.
     *
     * Called whenever the answer changes — arming, zooming, and panning to an edge — which
     * includes the cases that were previously never published at all (a picture that loads
     * already zoomed, a window that resized). Those left the drawer paging under a
     * rectangle until the first gesture settled it.
     */
    function reportGesture() {
      var scroller = document.scrollingElement;
      var zoomed = zoom > 1 && scroller !== null;
      // A picture pinned to its right edge has nowhere further to go right, so a finger
      // heading right is the drawer's; one heading left still pans.
      var maxLeft = zoomed ? scroller.scrollWidth - scroller.clientWidth : 0;
      gestureOwner.report({
        armed: armed,
        panLeft: zoomed && scroller.scrollLeft > 1,
        panRight: zoomed && scroller.scrollLeft < maxLeft - 1
      });
    }

    /**
     * How big the picture is at fit, before any transform.
     *
     * Measured with the transform off and remembered. Reading offsetWidth while scaled gives
     * the unscaled box, which is fine — but reading it while the *stage* has an explicit
     * width does not: the picture is a flex item with max-width 100 percent, so sizing its
     * container to the scaled picture makes it collapse to zero, and every later
     * measurement is zero too. That is the loop this avoids.
     */
    var fitted = null;

    function measureFit() {
      // Every inline size has to be released, not just the transform: applyZoom pins the
      // picture to its fitted width, so measuring while that is set would measure the pinned
      // box and call it the fit. Re-measuring then happens after a resize, which is exactly
      // when the two differ.
      var was = {
        transform: image.style.transform,
        width: image.style.width,
        height: image.style.height,
        maxWidth: image.style.maxWidth,
        maxHeight: image.style.maxHeight
      };
      image.style.transform = "";
      image.style.width = "";
      image.style.height = "";
      image.style.maxWidth = "";
      image.style.maxHeight = "";
      fitted = { width: image.offsetWidth, height: image.offsetHeight };
      image.style.transform = was.transform;
      image.style.width = was.width;
      image.style.height = was.height;
      image.style.maxWidth = was.maxWidth;
      image.style.maxHeight = was.maxHeight;
      return fitted;
    }

    function applyZoom() {
      if (stage && zoom !== 1) {
        // Pin the picture at its fitted size *before* resizing anything around it.
        //
        // This is the whole bug the first version had: the img is max-width 100 percent of
        // its container, so growing the stage to fit times zoom let the picture lay out
        // larger than fit (up to its natural size), and the transform then scaled that. The
        // stage and the picture disagreed about how big the picture was, so the scroll
        // extent was wrong and the picture could not be dragged to its edges — it ran out of
        // room before the content did.
        //
        // A fixed width in the fitted pixels makes the picture's layout box exactly what the
        // stage was sized from, and the transform becomes the only thing that changes its
        // size. That is also why the measurement is taken while this is still auto.
        var fit = fitted || measureFit();
        image.style.width = fit.width + "px";
        image.style.height = fit.height + "px";
        image.style.maxWidth = "none";
        image.style.maxHeight = "none";
        // No auto margins while zoomed. The picture's layout box stays at its fitted size and
        // the transform does the growing, so an auto margin would centre that small box in a
        // stage already sized to the scaled picture: hundreds of pixels of slack on each
        // side, which the reader can scroll into and which is not picture. Top-left
        // alignment plus a top-left transform origin makes the stage and the drawn picture
        // the same rectangle.
        image.style.margin = "0";
        image.style.transform = "scale(" + zoom + ")";
        // The stage is exactly the drawn picture, with no padding of its own: the stage's
        // box is what the browser scrolls, so any slack in it is scroll room past the
        // picture's edge — visible as a band of empty space the reader can drag into.
        var width = Math.round(fit.width * zoom);
        var height = Math.round(fit.height * zoom);
        stage.style.width = width + "px";
        stage.style.height = height + "px";
        stage.style.minWidth = width + "px";
        stage.style.minHeight = height + "px";
        stage.style.padding = "0";
      } else {
        // Back to fit: every inline size handed out above is released, so the picture is
        // laid out by the stylesheet again and the stage is the window.
        image.style.transform = "";
        image.style.width = "";
        image.style.height = "";
        image.style.maxWidth = "";
        image.style.maxHeight = "";
        image.style.margin = "";
        image.style.transformOrigin = "";
        if (stage) {
          stage.style.width = "";
          stage.style.height = "";
          stage.style.minWidth = "";
          stage.style.minHeight = "";
          stage.style.padding = "";
        }
      }
      // After a layout, not during one: the lock depends on scrollWidth, which is only
      // right once the browser has laid the new stage size out.
      requestAnimationFrame(reportGesture);
    }

    // The fit is measured once the picture has a size of its own, and re-measured when the
    // window changes: a rotation or a drawer resize gives a different "fitted".
    function remeasure() {
      fitted = null;
      if (zoom === 1) measureFit();
      // A resize can change what a zoomed picture has room to pan, so the answer has to be
      // republished. It used to be published only when something happened to call it, which
      // meant a picture that loaded already zoomed, or a window that resized, left the two
      // scripts disagreeing until a gesture settled it.
      reportGesture();
    }
    if (image.complete) remeasure();
    else image.addEventListener("load", remeasure, { once: true });
    window.addEventListener("resize", remeasure);

    /**
     * Zoom about a point, so the thing under the fingers stays under them.
     *
     * Scaling about the centre is right for a slider and wrong for a pinch: the reader is
     * looking at a particular corner. The scroll position is adjusted by the ratio the
     * point moves, which is the same arithmetic a map uses.
     */
    function zoomAbout(next, clientX, clientY) {
      var clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next));
      if (clamped === zoom) return;
      var before = zoom;
      // Where the point sits relative to the scroll window, before and after scaling.
      var rect = image.getBoundingClientRect();
      var offsetX = clientX - rect.left;
      var offsetY = clientY - rect.top;
      zoom = clamped;
      applyZoom();
      var after = image.getBoundingClientRect();
      document.scrollingElement.scrollLeft += after.left + offsetX * (zoom / before) - clientX;
      document.scrollingElement.scrollTop += after.top + offsetY * (zoom / before) - clientY;
    }

    function distanceBetween(a, b) {
      return Math.hypot(a.x - b.x, a.y - b.y);
    }

    function midpointOf(a, b) {
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }

    document.addEventListener("pointerdown", function (event) {
      if (armed) return;                       // armed means selecting, not zooming
      pointers[event.pointerId] = { x: event.clientX, y: event.clientY };
      var ids = Object.keys(pointers);
      if (ids.length === 2) {
        // A second finger is a pinch. It also cancels a pan: the gesture that started as
        // one finger moving is now two fingers scaling.
        pan = null;
        pinch = { distance: distanceBetween(pointers[ids[0]], pointers[ids[1]]), zoom: zoom };
      } else if (ids.length === 1 && zoom > 1) {
        // Panning is only meaningful when zoomed in; at 1x the browser's own scrolling
        // (and the drawer's swipe) own the gesture.
        pan = { x: event.clientX, y: event.clientY,
                left: document.scrollingElement.scrollLeft, top: document.scrollingElement.scrollTop };
      }
    });

    document.addEventListener("pointermove", function (event) {
      if (!pointers[event.pointerId]) return;
      pointers[event.pointerId] = { x: event.clientX, y: event.clientY };
      if (armed) return;

      var ids = Object.keys(pointers);
      if (pinch && ids.length >= 2) {
        var distance = distanceBetween(pointers[ids[0]], pointers[ids[1]]);
        if (pinch.distance > 0) {
          var mid = midpointOf(pointers[ids[0]], pointers[ids[1]]);
          zoomAbout(pinch.zoom * (distance / pinch.distance), mid.x, mid.y);
        }
        event.preventDefault();
        return;
      }
      if (pan && ids.length === 1) {
        document.scrollingElement.scrollLeft = pan.left - (event.clientX - pan.x);
        document.scrollingElement.scrollTop = pan.top - (event.clientY - pan.y);
        event.preventDefault();
        // Reaching an edge is what hands the gesture to the drawer, so the answer changes
        // mid-gesture and has to be re-reported rather than decided at the start.
        reportGesture();
      }
    });

    function lift(event) {
      delete pointers[event.pointerId];
      if (Object.keys(pointers).length < 2) pinch = null;
      if (Object.keys(pointers).length === 0) pan = null;
    }
    document.addEventListener("pointerup", lift);
    document.addEventListener("pointercancel", lift);

    // A trackpad's pinch arrives as ctrl+wheel, and so does a keyboard zoom. passive
    // false, because the browser's own page zoom has to be prevented for this to work.
    document.addEventListener("wheel", function (event) {
      if (armed || !event.ctrlKey) return;
      event.preventDefault();
      // A trackpad sends many small deltas and a mouse wheel sends one coarse click, so the
      // per-event factor is clamped: without it a single notch of a mouse wheel jumps
      // straight to the maximum, which reads as "zoom is broken" rather than "too fast".
      var factor = Math.exp(-event.deltaY * 0.01);
      factor = Math.max(0.7, Math.min(1.4, factor));
      zoomAbout(zoom * factor, event.clientX, event.clientY);
    }, { passive: false });

    // Double-tap or double-click: the gesture people reach for first. 1x and 2x, so it is
    // a toggle in both directions rather than a ladder nobody can get out of.
    function toggleZoom(clientX, clientY) {
      if (armed) return;
      if (zoom > 1) {
        // Back to fit, and back to the top-left: a picture reset to 1x but scrolled to
        // where it was when zoomed shows an empty corner and reads as still broken.
        zoom = MIN_ZOOM;
        applyZoom();
        document.scrollingElement.scrollLeft = 0;
        document.scrollingElement.scrollTop = 0;
        return;
      }
      zoomAbout(2, clientX, clientY);
    }
    image.addEventListener("dblclick", function (event) {
      event.preventDefault();
      toggleZoom(event.clientX, event.clientY);
    });

    /**
     * Whether a drag should draw a rectangle right now.
     *
     * The parent owns this decision — the comment button presses it — and it arrives as
     * a message, because a framed document cannot read the page that frames it. Until
     * it says so the picture belongs to the browser: panning, pinching and the drawer's
     * swipe all work, and a drag across it does nothing at all.
     */
    var armed = false;

    window.addEventListener("message", function (event) {
      var data = event.data;
      if (!data || data.t !== "pi-artifact-arm") return;
      armed = data.armed === true;
      image.classList.toggle("armed", armed);
      // The class goes on the document too: arming is about the whole page being selectable,
      // not about the picture element. See the stylesheet for why.
      document.documentElement.classList.toggle("armed", armed);
      document.body.classList.toggle("armed", armed);
      // Arming clears anything half-drawn: the state that allowed the box has changed,
      // and a box left on screen would look like a selection that no longer exists.
      if (!armed) clear();
      // Arming also gives up any gesture in progress: touch-action none is about to take
      // the touches, so a pinch under way would end mid-scale and leave the picture stuck
      // at a size nobody chose.
      pointers = {};
      pinch = null;
      pan = null;
      // Armed, a horizontal drag draws a rectangle: the drawer must not page underneath it.
      reportGesture();
    });

    // The whole document, not just the picture: once the button has been pressed the reader
    // is choosing an area of *the page*, and a drag that begins in the margin beside a
    // letterboxed picture obviously meant the picture. Listening on the image alone left a
    // drag that started anywhere else doing nothing at all — it could not draw a rectangle,
    // and (because the page is locked while armed) it could not page either.
    document.addEventListener("pointerdown", function (event) {
      if (!armed) return;
      // Primary button or a finger; a right-click is the browser's menu.
      if (typeof event.button === "number" && event.button !== 0) return;
      // One finger only: a second is a pinch, and touch-action: none on the picture
      // means the browser will not take it back.
      if (event.pointerType === "touch" && drag) return;
      event.preventDefault();
      // Capture on the *document*, now that a drag may start anywhere: capturing on the
      // image would only work for presses it received, and would also lose a drag that
      // wandered off the picture mid-stroke.
      try {
        document.documentElement.setPointerCapture(event.pointerId);
      } catch (e) {
        // Capture is an optimisation; the handlers below work without it.
      }
      // A new press replaces the old box: the previous selection is being superseded, and
      // leaving it on screen would show two rectangles while the second is dragged.
      if (marquee) clear();
      drag = { x: event.clientX, y: event.clientY };
      marquee = document.createElement("div");
      marquee.className = "marquee";
      marquee.style.left = drag.x + "px";
      marquee.style.top = drag.y + "px";
      marquee.style.width = "0px";
      marquee.style.height = "0px";
      document.body.appendChild(marquee);
    });

    document.addEventListener("pointermove", function (event) {
      if (!drag || !marquee) return;
      var left = Math.min(drag.x, event.clientX);
      var top = Math.min(drag.y, event.clientY);
      marquee.style.left = left + "px";
      marquee.style.top = top + "px";
      marquee.style.width = Math.abs(event.clientX - drag.x) + "px";
      marquee.style.height = Math.abs(event.clientY - drag.y) + "px";
    });

    /** The finger or the mouse came up: the rectangle is decided here, once. */
    function end(event) {
      if (!drag) return;
      // Nothing is sent while the box is being drawn: a message per pointermove would
      // have the drawer re-render a bar sixty times a second under the finger, and the
      // only rectangle that matters is the one the reader let go of.
      var region = regionOf(drag, { x: event.clientX, y: event.clientY });
      // A press that ended where it began is a tap: no region, and no message — the click
      // that follows offers the hint instead. The box goes.
      if (!region) {
        clear();
        return;
      }
      // A real selection keeps its box on the picture: the reader is about to write a comment
      // about that rectangle, and it is the only thing on screen that says which part of the
      // image they chose.
      clear(true);
      parent.postMessage(
        {
          t: "pi-artifact-region",
          file: document.body.getAttribute("data-file") || "",
          // The page this rectangle is on, read from *this* document's own URL. The
          // parent cannot work it out for itself: a page turn is a navigation inside
          // this frame, so the parent's copy of the frame's address is stale, and
          // cross-origin it cannot read the real one at all.
          page: (function () {
            var found = /[?&]page=(\d+)/.exec(location.search || "");
            var page = found ? Number(found[1]) : undefined;
            return page && page > 0 ? page : undefined;
          })(),
          region: region,
          // Where the comment box should be talked about: the reader let go here, and a
          // bar pinned to a fixed strip would be a separate place from the box they just
          // drew.
          at: { x: event.clientX, y: event.clientY },
          intent: "comment"
        },
        "*"
      );
    }

    document.addEventListener("pointerup", end);
    // A gesture the system claims (a scroll that turns into a back-swipe) ends here and
    // never at pointerup, so the box is taken down rather than left on the picture.
    document.addEventListener("pointercancel", clear);
  })();
