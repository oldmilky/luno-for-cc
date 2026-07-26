// ─────────────────────────────────────────────────────────────
// Flat (non-nested) comment thread anchored to a single task in
// a plan revision. Renders existing comments + a textarea for
// adding another. The "Update plan" button lives on PlanCard,
// not here — comments accumulate locally and are bundled on
// resubmit.
// ─────────────────────────────────────────────────────────────

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { EXPAND, enterAt } from "../../design/motion";
import { Icon } from "../../design/icons";
import { send } from "../../lib/rpc";
import type { PlanCommentMeta } from "./types";
import s from "./PlanCommentThread.module.scss";

interface Props {
  revisionId: string;
  taskId: string;
  comments: Array<PlanCommentMeta & { eventId: string; ts: number }>;
  /** Locked once the revision has been superseded — read-only mode. */
  locked: boolean;
}

export function PlanCommentThread({
  revisionId,
  taskId,
  comments,
  locked
}: Props) {
  const [draft, setDraft] = useState("");
  const own = comments.filter((c) => c.taskId === taskId);

  const submit = () => {
    const body = draft.trim();
    if (!body) return;
    send({ type: "planComment", revisionId, taskId, body });
    setDraft("");
  };

  // The card root is not animated here: PlanTaskTree renders this component
  // behind `{open && …}`, so the presence that would let it leave has to sit
  // in that parent. An enter-only expand would give it an open gesture and no
  // close, which is the asymmetry the language exists to remove.
  return (
    <div className={s.thread}>
      <AnimatePresence initial={false}>
        {own.length > 0 && (
          <motion.ul key="list" {...EXPAND} className={s.list}>
            {own.map((c, i) => (
              <motion.li
                key={c.eventId}
                {...enterAt(i)}
                className={
                  c.resolvedInRevisionId
                    ? `${s.comment} ${s.resolved}`
                    : s.comment
                }
              >
                <div className={s.meta}>
                  <Icon name="user" size={11} />
                  <span className={s.time}>{formatTime(c.ts)}</span>
                  {c.resolvedInRevisionId && (
                    <span className={s.tag}>addressed</span>
                  )}
                </div>
                <div className={s.body}>{c.body}</div>
              </motion.li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
      {!locked && (
        <div className={s.compose}>
          <textarea
            className={s.input}
            placeholder="Add a comment on this step…"
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
          />
          <button
            type="button"
            className={s.submit}
            onClick={submit}
            disabled={!draft.trim()}
          >
            Comment
          </button>
        </div>
      )}
    </div>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
