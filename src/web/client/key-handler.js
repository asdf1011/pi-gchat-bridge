// The `c` key, as a client-side function.
//
// One copy, spliced into both comment scripts: a source view and a rendered document offer
// the same key, and what differs is only where a selection comes from — so the handler is
// parameterised by collaborators rather than duplicated.
//
// This was TypeScript that got stringified with `commentKeyHandler.toString()`. That worked,
// but only because the compiled output happened to be valid JavaScript: it depended on `tsc`
// emitting nothing clever (no enums, no helpers, no type stripping beyond annotations), and a
// change to either the function or the compiler settings could have produced a script that
// failed in the browser and nowhere else. It is plain JavaScript here, like the scripts it is
// spliced into.

/**
 * Returns a keydown listener that asks for a comment on the settled selection.
 *
 * `deps` are the two scripts' own: `isTouch` because a phone's keyboard is not on screen,
 * `ready` because the affordance existing is what says a selection has settled and is
 * complete, and `describe`/`hide`/`post` so the handler does not need to know which kind of
 * document it is in.
 */
function commentKeyHandler(deps) {
  return function (event) {
    if (event.key !== "c" && event.key !== "C") return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.defaultPrevented) return;
    if (deps.isTouch()) return;
    if (!deps.ready()) return;
    var node = event.target;
    var name = node && node.nodeName ? String(node.nodeName).toLowerCase() : "";
    // Typing into a field: `c` belongs to the text, not to the document.
    if (name === "input" || name === "textarea" || name === "select") return;
    if (node && (node.isContentEditable || (node.closest && node.closest("[contenteditable]")))) return;
    // Re-read under the key rather than reusing what the affordance was drawn from: a
    // selection that moved since would otherwise comment on the wrong lines.
    var built = deps.describe();
    if (!built) return;
    event.preventDefault();
    deps.hide();
    var message = built.message;
    message.intent = "comment";
    deps.post(message);
  };
}
