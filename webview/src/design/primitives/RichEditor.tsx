// ─────────────────────────────────────────────────────────────
// RichEditor — contenteditable composer with rich code blocks.
//
// The editor's DOM is the source of truth after mount. Plain text
// flows naturally; Cmd+U (and any caller using `pendingInsert`)
// inserts a styled, atomic code block at the current cursor with
// an editable code body. Markdown syntax markers (** ` ```) never
// appear to the user — code blocks are real DOM elements.
//
// On submit (or via the `serialize()` imperative API), the DOM is
// flattened back to a markdown string so the rest of the app can
// continue treating prompts as text. Code badges flatten to a compact
// `@file:start-end` reference (the agent reads the source itself) rather
// than pasting the whole captured snippet into the prompt.
// ─────────────────────────────────────────────────────────────

import {
  ClipboardEvent,
  KeyboardEvent,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState
} from "react";
import s from "./RichEditor.module.scss";

export interface CodeInsert {
  file: string;
  language: string;
  startLine: number;
  endLine: number;
  text: string;
}

export interface RichEditorHandle {
  focus(): void;
  clear(): void;
  serialize(): string;
}

export interface RichEditorProps {
  /** Initial value (markdown). Read once on mount. */
  initialText?: string;
  /** One-shot insert payload. Cleared via `onInserted` after splicing. */
  pendingInsert: CodeInsert | null;
  onInserted: () => void;
  /** Fires on every input change with the current serialized markdown. */
  onChange: (text: string) => void;
  /** Fires on Enter (without Shift) outside a code body. */
  onSubmit: () => void;
  /** Click on a code-badge pill — open the source range in the editor. */
  onOpenBadge?: (file: string, startLine: number, endLine: number) => void;
  /** Click on a @file mention pill — open the file in the editor. */
  onOpenMention?: (path: string) => void;
  /**
   * Image files pasted from the clipboard. When provided, the editor catches
   * the paste, prevents the default `<img>`-into-contenteditable behavior,
   * and hands the files to the parent (which typically renders them as
   * attachment chips above the composer).
   */
  onImagePaste?: (files: File[]) => void;
  busy: boolean;
  placeholder?: string;
}

const BADGE_CLASS = s.badge;
const MENTION_CLASS = s.mention;

export const RichEditor = forwardRef<RichEditorHandle, RichEditorProps>(
  function RichEditor(
    {
      initialText = "",
      pendingInsert,
      onInserted,
      onChange,
      onSubmit,
      onOpenBadge,
      onOpenMention,
      onImagePaste,
      busy,
      placeholder = "Ask, edit, or plan anything. Type @ to mention a file. ⌘U to insert selection."
    },
    forwardedRef
  ) {
    const ref = useRef<HTMLDivElement>(null);
    const [isEmpty, setIsEmpty] = useState(initialText.trim().length === 0);

    // Mount: render the initial markdown (parsing fenced blocks back into rich
    // code blocks so a reload preserves what the user already had).
    useLayoutEffect(() => {
      const el = ref.current;
      if (!el) return;
      el.innerHTML = "";
      if (initialText) {
        renderInitial(el, initialText);
        setIsEmpty(serialize(el).trim().length === 0);
      }
      // intentionally only on mount
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Native capture-phase guards so the browser never gets to insert a
    // dragged or pasted image as an inline <img> inside the contenteditable.
    // React's synthetic events delegate at the root and run in the bubble
    // phase — for `drop` and `paste` on a contenteditable that's sometimes
    // too late: the browser has already committed the default action. We
    // attach native listeners directly with capture=true so preventDefault
    // is registered before the browser's default fires.
    useEffect(() => {
      const el = ref.current;
      if (!el) return;
      const block = (e: Event) => e.preventDefault();
      const onPaste = (ev: Event) => {
        const e = ev as globalThis.ClipboardEvent;
        if (!onImagePaste || !e.clipboardData) return;
        const files: File[] = [];
        for (const item of Array.from(e.clipboardData.items)) {
          if (item.kind === "file" && item.type.startsWith("image/")) {
            const f = item.getAsFile();
            if (f) files.push(f);
          }
        }
        if (files.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        onImagePaste(files);
      };
      el.addEventListener("dragover", block, true);
      el.addEventListener("drop", block, true);
      el.addEventListener("paste", onPaste, true);
      return () => {
        el.removeEventListener("dragover", block, true);
        el.removeEventListener("drop", block, true);
        el.removeEventListener("paste", onPaste, true);
      };
    }, [onImagePaste]);

    // Cmd+U → splice a code block at the caret.
    useEffect(() => {
      if (!pendingInsert || !ref.current) return;
      ref.current.focus();
      insertCodeBlockAtSelection(ref.current, pendingInsert);
      const text = serialize(ref.current);
      setIsEmpty(text.trim().length === 0);
      onChange(text);
      onInserted();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pendingInsert]);

    useImperativeHandle(forwardedRef, () => ({
      focus: () => {
        if (ref.current) placeCaretAtEnd(ref.current);
      },
      clear: () => {
        if (!ref.current) return;
        ref.current.innerHTML = "";
        setIsEmpty(true);
        onChange("");
      },
      serialize: () => (ref.current ? serialize(ref.current) : "")
    }));

    const handleInput = () => {
      if (!ref.current) return;
      const text = serialize(ref.current);
      setIsEmpty(text.trim().length === 0);
      onChange(text);
    };

    /**
     * Copy/cut from the contenteditable. We only intercept when the selection
     * contains a badge or mention pill — otherwise we let the browser's
     * native copy/cut run untouched, preserving all the usual hotkey
     * behavior. For a pure text selection there's nothing special to
     * serialize: native copy already gives the right characters.
     *
     * When a badge IS in the selection, native copy would only grab the
     * visible label (filename + glyph) and drop the underlying source
     * code / file path. We clone the range, run it through the same
     * `serialize()` walker the editor uses on submit, and stash that
     * markdown on the clipboard instead.
     */
    const serializeSelectionIfRich = (): string | null => {
      const editor = ref.current;
      if (!editor) return null;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
      const range = sel.getRangeAt(0);
      if (!editor.contains(range.commonAncestorContainer)) return null;
      const wrapper = document.createElement("div");
      wrapper.appendChild(range.cloneContents());
      const hasRich =
        wrapper.querySelector(`.${BADGE_CLASS}, .${MENTION_CLASS}`) !== null;
      if (!hasRich) return null;
      return serialize(wrapper);
    };

    const handleCopy = (e: ClipboardEvent<HTMLDivElement>) => {
      const text = serializeSelectionIfRich();
      if (text === null || !text) return; // plain text → native copy runs
      e.preventDefault();
      e.clipboardData.setData("text/plain", text);
    };

    const handleCut = (e: ClipboardEvent<HTMLDivElement>) => {
      const text = serializeSelectionIfRich();
      if (text === null || !text) return; // plain text → native cut runs
      e.preventDefault();
      e.clipboardData.setData("text/plain", text);
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) {
        sel.getRangeAt(0).deleteContents();
        if (ref.current) {
          const out = serialize(ref.current);
          setIsEmpty(out.trim().length === 0);
          onChange(out);
        }
      }
    };

    /**
     * Paste handler — rehydrate badge-markdown patterns into real badge
     * spans so pasting a previously-copied prompt back into the composer
     * shows the same pills it originally had. Plain text without badge
     * markers falls back to a regular text insert (preserving newlines).
     */
    const handlePaste = (e: ClipboardEvent<HTMLDivElement>) => {
      const editor = ref.current;
      if (!editor) return;

      // Clipboard images (Cmd+V of a screenshot, image copied from a browser,
      // etc.) — pull them out before the browser embeds them inline. We walk
      // `items` because `files` is sometimes empty for clipboard images even
      // when an image is clearly present.
      if (onImagePaste) {
        const imageFiles: File[] = [];
        for (const item of Array.from(e.clipboardData.items)) {
          if (item.kind === "file" && item.type.startsWith("image/")) {
            const f = item.getAsFile();
            if (f) imageFiles.push(f);
          }
        }
        if (imageFiles.length > 0) {
          e.preventDefault();
          onImagePaste(imageFiles);
          return;
        }
      }

      const text = e.clipboardData.getData("text/plain");
      if (!text) return;
      // Always insert the plain-text payload ourselves rather than letting the
      // browser paste the clipboard's rich HTML — native paste into a
      // contenteditable carries over the source's color, font, and size,
      // which clashes with the composer. Routing through the markdown parser
      // strips all foreign styling (it only ever emits plain text nodes and
      // <br>) while still rehydrating any badge patterns the text contains.
      e.preventDefault();
      insertParsedAtSelection(editor, text);
      const out = serialize(editor);
      setIsEmpty(out.trim().length === 0);
      onChange(out);
    };

    // Click on a pill → open the underlying file in the editor. The pill is
    // contenteditable=false so clicks fire normally; we still preventDefault
    // so the caret doesn't jump to the badge's inner text node.
    const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as Element | null;
      if (!target) return;
      const badge = target.closest("." + BADGE_CLASS);
      if (badge instanceof HTMLElement) {
        const file = badge.dataset.file;
        if (!file) return;
        e.preventDefault();
        const start = Number(badge.dataset.startLine ?? 0);
        const end = Number(badge.dataset.endLine ?? start);
        onOpenBadge?.(file, start, end);
        return;
      }
      const mention = target.closest("." + MENTION_CLASS);
      if (mention instanceof HTMLElement) {
        const path = mention.dataset.path;
        if (!path) return;
        e.preventDefault();
        onOpenMention?.(path);
      }
    };

    const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.nativeEvent.isComposing) return;

      if (e.key === "Enter" && !e.shiftKey) {
        // Newline inside a code body; submit otherwise.
        if (cursorInsideCodeBody()) return;
        e.preventDefault();
        onSubmit();
        return;
      }

      if (e.key === "Backspace") {
        const handled = handleBackspaceAtBoundary(ref.current);
        if (handled) {
          e.preventDefault();
          // Manually trigger change since we mutated DOM outside React.
          if (ref.current) {
            const text = serialize(ref.current);
            setIsEmpty(text.trim().length === 0);
            onChange(text);
          }
        }
      }
    };

    return (
      <div className={s.wrap}>
        {isEmpty && <div className={s.placeholder}>{placeholder}</div>}
        <div
          ref={ref}
          className={s.editor}
          contentEditable={!busy}
          suppressContentEditableWarning
          spellCheck={false}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onClick={handleClick}
          onCopy={handleCopy}
          onCut={handleCut}
          onPaste={handlePaste}
          // Block native browser drop into the contenteditable — otherwise
          // dragging an image from Finder embeds it as a giant <img> inside
          // the editor. The Composer's wrapper handles attachments above.
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => e.preventDefault()}
          role="textbox"
          aria-multiline="true"
          aria-label="Message Luno"
        />
      </div>
    );
  }
);

// ── DOM construction ────────────────────────────────────────

/**
 * Build a compact, atomic inline badge that represents a captured code
 * selection. The full code text and language ride along on data attributes
 * so they survive copy/paste within the editor and are available at
 * serialize time. The badge itself is contenteditable=false so backspace
 * removes it as a single unit.
 */
function makeCodeBadge(
  file: string,
  startLine: number,
  endLine: number,
  language: string,
  text: string
): HTMLSpanElement {
  // Full label (`path/to/file.ts:10–20`) rides along for the tooltip and is
  // what serialize() reconstructs from the data attributes — the agent still
  // receives the full path. The visible pill only shows the basename so the
  // composer stays compact.
  const fileLabel = formatBadgeLabel(file, startLine, endLine);
  const displayLabel = formatBadgeLabel(basename(file), startLine, endLine);
  const badge = document.createElement("span");
  badge.className = BADGE_CLASS;
  badge.setAttribute("contenteditable", "false");
  badge.dataset.lang = language || "text";
  badge.dataset.code = text;
  // File + line range survive copy/paste through these data attributes, which
  // also give the click-to-open handler a structured payload without
  // re-parsing the rendered text on every click.
  if (file) badge.dataset.file = file;
  if (startLine > 0) badge.dataset.startLine = String(startLine);
  if (endLine > 0) badge.dataset.endLine = String(endLine);
  badge.title = `${fileLabel}\n\n${truncate(text, 400)}`;

  const icon = document.createElement("span");
  icon.className = s.badgeIcon;
  icon.textContent = "</>";
  badge.appendChild(icon);

  const label = document.createElement("span");
  label.className = s.badgeLabel;
  label.textContent = displayLabel || "code";
  badge.appendChild(label);

  return badge;
}

/**
 * Render the human-readable badge label from structured fields. Used both
 * when building a fresh badge and when re-parsing one from pasted markdown.
 * Single-line selections drop the range suffix; ranged ones use an en-dash.
 */
function formatBadgeLabel(file: string, start: number, end: number): string {
  if (!file) return "code";
  if (!start) return file;
  if (!end || start === end) return `${file}:${start}`;
  return `${file}:${start}–${end}`;
}

/**
 * Compact `@file:start-end` reference emitted for a code badge at serialize
 * time (Cursor-style). Single-line selections drop the range suffix; a
 * rangeless badge degrades to a bare `@file`. Uses a plain hyphen (not the
 * en-dash the visible label uses) so the agent parses the range cleanly.
 */
function formatCodeRef(file: string, start: number, end: number): string {
  if (!start) return `@${file}`;
  if (!end || start === end) return `@${file}:${start}`;
  return `@${file}:${start}-${end}`;
}

/**
 * Inverse of `formatBadgeLabel`. Accepts both `–` (en-dash, what we emit)
 * and `-` (plain hyphen, what users might hand-type). Falls back to the
 * whole string as the file name when no `:line` suffix is present.
 */
function parseBadgeLabel(label: string): {
  file: string;
  startLine: number;
  endLine: number;
} {
  const m = label.match(/^(.+):(\d+)(?:[–-](\d+))?$/);
  if (!m) return { file: label, startLine: 0, endLine: 0 };
  const start = Number(m[2]);
  const end = m[3] ? Number(m[3]) : start;
  return { file: m[1], startLine: start, endLine: end };
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** Last path segment — `src/providers/claude-cli.ts` → `claude-cli.ts`. */
function basename(file: string): string {
  if (!file) return file;
  const cleaned = file.replace(/[\\/]+$/, "");
  const seg = cleaned.split(/[\\/]/).pop();
  return seg || cleaned;
}

/**
 * Atomic file-mention pill used when the user picks from the @-menu or
 * drops a file onto the composer. Like the code badge it's
 * `contenteditable=false` so backspace removes it as a unit, but it's
 * narrower (no expand) and serializes as `@<basename>` rather than a
 * fenced code block — the agent already understands that token.
 *
 * `data-path` carries the workspace-relative path for paste/copy
 * round-trips and for any future "click to open" affordance.
 */
export function makeMentionBadge(
  fullPath: string,
  basename?: string
): HTMLSpanElement {
  const name = basename || fullPath.split("/").pop() || fullPath;
  const el = document.createElement("span");
  el.className = MENTION_CLASS;
  el.setAttribute("contenteditable", "false");
  el.dataset.path = fullPath;
  el.dataset.name = name;
  el.title = fullPath;

  const at = document.createElement("span");
  at.className = s.mentionAt;
  at.textContent = "@";
  el.appendChild(at);

  const label = document.createElement("span");
  label.className = s.mentionLabel;
  label.textContent = name;
  el.appendChild(label);

  return el;
}

function insertCodeBlockAtSelection(container: HTMLElement, ins: CodeInsert) {
  const badge = makeCodeBadge(
    ins.file,
    ins.startLine,
    ins.endLine,
    ins.language,
    ins.text
  );

  const sel = window.getSelection();
  let r: Range;
  if (
    sel &&
    sel.rangeCount > 0 &&
    container.contains(sel.anchorNode as Node | null)
  ) {
    r = sel.getRangeAt(0);
    r.deleteContents();
  } else {
    r = document.createRange();
    r.selectNodeContents(container);
    r.collapse(false);
  }

  // Pad with a single space on either side so the caret can land outside
  // the badge naturally — otherwise some browsers trap the caret against
  // the atomic element.
  const trailingSpace = document.createTextNode(" ");
  r.insertNode(trailingSpace);
  r.setStartBefore(trailingSpace);
  r.insertNode(badge);
  r.setStartAfter(trailingSpace);
  r.collapse(true);

  sel?.removeAllRanges();
  sel?.addRange(r);
}

// ── Serialization ───────────────────────────────────────────

/**
 * Walk the editor DOM and produce a markdown string. Code badges serialize
 * to a lightweight `@file:start-end` reference (Cursor-style) so the prompt
 * stays small and the agent reads the source itself — only a pathless badge
 * (code with no backing file) falls back to a fenced block. Visible plain
 * text passes through as-is.
 */
function serialize(container: HTMLElement): string {
  const out: string[] = [];

  function emitNewlineIfNeeded() {
    const last = out.length > 0 ? out[out.length - 1] : "";
    if (last && !last.endsWith("\n")) out.push("\n");
  }

  // Ensure a `@file:…` reference starts on a word boundary — gluing it to
  // preceding text (`see@file`) would stop the agent recognizing the mention.
  function emitSpaceIfNeeded() {
    const last = out.length > 0 ? out[out.length - 1] : "";
    if (last && !/\s$/.test(last)) out.push(" ");
  }

  function walk(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = (node.textContent ?? "").replace(/​/g, "");
      if (t) out.push(t);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;

    if (el.classList.contains(BADGE_CLASS)) {
      const file = el.dataset.file ?? "";
      const start = Number(el.dataset.startLine ?? 0);
      const end = Number(el.dataset.endLine ?? start);
      // When the badge is backed by a real file, emit a compact
      // `@file:start-end` reference instead of pasting the captured snippet.
      // The agent resolves the path itself, so the prompt costs a handful of
      // tokens rather than the whole block. The full path (not the basename
      // the pill shows) goes out so resolution is unambiguous.
      if (file) {
        emitSpaceIfNeeded();
        out.push(formatCodeRef(file, start, end) + " ");
        return;
      }
      // Pathless badge — code pasted with no source. Keep the fenced block so
      // the content isn't lost; there's nothing for the agent to re-read.
      const lang = el.dataset.lang ?? "";
      const text = el.dataset.code ?? "";
      const fence = safeCodeFence(text);
      emitNewlineIfNeeded();
      out.push(fence + lang + "\n");
      out.push(text.replace(/\n+$/, ""));
      out.push("\n" + fence + "\n");
      return;
    }

    if (el.classList.contains(MENTION_CLASS)) {
      const name = el.dataset.name ?? el.textContent?.replace(/^@/, "") ?? "";
      // Serialize as plain `@basename ` so the rest of the pipeline sees
      // the same token whether the user typed it or picked it. The full
      // path (data-path) is preserved on the DOM for the next edit cycle.
      if (name) out.push(`@${name} `);
      return;
    }

    if (el.tagName === "BR") {
      out.push("\n");
      return;
    }

    if (el.tagName === "DIV" || el.tagName === "P") {
      emitNewlineIfNeeded();
      for (const child of Array.from(el.childNodes)) walk(child);
      emitNewlineIfNeeded();
      return;
    }

    for (const child of Array.from(el.childNodes)) walk(child);
  }

  for (const child of Array.from(container.childNodes)) walk(child);

  return out
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Paste handling (markdown → rich DOM at caret) ──────────

/**
 * Splice a markdown blob into the editor at the current selection,
 * reusing the same parsing logic as the initial mount render. Badge
 * markers (`**label**\n```lang\ncode\n```\n`) become atomic
 * `re-badge` spans; everything else flows in as text + <br/>.
 *
 * Builds the nodes into a detached DocumentFragment first so the
 * editor only mutates once — keeps the caret stable.
 */
function insertParsedAtSelection(container: HTMLElement, text: string): void {
  const sel = window.getSelection();
  let range: Range;
  if (sel && sel.rangeCount > 0 && container.contains(sel.anchorNode as Node | null)) {
    range = sel.getRangeAt(0);
    range.deleteContents();
  } else {
    range = document.createRange();
    range.selectNodeContents(container);
    range.collapse(false);
  }

  const fragment = buildFragmentFromMarkdown(text);
  // We need a stable trailing node to land the caret on, otherwise the
  // browser puts the caret at the very start of the next sibling — which
  // for a trailing badge means "inside the badge", trapping it.
  const trailingSpace = document.createTextNode(" ");
  fragment.appendChild(trailingSpace);

  range.insertNode(fragment);
  range.setStartAfter(trailingSpace);
  range.collapse(true);
  sel?.removeAllRanges();
  sel?.addRange(range);
}

function buildFragmentFromMarkdown(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = text.split("\n");
  let i = 0;
  const textBuf: string[] = [];

  const flushTextBuffer = () => {
    if (textBuf.length === 0) return;
    const parts = textBuf.join("\n").split("\n");
    parts.forEach((p, idx) => {
      if (idx > 0) frag.appendChild(document.createElement("br"));
      if (p.length > 0) frag.appendChild(document.createTextNode(p));
    });
    textBuf.length = 0;
  };

  while (i < lines.length) {
    const line = lines[i];
    const fenceMatch = line.match(FENCE_OPEN_RE);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      const lang = fenceMatch[2].trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !isFenceClose(lines[i], fence)) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // closing fence

      // Pull the trailing **label** line off the buffer if it preceded the fence.
      let label = "";
      while (textBuf.length > 0 && textBuf[textBuf.length - 1].trim() === "") {
        textBuf.pop();
      }
      if (textBuf.length > 0) {
        const last = textBuf[textBuf.length - 1];
        const m = last.match(/^\*\*([^*]+)\*\*\s*$/);
        if (m) {
          label = m[1];
          textBuf.pop();
        }
      }

      flushTextBuffer();
      const parsed = parseBadgeLabel(label);
      frag.appendChild(
        makeCodeBadge(
          parsed.file,
          parsed.startLine,
          parsed.endLine,
          lang,
          codeLines.join("\n")
        )
      );
      frag.appendChild(document.createTextNode(" "));
      continue;
    }
    textBuf.push(line);
    i++;
  }
  flushTextBuffer();
  return frag;
}

/**
 * Pick a code-fence wide enough to safely wrap `text`. CommonMark requires
 * the outer fence to be longer than any backtick run inside the body, so a
 * tagged file that itself contains ``` blocks (markdown, docs, etc.) still
 * round-trips through serialize/parse without collapsing the badge at the
 * first inner ```.
 */
function safeCodeFence(text: string): string {
  let maxRun = 0;
  const matches = text.match(/`+/g);
  if (matches) {
    for (const run of matches) {
      if (run.length > maxRun) maxRun = run.length;
    }
  }
  return "`".repeat(Math.max(3, maxRun + 1));
}

const FENCE_OPEN_RE = /^(`{3,})(.*)$/;

function isFenceClose(line: string, fence: string): boolean {
  const m = line.match(/^(`{3,})\s*$/);
  return m !== null && m[1].length >= fence.length;
}

// ── Initial render (markdown → rich DOM) ───────────────────

function renderInitial(container: HTMLElement, text: string) {
  const lines = text.split("\n");
  let i = 0;

  const flushTextBuffer = (buf: string[]) => {
    if (buf.length === 0) return;
    const joined = buf.join("\n");
    const frag = document.createDocumentFragment();
    const parts = joined.split("\n");
    parts.forEach((p, idx) => {
      if (idx > 0) frag.appendChild(document.createElement("br"));
      if (p.length > 0) frag.appendChild(document.createTextNode(p));
    });
    container.appendChild(frag);
  };

  let textBuf: string[] = [];

  while (i < lines.length) {
    const line = lines[i];

    const fenceMatch = line.match(FENCE_OPEN_RE);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      const lang = fenceMatch[2].trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !isFenceClose(lines[i], fence)) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing fence

      // Pull a trailing **label** off the text buffer if present.
      let label = "";
      while (textBuf.length > 0 && textBuf[textBuf.length - 1].trim() === "") {
        textBuf.pop();
      }
      if (textBuf.length > 0) {
        const last = textBuf[textBuf.length - 1];
        const match = last.match(/^\*\*([^*]+)\*\*\s*$/);
        if (match) {
          label = match[1];
          textBuf.pop();
        }
      }

      flushTextBuffer(textBuf);
      textBuf = [];
      const parsed = parseBadgeLabel(label);
      const badge = makeCodeBadge(
        parsed.file,
        parsed.startLine,
        parsed.endLine,
        lang,
        codeLines.join("\n")
      );
      container.appendChild(badge);
      container.appendChild(document.createTextNode(" "));
      continue;
    }

    textBuf.push(line);
    i++;
  }

  flushTextBuffer(textBuf);
}

// ── Caret + selection helpers ──────────────────────────────

function placeCaretAtEnd(el: HTMLElement) {
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/**
 * The caret lives outside any code-badge by design — code badges are atomic
 * inline spans, not editable blocks. We therefore never need to suppress
 * Enter inside one. (Kept for API parity with previous implementation.)
 */
function cursorInsideCodeBody(): boolean {
  return false;
}

/**
 * If the caret is immediately after an atomic code badge, eat one Backspace
 * by removing that badge. Returns true if handled.
 */
function handleBackspaceAtBoundary(container: HTMLElement | null): boolean {
  if (!container) return false;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  if (!range.collapsed) return false;

  const node = range.startContainer;
  const offset = range.startOffset;

  // Walk back over an optional space/zero-width char then look for a badge.
  let prev: ChildNode | null = null;

  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? "";
    if (offset > 0 && text.charAt(offset - 1) !== " ") return false;
    if (offset === 0) {
      prev = node.previousSibling as ChildNode | null;
    } else {
      // Caret sits one position into a text node whose first chars are spaces
      // we inserted as caret padding. If the only content before is whitespace,
      // jump to the previous sibling.
      if (text.slice(0, offset).trim().length > 0) return false;
      prev = node.previousSibling as ChildNode | null;
    }
  } else if (node === container) {
    prev = (container.childNodes[offset - 1] as ChildNode) ?? null;
  } else {
    return false;
  }

  if (
    prev &&
    prev.nodeType === Node.ELEMENT_NODE &&
    (prev as HTMLElement).classList.contains(BADGE_CLASS)
  ) {
    prev.remove();
    return true;
  }
  return false;
}
