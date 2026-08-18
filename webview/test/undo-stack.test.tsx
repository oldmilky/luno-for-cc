import { describe, it, expect } from "vitest";
import { UndoStack } from "../src/design/primitives/undo-stack";

// The composer keeps its own history because the browser's cannot be relied on
// here — in a VS Code webview Ctrl+Z is a workbench keybinding and never
// reaches the editor as the undo it would have performed. Reported from the
// panel: typing a message, pasting a link, then Ctrl+Z removed the *message*
// and left the link.
//
// DOM but no React, so it runs in the jsdom project without mounting an editor.

function editor(html = ""): HTMLElement {
  const el = document.createElement("div");
  el.contentEditable = "true";
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

describe("UndoStack", () => {
  it("steps back to the state before the edit", () => {
    const el = editor("hello");
    const stack = new UndoStack();

    stack.record(el, 1000);
    el.innerHTML = "hello world";

    expect(stack.undo(el)).toBe(true);
    expect(el.innerHTML).toBe("hello");
  });

  it("puts back what undo took", () => {
    const el = editor("hello");
    const stack = new UndoStack();
    stack.record(el, 1000);
    el.innerHTML = "hello world";
    stack.undo(el);

    expect(stack.redo(el)).toBe(true);
    expect(el.innerHTML).toBe("hello world");
  });

  it("undoes the paste and keeps the typing — the reported case", () => {
    // Two edits far enough apart to be two steps: the words, then the link.
    const el = editor("");
    const stack = new UndoStack();

    stack.record(el, 1000);
    el.innerHTML = "выфвыфвыф ";
    stack.record(el, 5000);
    el.innerHTML = "выфвыфвыф https://example.com";

    stack.undo(el);

    expect(el.innerHTML).toBe("выфвыфвыф ");
  });

  it("holds a burst of typing together as one step", () => {
    // Otherwise every keystroke costs a Ctrl+Z, which is nobody's idea of undo.
    const el = editor("");
    const stack = new UndoStack();

    stack.record(el, 1000);
    el.innerHTML = "a";
    stack.record(el, 1100);
    el.innerHTML = "ab";
    stack.record(el, 1200);
    el.innerHTML = "abc";

    stack.undo(el);

    expect(el.innerHTML).toBe("");
  });

  it("separates edits either side of a pause", () => {
    const el = editor("");
    const stack = new UndoStack();
    stack.record(el, 1000);
    el.innerHTML = "first";
    stack.record(el, 9000);
    el.innerHTML = "first second";

    stack.undo(el);
    expect(el.innerHTML).toBe("first");
    stack.undo(el);
    expect(el.innerHTML).toBe("");
  });

  it("does not record a state that has not changed", () => {
    // Moving the caret is not an edit, and a step that changes nothing reads
    // as a Ctrl+Z that did nothing.
    const el = editor("same");
    const stack = new UndoStack();
    stack.record(el, 1000);
    stack.record(el, 9000);
    el.innerHTML = "same but longer";

    stack.undo(el);
    expect(el.innerHTML).toBe("same");
    expect(stack.undo(el)).toBe(false);
  });

  it("says so when there is nothing to step to", () => {
    // The caller needs the answer: a key it did not use is a key it should not
    // have claimed.
    const el = editor("only");
    const stack = new UndoStack();

    expect(stack.undo(el)).toBe(false);
    expect(stack.redo(el)).toBe(false);
  });

  it("drops the redo branch once a new edit lands on top", () => {
    const el = editor("");
    const stack = new UndoStack();
    stack.record(el, 1000);
    el.innerHTML = "one";
    stack.undo(el);

    stack.record(el, 9000);
    el.innerHTML = "different";

    expect(stack.redo(el)).toBe(false);
    expect(el.innerHTML).toBe("different");
  });

  it("forgets everything on reset", () => {
    // What `clear()` does when a message is sent: undoing back into a sent
    // message would put it back in the box.
    const el = editor("");
    const stack = new UndoStack();
    stack.record(el, 1000);
    el.innerHTML = "sent";

    stack.reset();

    expect(stack.undo(el)).toBe(false);
  });

  it("keeps the caret where the text it was in still exists", () => {
    const el = editor("hello");
    const range = document.createRange();
    range.setStart(el.firstChild as Text, 3);
    range.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    const stack = new UndoStack();
    stack.record(el, 1000);
    el.innerHTML = "hello world";
    stack.undo(el);

    const after = window.getSelection()?.getRangeAt(0);
    expect(after?.startOffset).toBe(3);
  });
});
