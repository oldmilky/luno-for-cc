// ─────────────────────────────────────────────────────────────
// User message bubble. The wire body is plain markdown, but any
// `**file:lines**\n```lang\n…\n``` ` block was originally an
// inline code badge in the composer — so we re-collapse those
// patterns back into the same compact pill the user saw before
// they sent. Everything else passes through the markdown renderer.
//
// Copy behavior: badge pills hide the actual code behind a click-
// to-expand. A naive browser copy of a selection that includes a
// badge would grab only the visible button label (filename + chevron
// glyphs), not the underlying code. We intercept the `copy` event
// on the bubble and substitute each badge's full markdown body
// (`**file:lines**\n```lang\ncode\n```\n`) for its DOM contents in
// the clipboard payload — Cursor does the same thing. The visible
// UI is unaffected; only what lands in the clipboard changes.
// ─────────────────────────────────────────────────────────────

import {
  ClipboardEvent as ReactClipboardEvent,
  Fragment,
  MouseEvent,
  ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ENTER, SPRING_PRESS } from "../../design/motion";
import { Icon } from "../../design/icons";
import { Tooltip } from "../../design/primitives";
import { renderMarkdown } from "./markdown";
import { newId, onMessage, send } from "../../lib/rpc";
import { ImageLightbox } from "./ImageLightbox";
import s from "./UserMessage.module.scss";
// The sent message shows the very same pill the composer rendered.
import re from "../../design/primitives/RichEditor.module.scss";

interface UserMessageProps {
  id: string;
  text: string;
  canRewind?: boolean;
  messagesAfter?: number;
  onRewindRequest?: (turnId: string, messagesAfter: number) => void;
  onEditRequest?: (turnId: string) => void;
}

type Part =
  | { kind: "text"; text: string }
  | { kind: "badge"; label: string; lang: string; code: string }
  | { kind: "image"; name: string; src: string };

// Variable-length code fence with backreference: matches `` `**label**\n```lang\ncode\n``` `` AND
// `` `**label**\n````lang\ncode (containing ``` blocks)\n```` `` etc., so tagging a markdown
// file whose contents include ``` doesn't collapse the badge at the first inner fence.
const BADGE_RE = /\*\*([^*\n]+)\*\*\n(`{3,})([^\n]*)\n([\s\S]*?)\n\2(?=\s|$)/g;
const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s][^)]*)\)/g;

// Collapse user-message bubbles taller than this (px), with a slack margin so
// content just barely over the line doesn't get a pointless toggle.
const COLLAPSE_MAX = 150;
const COLLAPSE_SLACK = 24;

/**
 * Walk the message body and split it into text / code-badge / image parts.
 * Code-badge markers are matched first; whatever's left is scanned for
 * `![alt](src)` markdown so dropped/pasted screenshots render as a chip
 * (with click-to-preview) instead of broken text. Plain prose passes
 * through to the markdown renderer unchanged.
 */
function parseBody(text: string): Part[] {
  const parts: Part[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  BADGE_RE.lastIndex = 0;
  while ((m = BADGE_RE.exec(text)) !== null) {
    if (m.index > lastIndex) {
      pushTextOrImage(parts, text.slice(lastIndex, m.index));
    }
    parts.push({
      kind: "badge",
      label: m[1].trim(),
      lang: m[3].trim(),
      code: m[4]
    });
    lastIndex = BADGE_RE.lastIndex;
  }
  if (lastIndex < text.length) {
    pushTextOrImage(parts, text.slice(lastIndex));
  }
  return parts;
}

function pushTextOrImage(parts: Part[], slice: string) {
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  IMAGE_RE.lastIndex = 0;
  while ((m = IMAGE_RE.exec(slice)) !== null) {
    if (m.index > lastIndex) {
      parts.push({ kind: "text", text: slice.slice(lastIndex, m.index) });
    }
    parts.push({ kind: "image", name: m[1].trim() || "image", src: m[2] });
    lastIndex = IMAGE_RE.lastIndex;
  }
  if (lastIndex < slice.length) {
    parts.push({ kind: "text", text: slice.slice(lastIndex) });
  }
}

export function UserMessage({
  id,
  text,
  canRewind,
  messagesAfter = 0,
  onRewindRequest,
  onEditRequest
}: UserMessageProps) {
  const parts = useMemo(() => parseBody(text), [text]);
  const [copied, setCopied] = useState(false);

  // Long prompts would otherwise let the bubble grow tall enough to cover the
  // viewport. Clamp the content to COLLAPSE_MAX and reveal a "Show more"
  // toggle once it actually overflows. We measure scrollHeight (which reports
  // the full content height even while clamped) via a ResizeObserver so the
  // toggle appears/disappears as images load or the panel reflows.
  const contentRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [collapsed, setCollapsed] = useState(true);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const measure = () =>
      setOverflowing(el.scrollHeight > COLLAPSE_MAX + COLLAPSE_SLACK);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [parts]);

  const handleBubbleClick = (e: MouseEvent<HTMLDivElement>) => {
    if (!onEditRequest) return;
    const t = e.target as HTMLElement;
    if (t.closest("button, a")) return;
    // Don't enter edit mode if the user was selecting text or dragged.
    // A drag-to-select leaves a non-collapsed window selection at mouseup;
    // tearing down the message into the composer at that point would
    // destroy the selection before Cmd+C can fire. We let the click
    // through only when the user has not selected anything (single click).
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) return;
    onEditRequest(id);
  };

  const handleCopyButton = async (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    // Build the clipboard payload from the parsed parts directly — this
    // works regardless of whether the user has any text selected.
    const out = parts
      .map((p) => {
        if (p.kind === "text") return p.text;
        if (p.kind === "image") return `![${p.name}](${p.src})`;
        const fence = safeCodeFence(p.code);
        return `**${p.label}**\n${fence}${p.lang}\n${p.code}\n${fence}\n`;
      })
      .join("");
    try {
      await navigator.clipboard.writeText(out);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = out;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  /**
   * Replace any badge pill in the selection with its original markdown
   * (`**file:lines**\n```lang\ncode\n```\n`) before writing the clipboard
   * payload. We `cloneContents()` the selection (which gives us a detached
   * DocumentFragment we can mutate freely), swap every `[data-copy-text]`
   * element for a text node carrying the original markdown, then read the
   * fragment's textContent. If the selection contains no badge — there's
   * nothing to fix, so we let the browser handle copy natively.
   */
  const handleCopy = (e: ReactClipboardEvent<HTMLDivElement>) => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const fragment = range.cloneContents();
    const badges = fragment.querySelectorAll("[data-copy-text]");
    if (badges.length === 0) return;
    badges.forEach((b) => {
      const md = (b as HTMLElement).dataset.copyText ?? "";
      b.replaceWith(document.createTextNode(md));
    });
    const out = fragment.textContent ?? "";
    if (!out.trim()) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", out);
  };

  const editable = !!onEditRequest;

  return (
    <motion.div className={s.row} {...ENTER}>
      {/* SPRING_PRESS, not the PRESS preset: the affordance here is hover,
          and PRESS would move the trigger to tap. Only the spring is shared. */}
      <motion.div
        className={s.avatar}
        whileHover={{ scale: 1.08 }}
        transition={SPRING_PRESS}
      >
        Y
      </motion.div>
      {/* `disabled`, not a conditional label: the bubble is only a button when
          an edit handler exists, and the Tooltip has to stay mounted either way
          so the surrounding markup does not change shape mid-conversation. */}
      <Tooltip label="Click to edit and re-run from here" disabled={!editable}>
        <div
          className={`md ${s.bubble}${editable ? ` ${s.editable}` : ""}`}
          onClick={handleBubbleClick}
          onCopy={handleCopy}
          role={editable ? "button" : undefined}
          tabIndex={editable ? 0 : undefined}
        >
          <div
            ref={contentRef}
            className={s.content}
            style={
              overflowing && collapsed ? { maxHeight: COLLAPSE_MAX } : undefined
            }
          >
            {parts.map((p, i) => {
              if (p.kind === "text") {
                return <Fragment key={i}>{renderTextPart(p.text, i)}</Fragment>;
              }
              if (p.kind === "badge") {
                return (
                  <MsgBadge
                    key={i}
                    label={p.label}
                    lang={p.lang}
                    code={p.code}
                  />
                );
              }
              return <MsgImage key={i} name={p.name} src={p.src} />;
            })}
            {overflowing && collapsed && <div className={s.fade} />}
          </div>
          {overflowing && (
            <button
              type="button"
              className={s.toggle}
              onClick={(e) => {
                e.stopPropagation();
                setCollapsed((c) => !c);
              }}
              aria-expanded={!collapsed}
            >
              <Icon name={collapsed ? "chevronD" : "chevronU"} size={11} />
              {collapsed ? "Show more" : "Show less"}
            </button>
          )}
          <div className={s.actions}>
            <Tooltip label="Copy message (including tagged code)">
              <button
                type="button"
                className={s.action}
                onClick={handleCopyButton}
                aria-label="Copy message"
              >
                <Icon name={copied ? "check" : "copy"} size={11} />
                {copied ? "Copied" : "Copy"}
              </button>
            </Tooltip>
            {canRewind && (
              <Tooltip label="Rewind conversation to here">
                <button
                  type="button"
                  className={s.rewind}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRewindRequest?.(id, messagesAfter);
                  }}
                >
                  <Icon name="history" size={11} />
                  Rewind
                </button>
              </Tooltip>
            )}
          </div>
        </div>
      </Tooltip>
    </motion.div>
  );
}

function renderTextPart(text: string, key: number): ReactNode {
  const trimmed = text.replace(/^\n+/, "").replace(/\n+$/, "");
  if (!trimmed) return null;
  return <Fragment key={key}>{renderMarkdown(trimmed)}</Fragment>;
}

/**
 * Image attachment chip rendered inline in the user-message bubble. Looks
 * like the composer's attachment chip (file icon · name · "preview" hint)
 * and opens a lightbox on click. The image bytes live on disk (we stripped
 * the data URL from the prompt so the agent doesn't get a huge base64
 * blob) — clicking asks the extension to read the file and ship the data
 * URL back over RPC, then we cache it locally.
 */
function MsgImage({ name, src }: { name: string; src: string }) {
  const isData = src.startsWith("data:");
  const [resolved, setResolved] = useState<string | null>(isData ? src : null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);

  // The extension answers a `readAttachment` RPC with `attachmentData`. We
  // request only on the first preview click — the data URL can be huge so
  // there's no point eagerly loading every chip in long histories.
  useEffect(() => {
    if (!requestId) return;
    return onMessage((m) => {
      if (m.type !== "attachmentData" || m.id !== requestId) return;
      if (m.dataUrl) setResolved(m.dataUrl);
      if (m.error) setError(m.error);
    });
  }, [requestId]);

  const openPreview = () => {
    if (!resolved && !isData) {
      const id = newId();
      setRequestId(id);
      send({ type: "readAttachment", id, path: src });
    }
    setOpen(true);
  };

  return (
    <>
      {/* `wrap`: the chip clips the name at 200px, so the label is here to
          show the part the ellipsis took — on one line it would be cut again. */}
      <Tooltip label={`Preview ${name}`} wrap>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            openPreview();
          }}
          className={s.imageChip}
        >
          <Icon name="file" size={12} />
          <span className={s.imageChipName}>{name}</span>
        </button>
      </Tooltip>
      <AnimatePresence>
        {open && (
          <ImageLightbox
            name={name}
            src={resolved}
            error={error}
            onClose={() => setOpen(false)}
          />
        )}
      </AnimatePresence>
    </>
  );
}

function MsgBadge({
  label,
  lang,
  code
}: {
  label: string;
  lang: string;
  code: string;
}) {
  // The original markdown the user typed/dragged. `onCopy` on the bubble
  // reads this attribute and substitutes it for the visible button text
  // so a copy of "the pill" yields the actual code, not just the filename.
  const fence = safeCodeFence(code);
  const copyText = `**${label}**\n${fence}${lang}\n${code}\n${fence}\n`;
  const parsed = parseBadgeLabel(label);
  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (!parsed.file) return;
    send({
      type: "openFile",
      path: parsed.file,
      startLine: parsed.startLine,
      endLine: parsed.endLine
    });
  };
  return (
    <span className={s.badgeWrap} data-copy-text={copyText}>
      {/* `wrap`: `file:start–end` is clipped at 240px in the pill, and the
          fallback branch is the bare value with no verb in front of it. */}
      <Tooltip label={parsed.file ? `Open ${label}` : label} wrap>
        <button type="button" className={re.badge} onClick={handleClick}>
          <span className={re.badgeIcon}>{"</>"}</span>
          <span className={re.badgeLabel}>{label}</span>
        </button>
      </Tooltip>
    </span>
  );
}

/**
 * Inverse of the composer's `formatBadgeLabel` — turn `file:start–end` (or
 * `file:start-end` / `file:start`) back into structured fields so clicking
 * the pill can open the right file range. Kept in sync by hand with the
 * RichEditor's parser; the data is just simple enough to duplicate.
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

/**
 * Pick a code-fence wide enough to safely wrap `text`. Mirrors the
 * RichEditor's `safeCodeFence` so badge round-trips (copy → paste) survive
 * content that itself contains ``` blocks (markdown files, etc.).
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
