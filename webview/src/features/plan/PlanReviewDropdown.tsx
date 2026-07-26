// ─────────────────────────────────────────────────────────────
// Header "Review ▾" dropdown — whole-plan comment composer.
// Vertical layout: textarea (multiline), then a full-width
// Submit button beneath it. The hint reminds users that
// passage-specific comments live behind the selection-+ flow
// in the document body.
//
// Mounted as a fixed-position popover anchored under the
// trigger button. Closes on outside click or Esc.
// ─────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { POPOVER } from "../../design/motion";
import { send } from "../../lib/rpc";
import s from "./PlanReviewDropdown.module.scss";
import btn from "./PlanButton.module.scss";

interface Props {
  revisionId: string;
  locked: boolean;
  onClose: () => void;
  /** Anchor coordinates (viewport-relative) for the dropdown. */
  anchor: { right: number; top: number };
}

export function PlanReviewDropdown({ revisionId, locked, onClose, anchor }: Props) {
  const [draft, setDraft] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && ref.current.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const id = requestAnimationFrame(() => {
      document.addEventListener("mousedown", onMouseDown);
    });
    document.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const submit = () => {
    const body = draft.trim();
    if (!body || locked) return;
    send({ type: "planComment", revisionId, taskId: "__general__", body });
    setDraft("");
    onClose();
  };

  return (
    <motion.div
      ref={ref}
      className={s.popover}
      style={{ right: anchor.right, top: anchor.top }}
      {...POPOVER}
      role="dialog"
      aria-label="Submit comment"
    >
      <div className={s.title}>Submit comment</div>
      <textarea
        ref={inputRef}
        className={s.input}
        placeholder="Add a message…"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={3}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        disabled={locked}
      />
      <button
        type="button"
        className={`${btn.btn} ${btn.primary} ${btn.block} ${s.submit}`}
        onClick={submit}
        disabled={!draft.trim() || locked}
      >
        Submit
      </button>
      <p className={s.hint}>Select text in the artifact to add a comment</p>
    </motion.div>
  );
}
