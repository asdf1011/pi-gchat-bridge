/* @@include:key-handler.js@@ */

(function () {
  var FRAME = { file: document.body.getAttribute("data-file") || "" };

  function lineElement(node) {
    var element = node && node.nodeType === 3 ? node.parentElement : node;
    return element && element.closest ? element.closest("[data-line]") : null;
  }

  function textSpan(lineElement) {
    return lineElement ? lineElement.querySelector(".tx") : null;
  }

  function codePointOffset(span, node, offset) {
    try {
      var range = document.createRange();
      range.setStart(span, 0);
      range.setEnd(node, offset);
      return Array.from(range.toString()).length;
    } catch (e) {
      return null;
    }
  }

  /** The selected text without the furniture: line numbers and comment markers are not the quote. */
  function quoteOf(range) {
    try {
      var fragment = range.cloneContents();
      var junk = fragment.querySelectorAll(".no, sup.cmark");
      for (var i = 0; i < junk.length; i += 1) {
        if (junk[i].parentNode) junk[i].parentNode.removeChild(junk[i]);
      }
      var text = fragment.textContent || "";
      if (text.trim()) return text.trim();
    } catch (e) {}
    // Nothing clonable: fall back to what the selection itself says.
    return String(window.getSelection()).trim();
  }

  /** The selection as a message, or null when there is nothing worth commenting on. */
  function describe() {
    var selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    var range = selection.getRangeAt(0);
    var startLine = lineElement(range.startContainer);
    var endLine = lineElement(range.endContainer);
    if (!startLine || !endLine) return null;
    var start = Number(startLine.getAttribute("data-line"));
    var end = Number(endLine.getAttribute("data-line"));
    if (!start || !end) return null;

    var startSpan = textSpan(startLine);
    var endSpan = textSpan(endLine);
    var message = {
      t: "pi-artifact-select",
      file: FRAME.file,
      line: start,
      endLine: end,
      // Not the selection's own string: a selection spanning lines also spans the gutter, so the
      // quote would read "first line, 3second line" — line numbers pasted into the comment.
      quote: quoteOf(range).slice(0, 400)
    };
    // Characters only within one line: a two-dimensional span has no format.
    if (start === end && startSpan && endSpan) {
      var from = codePointOffset(startSpan, range.startContainer, range.startOffset);
      var to = codePointOffset(endSpan, range.endContainer, range.endOffset);
      if (from !== null && to !== null && to > from) {
        message.charStart = from + 1;
        message.charEnd = to;
      }
    }
    return { range: range, message: message };
  }

  // --- The comment affordance -------------------------------------------------
  //
  // Selecting text no longer opens the composer. People select text to read it, and a box appearing
  // over the page is a distraction; so a small button appears beside the selection and *that* is what
  // opens the comment box. The click carries the intent, which is what lets the pane focus the field:
  // the reader said they wanted to write something, rather than being interrupted mid-read.
  var affordance = null;

  function hideAffordance() {
    if (!affordance) return;
    if (affordance.parentNode) affordance.parentNode.removeChild(affordance);
    affordance = null;
  }

  /**
   * A coarse pointer means a finger, and a finger means the platform's own menu.
   *
   * Deliberately the pointer media feature rather than a width: a small laptop window
   * is not a
   * phone, and a tablet with a keyboard is one device with two answers. What matters
   * is whether the selection came with tear-drop handles and a system toolbar, and
   * that follows the input device.
   */
  function isTouch() {
    try {
      return window.matchMedia("(pointer: coarse)").matches;
    } catch (e) {
      return false;
    }
  }

  function showAffordance(range, message) {
    hideAffordance();
    // On a touch device the page draws nothing. Selecting text raises the system menu
    // (Copy / Select all / Share) directly above the selection and two drag handles at
    // its bottom corners; a button of ours sits on top of one or the other, and there is
    // no web API to add ourselves to the system menu instead. So the *parent* shows the
    // action, in a bar above the composer, where none of that reaches.
    if (isTouch()) {
      message.intent = "comment";
      parent.postMessage({ t: "pi-artifact-select-touch", message: message }, "*");
      return;
    }
    var rect;
    try {
      rect = range.getBoundingClientRect();
    } catch (e) {
      rect = null;
    }
    // Below the selection, not above it. Above is where a desktop browser puts its own
    // selection toolbar, so a button there is covered by it or collides with it.
    //
    // A zero rect is what a headless DOM reports; pinning the button top-left there is
    // better than throwing, because the tests drive exactly this path.
    var GAP = 30;   // clears the selection's own handles on touch
    var BUTTON_H = 34;
    var selectionTop = (rect && rect.top) || 8;
    var selectionBottom = rect && rect.bottom ? rect.bottom : selectionTop;
    // Below the selection when it fits, above only when it does not: near the bottom of
    // the viewport there is no room underneath, and above is then the lesser evil.
    var below = selectionBottom + GAP;
    var top = below + BUTTON_H <= (window.innerHeight || 600)
      ? below
      : Math.max(4, selectionTop - BUTTON_H);
    var left = Math.max(4, Math.min((window.innerWidth || 800) - 44, ((rect && rect.right) || 8) + 6));
    var button = document.createElement("button");
    button.type = "button";
    button.className = "cm-add";
    button.title = "Comment on this";
    button.setAttribute("aria-label", "Comment on the selected text");
    button.textContent = "Comment";
    button.style.position = "fixed";
    button.style.top = top + "px";
    button.style.left = left + "px";
    button.style.zIndex = "2147483647";
    // Without this the press itself collapses the selection, and the click would report nothing.
    button.addEventListener("mousedown", function (event) { event.preventDefault(); });
    button.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      hideAffordance();
      message.intent = "comment";
      parent.postMessage(message, "*");
    });
    document.body.appendChild(button);
    affordance = button;
  }

  var timer = null;
  document.addEventListener("selectionchange", function () {
    if (timer) clearTimeout(timer);
    // A little settled time: selectionchange fires per character while a selection is being
    // dragged, and only the settled result is worth a button.
    timer = setTimeout(function () {
      var built = describe();
      if (!built) {
        hideAffordance();
        // No touch message here: the clear message below already tells the page the
        // selection is gone, on every device, and the page treats it as the one place
        // that forgets a selection. A second "nothing selected" would be a second thing
        // to keep in step.
        // A selection that went away is the reader dismissing the composer, so say so: the parent
        // closes the bar, unless something has been typed into it.
        parent.postMessage({ t: "pi-artifact-clear", file: FRAME.file }, "*");
        return;
      }
      showAffordance(built.range, built.message);
    }, 220);
  });
  document.addEventListener("scroll", hideAffordance, true);
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") hideAffordance();
  });
  // The key that does what the affordance does. Both scripts install the same handler;
  // the collaborators are what differ (this one reports line numbers, the rendered one
  // reports text and an occurrence).
  document.addEventListener(
    "keydown",
    commentKeyHandler({
      isTouch: isTouch,
      ready: function () { return !!affordance; },
      hide: hideAffordance,
      describe: describe,
      post: function (message) { parent.postMessage(message, "*"); }
    })
  );

  document.addEventListener("click", function (event) {
    var target = event.target;
    var marker = target && target.closest ? target.closest("[data-comment-id]") : null;
    if (!marker) return;
    parent.postMessage(
      { t: "pi-artifact-open", id: marker.getAttribute("data-comment-id") },
      "*"
    );
  });

  // Tell the parent the document is ready for highlights it wants to change.
  // Tell the parent the document is ready for highlights it wants to change.
  /* @@include:swipe.js@@ */

  parent.postMessage({ t: "pi-artifact-ready", file: FRAME.file }, "*");
})();
