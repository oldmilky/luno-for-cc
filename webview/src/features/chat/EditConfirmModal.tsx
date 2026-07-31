// ─────────────────────────────────────────────────────────────
// Confirmation modal for edit-and-resubmit. Editing a past
// message ALWAYS discards everything that came after it (a
// fresh conversation branch starts from this point); the only
// question is whether the workspace files should also revert
// to the snapshot taken when this message was originally sent.
//
// Three outcomes:
//   • Cancel       (Esc)     — close the modal, keep editing
//   • Don't revert (⇧↵)      — discard messages, leave files
//   • Revert       (↵)       — discard messages AND restore files
// ─────────────────────────────────────────────────────────────

import { useEffect } from "react";
import { motion } from "framer-motion";
import { BACKDROP, OVERLAY_PANEL } from "../../design/motion";
import { formatDuration } from "./tool-buckets";
import type { LiveAgents } from "./subagent-state";
import s from "./EditConfirmModal.module.scss";

interface EditConfirmModalProps {
  messagesAfter: number;
  /** What submitting from here will also destroy — see RewindModal, which
   *  takes the same warning for the same reason. */
  agents: LiveAgents;
  onCancel: () => void;
  onDontRevert: () => void;
  onRevert: () => void;
}

export function EditConfirmModal({
  messagesAfter,
  agents,
  onCancel,
  onDontRevert,
  onRevert
}: EditConfirmModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (e.shiftKey) onDontRevert();
        else onRevert();
      }
    };
    // Defer registration to the next frame so the in-flight keydown that
    // *opened* this modal (the Enter pressed in the inline editor) has
    // fully propagated and won't immediately trigger Revert. Without this,
    // the modal would auto-confirm on the same Enter that submitted.
    let cancelled = false;
    const id = requestAnimationFrame(() => {
      if (cancelled) return;
      window.addEventListener("keydown", onKey);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(id);
      window.removeEventListener("keydown", onKey);
    };
  }, [onCancel, onDontRevert, onRevert]);

  const clearedClause =
    messagesAfter > 0
      ? ` and clear the ${messagesAfter} message${messagesAfter !== 1 ? "s" : ""} after this one`
      : "";
  const body = `Submitting from a previous message will revert file changes to before this message${clearedClause}.`;

  return (
    <motion.div
      className={s.overlay}
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      {...BACKDROP}
    >
      <motion.div
        className={s.dialog}
        onClick={(e) => e.stopPropagation()}
        {...OVERLAY_PANEL}
        // This dialog has never travelled — it only scales — and the sweep is
        // not allowed to add properties. Preset timing, curve and scale
        // amplitude; the `y` is dropped.
        initial={{ opacity: 0, scale: OVERLAY_PANEL.initial.scale }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: OVERLAY_PANEL.exit.scale }}
      >
        <h2 className={s.title}>Submit from a previous message?</h2>
        <p className={s.body}>{body}</p>
        {agents.count > 0 && (
          <p className={s.warning}>
            {agents.count} agent{agents.count !== 1 ? "s" : ""} still working
            {agents.longestMs > 0 && (
              <> — the longest at {formatDuration(agents.longestMs)}</>
            )}{" "}
            will be stopped, and their work is not recoverable.
          </p>
        )}
        <div className={s.actions}>
          <button type="button" className={s.cancel} onClick={onCancel}>
            Cancel <span className={s.hint}>(esc)</span>
          </button>
          <button type="button" className={s.secondary} onClick={onDontRevert}>
            Don't revert
            <span className={s.hint}>⇧↵</span>
          </button>
          <button type="button" className={s.primary} onClick={onRevert}>
            Revert <span className={s.hintOnAccent}>↵</span>
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
