// ─────────────────────────────────────────────────────────────
// Floating "+" button + comment popover that activates whenever
// the user has a non-empty text selection inside the plan body.
// Mirrors the Antigravity / GitHub-PR review-comment UX:
//
//   1. Select text in the rendered markdown
//   2. A small green "+" pip appears next to the selection
//   3. Click it → popover anchored to the same spot, with a
//      preview of the quoted passage and a textarea
//   4. Submit → planComment RPC fires with `quote` set; on the
//      next render the quoted passage is highlighted inline.
//
// Positioning uses fixed-position + DOMRect coords so the
// floating UI scrolls with the selection without us having to
// translate scroll containers manually.
// ─────────────────────────────────────────────────────────────

import { RefObject, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { POPOVER } from "../../design/motion";
import { Icon } from "../../design/icons";
import { Tooltip } from "../../design/primitives";
import { send } from "../../lib/rpc";
import { truncate } from "./utils";
import s from "./SelectionCommentLayer.module.scss";
import btn from "./PlanButton.module.scss";

interface Props {
  /** The container that holds the rendered markdown body. */
  containerRef: RefObject<HTMLElement | null>;
  revisionId: string;
  /** Hide controls on superseded revisions (read-only). */
  locked: boolean;
  /** Optional preview ref — e.g. the modal scroll container — used so we
   * keep the popover visible when the user scrolls.  */
  scrollContainerRef?: RefObject<HTMLElement | null>;
}

interface Trigger {
  x: number;
  y: number;
  quote: string;
}

const MAX_QUOTE_PREVIEW = 140;
const POPOVER_WIDTH = 320;

export function SelectionCommentLayer({ containerRef, revisionId, locked }: Props) {
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [popover, setPopover] = useState<Trigger | null>(null);
  const [draft, setDraft] = useState("");
  const popoverRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Track the active text selection inside the markdown container.
  useEffect(() => {
    if (locked) return;
    const handler = () => {
      // Don't refresh while the popover is open — the selection inside the
      // textarea would otherwise reset the trigger.
      if (popover) return;
      const sel = window.getSelection();
      const container = containerRef.current;
      if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !container) {
        setTrigger(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const inside =
        container.contains(range.startContainer) &&
        container.contains(range.endContainer);
      if (!inside) {
        setTrigger(null);
        return;
      }
      const text = sel.toString().trim();
      if (!text) {
        setTrigger(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      // Anchor the trigger just past the selection's top-right corner.
      setTrigger({
        x: Math.min(window.innerWidth - 32, rect.right + 6),
        y: Math.max(8, rect.top - 4),
        quote: sel.toString()
      });
    };
    document.addEventListener("selectionchange", handler);
    return () => document.removeEventListener("selectionchange", handler);
  }, [containerRef, locked, popover]);

  // Auto-focus the textarea when the popover opens.
  useEffect(() => {
    if (popover) {
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [popover]);

  // Close popover on outside click or Esc.
  useEffect(() => {
    if (!popover) return;
    const onMouseDown = (e: MouseEvent) => {
      if (popoverRef.current && popoverRef.current.contains(e.target as Node)) return;
      setPopover(null);
      setDraft("");
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPopover(null);
        setDraft("");
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [popover]);

  const submit = () => {
    const body = draft.trim();
    if (!body || !popover) return;
    send({
      type: "planComment",
      revisionId,
      taskId: "__inline__",
      body,
      quote: popover.quote
    });
    setPopover(null);
    setDraft("");
    setTrigger(null);
    // Drop the visible selection so the highlight on the new comment is
    // what the user sees first.
    window.getSelection()?.removeAllRanges();
  };

  if (locked) return null;

  // Both surfaces are anchored to a point in the document rather than to the
  // viewport, so they take POPOVER — the pip is small, but it behaves like a
  // dropdown, not like a row arriving in a list. Two separate AnimatePresence
  // blocks rather than one: the pip and the popover sit at different
  // coordinates, and a shared presence would treat the swap as one element
  // moving between them.
  return (
    <>
      <AnimatePresence>
        {trigger && !popover && (
          // The Tooltip clones the pip rather than wrapping it, so the
          // motion element is still the one AnimatePresence drives on exit.
          <Tooltip label="Comment on this selection">
            <motion.button
              type="button"
              className={s.trigger}
              style={{ left: trigger.x, top: trigger.y }}
              {...POPOVER}
              onMouseDown={(e) => {
                // Don't let the button-press collapse the active selection.
                e.preventDefault();
              }}
              onClick={() => {
                // Anchor the popover to the trigger position. Clamp to viewport.
                const x = Math.min(trigger.x, window.innerWidth - POPOVER_WIDTH - 12);
                const y = Math.min(trigger.y, window.innerHeight - 220);
                setPopover({ x, y, quote: trigger.quote });
              }}
            >
              <Icon name="plus" size={11} />
            </motion.button>
          </Tooltip>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {popover && (
          <motion.div
            ref={popoverRef}
            className={s.popover}
            style={{ left: popover.x, top: popover.y, width: POPOVER_WIDTH }}
            {...POPOVER}
          >
            <Tooltip label={popover.quote} wrap>
              <div className={s.quote}>
                “{truncate(popover.quote, MAX_QUOTE_PREVIEW)}”
              </div>
            </Tooltip>
            <textarea
              ref={textareaRef}
              className={s.input}
              placeholder="Leave a comment on this passage…"
              rows={3}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            <div className={s.actions}>
              <button
                type="button"
                className={`${btn.btn} ${s.compact}`}
                onClick={() => {
                  setPopover(null);
                  setDraft("");
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className={`${btn.btn} ${btn.primary} ${s.compact}`}
                onClick={submit}
                disabled={!draft.trim()}
              >
                Add Comment
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
