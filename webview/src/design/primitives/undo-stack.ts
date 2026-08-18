// ── Undo ─────────────────────────────────────────────────────

/** One recorded state: the editor's markup and where the caret was in it. */
interface UndoState {
  html: string;
  caret: number;
}

/** How long two edits have to be apart to become separate undo steps. Typing a
 *  word should not cost a keypress of undo, and 400 ms is long enough to hold a
 *  burst of keystrokes together and short enough that a pause reads as one. */
const COALESCE_MS = 400;

/** Deep enough to cover a composed message, bounded so a long session cannot
 *  grow it without limit. */
const MAX_DEPTH = 120;

/**
 * The composer's own undo history.
 *
 * The browser keeps one of these already, and this exists because that one
 * cannot be relied on here. Two reasons, and the second is the decisive one:
 *
 * 1. The editor inserts nodes — mention pills, code badges, a parsed paste —
 *    and only `execCommand` reaches the native stack. That was made to work,
 *    and it does work in a browser.
 * 2. **In a VS Code webview the key never arrives.** Ctrl+Z is a workbench
 *    keybinding; the host acts on it and what reaches the editor is not the
 *    undo it would have performed. Reported from the panel: typing a message,
 *    pasting a link, then Ctrl+Z removed the message and left the link — a
 *    state the native stack would never produce, and one this file could not
 *    reproduce in a browser however hard it tried.
 *
 * So the editor keeps its own history and swallows the chord. Deterministic,
 * identical in the panel and the harness, and testable in both.
 *
 * Snapshots of `innerHTML` rather than a diff: the content is a few kilobytes
 * of a message, the depth is bounded, and a diff of a DOM with atomic pills in
 * it is a great deal of machinery for no gain anyone can measure.
 */
export class UndoStack {
  private past: UndoState[] = [];
  private future: UndoState[] = [];
  private lastAt = 0;

  /** Discard everything — a new conversation, or content pushed in from
   *  outside. What came before belongs to a message that is already gone. */
  reset(): void {
    this.past = [];
    this.future = [];
    this.lastAt = 0;
  }

  /**
   * Record the state the editor is in *before* the edit about to happen.
   *
   * @param now injected so a test can drive the clock rather than sleep
   *   through the coalescing window.
   */
  record(el: HTMLElement, now = Date.now()): void {
    const html = el.innerHTML;
    const top = this.past[this.past.length - 1];
    // Nothing moved: the caret alone is not an edit.
    if (top && top.html === html) return;
    // Inside the window, the burst is one step — but the *first* state of the
    // burst is the one worth keeping, so the newest is replaced rather than
    // appended to.
    if (top && now - this.lastAt < COALESCE_MS) {
      this.lastAt = now;
      return;
    }
    this.past.push({ html, caret: caretOffset(el) });
    if (this.past.length > MAX_DEPTH) this.past.shift();
    this.future = [];
    this.lastAt = now;
  }

  /** Step back. Returns false when there is nothing to step back to, so the
   *  caller can leave the key to whatever else wants it. */
  undo(el: HTMLElement): boolean {
    const previous = this.past.pop();
    if (!previous) return false;
    this.future.push({ html: el.innerHTML, caret: caretOffset(el) });
    apply(el, previous);
    this.lastAt = 0;
    return true;
  }

  redo(el: HTMLElement): boolean {
    const next = this.future.pop();
    if (!next) return false;
    this.past.push({ html: el.innerHTML, caret: caretOffset(el) });
    apply(el, next);
    this.lastAt = 0;
    return true;
  }
}

function apply(el: HTMLElement, state: UndoState): void {
  el.innerHTML = state.html;
  placeCaretAtOffset(el, state.caret);
}

/** How many characters of text sit before the caret. A position that survives
 *  the markup being replaced wholesale, which a `Range` into the old nodes
 *  would not. */
export function caretOffset(el: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return textLength(el);
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer)) return textLength(el);
  const before = range.cloneRange();
  before.selectNodeContents(el);
  before.setEnd(range.startContainer, range.startOffset);
  return before.toString().length;
}

function textLength(el: HTMLElement): number {
  return el.textContent?.length ?? 0;
}

/** Put the caret that many characters in, walking text nodes. Lands at the end
 *  when the offset is past what the restored content holds — which happens
 *  whenever undo shortens the message. */
export function placeCaretAtOffset(el: HTMLElement, offset: number): void {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let node: Node | null = walker.nextNode();
  let last: Text | null = null;
  while (node) {
    const text = node as Text;
    const len = text.data.length;
    if (remaining <= len) {
      const range = document.createRange();
      range.setStart(text, remaining);
      range.collapse(true);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      return;
    }
    remaining -= len;
    last = text;
    node = walker.nextNode();
  }
  const range = document.createRange();
  if (last) {
    range.setStart(last, last.data.length);
  } else {
    range.selectNodeContents(el);
  }
  range.collapse(false);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

