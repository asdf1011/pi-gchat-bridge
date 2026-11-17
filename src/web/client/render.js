/* @@include:key-handler.js@@ */

(function () {
  var FRAME = { file: document.body.getAttribute("data-file") || "" };

  function textNodes() {
    var nodes = [];
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        var parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        // Inline code is allowed: a code span is prose-sized text, and a highlight inside it
        // neither breaks copying nor rendering. It used to be excluded, which made every comment
        // on a code span invisible in the rendered view — including a comment on an API heading,
        // where this document keeps its subject matter. Fenced blocks stay excluded: they are
        // line-anchored, and wrapping text across one breaks whitespace and selection, so comments
        // there belong to the source view.
        if (parent.closest("pre, mark, script, sup.cmark")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  }

  /** Which occurrence of `needle` in the document a selection starts at. */
  function occurrenceOf(needle, container, offset) {
    if (!needle) return 0;
    var seen = 0;
    var nodes = textNodes();
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      var text = node.nodeValue || "";
      var from = text.indexOf(needle);
      while (from !== -1) {
        // Before the selection? Then it is an earlier instance.
        var range = document.createRange();
        range.setStart(node, from);
        range.setEnd(node, from + needle.length);
        var before = range.compareBoundaryPoints(Range.START_TO_START, (function () {
          var sel = window.getSelection();
          if (!sel || sel.rangeCount === 0) return range;
          return sel.getRangeAt(0);
        })()) < 0;
        var isTheSelection = node === container || (container.compareDocumentPosition && false);
        if (before) { seen += 1; }
        else { return seen; }
        from = text.indexOf(needle, from + 1);
      }
    }
    return seen;
  }

  /** The selection as a message, or null when there is nothing worth commenting on. */
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

  function describe() {
    var selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    var range = selection.getRangeAt(0);
    var quote = quoteOf(range);
    if (!quote) return null;
    var firstLine = quote.split("\\n")[0].trim();
    return {
      range: range,
      message: {
        t: "pi-artifact-select",
        file: FRAME.file,
        quote: quote.slice(0, 400),
        occurrence: occurrenceOf(firstLine, range.startContainer, range.startOffset)
      }
    };
  }

  // The comment affordance: see the source view's copy for why selecting text no longer opens the
  // composer. Two documents, one behaviour — kept literally identical so they cannot drift.
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
   * is not a phone, and a tablet with a keyboard is one device with two answers. What
   * matters
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

  function mark(comment) {
    // A selection can span several source lines (a paragraph), and the rendered
    // document joins them into one run of text — so the search needle is the
    // first line of the quote. The occurrence count is taken the same way.
    var needle = ((comment.quote || "").split("\\n")[0] || "").trim();
    if (!needle) return;
    var wanted = comment.occurrence || 0;
    var seen = 0;
    var nodes = textNodes();
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      var text = node.nodeValue || "";
      var at = text.indexOf(needle);
      while (at !== -1) {
        if (seen === wanted) {
          var range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + needle.length);
          var wrap = document.createElement("mark");
          wrap.className = "cm " + (comment.state || "visible");
          wrap.setAttribute("data-comment-id", comment.id);
          try {
            range.surroundContents(wrap);
            var sup = document.createElement("sup");
            sup.className = "cmark";
            sup.setAttribute("data-comment-id", comment.id);
            sup.textContent = comment.label || "*";
            wrap.parentNode.insertBefore(sup, wrap.nextSibling);
          } catch (e) {
            // A range spanning several elements cannot be wrapped; leave it.
          }
          return;
        }
        seen += 1;
        at = text.indexOf(needle, at + 1);
      }
    }
  }

  var timer = null;
  document.addEventListener("selectionchange", function () {
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () {
      var built = describe();
      if (!built) {
        hideAffordance();
        // No touch message here: the clear message below already tells the page the
        // selection is gone, on every device, and the page treats it as the one place
        // that forgets a selection. A second "nothing selected" would be a second thing
        // to keep in step.
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
    parent.postMessage({ t: "pi-artifact-open", id: marker.getAttribute("data-comment-id") }, "*");
  });

  try {
    var data = JSON.parse(document.getElementById("comment-data").textContent || "[]");
    for (var i = 0; i < data.length; i += 1) mark(data[i]);
  } catch (e) {}

  /* @@include:swipe.js@@ */

  parent.postMessage({ t: "pi-artifact-ready", file: FRAME.file }, "*");
})();
