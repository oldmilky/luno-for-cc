// ─────────────────────────────────────────────────────────────
// Inline suggestion shown above the chat composer when the task
// classifier picked a task type with a known marketplace skill
// recommendation and that skill isn't installed yet.
// ─────────────────────────────────────────────────────────────

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ENTER_CARD } from "../../design/motion";
import { send } from "../../lib/rpc";
import { SkillDetailModal } from "./SkillDetailModal";
import bits from "./ChatBits.module.scss";

interface SkillSuggestionProps {
  skillId: string;
  skillName: string;
  reason: string;
  taskType: string;
  onDismiss: () => void;
}

export function SkillSuggestion({
  skillId,
  skillName,
  reason,
  taskType,
  onDismiss
}: SkillSuggestionProps) {
  const [detailOpen, setDetailOpen] = useState(false);

  return (
    <>
    <motion.div {...ENTER_CARD} className={bits.banner} role="status">
      <div className={bits.bannerBody}>
        <span className={bits.bannerTag}>
          {taskType}
        </span>
        Detected — <strong>{skillName}</strong> recommended for {reason}.
      </div>
      <div className={bits.bannerActions}>
        <button
          type="button"
          className={bits.bannerPrimary}
          onClick={() => setDetailOpen(true)}
        >
          View skill
        </button>
        <button
          type="button"
          className={bits.bannerGhost}
          onClick={() => {
            send({ type: "dismissSkillSuggestion", skillId });
            onDismiss();
          }}
        >
          Don't suggest again
        </button>
        <button type="button" className={bits.bannerGhost} onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </motion.div>
    {/* The modal ships its own exit, but framer can only play it while an
        AnimatePresence still has the child mounted. */}
    <AnimatePresence>
      {detailOpen && (
        <SkillDetailModal
          skillName={skillName}
          onClose={() => setDetailOpen(false)}
        />
      )}
    </AnimatePresence>
    </>
  );
}
