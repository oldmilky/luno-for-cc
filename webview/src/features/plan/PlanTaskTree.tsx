// ─────────────────────────────────────────────────────────────
// Task tree for a plan revision. Flat list (CLI's TodoWrite is
// not nested), but each row gets an expandable comment thread.
// ─────────────────────────────────────────────────────────────

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Icon, IconName } from "../../design/icons";
import { Chip, Tooltip } from "../../design/primitives";
import { EXPAND, enterAt } from "../../design/motion";
import { PlanCommentThread } from "./PlanCommentThread";
import type { PlanCommentMeta, PlanTask } from "./types";
import s from "./PlanTaskTree.module.scss";

// Only these two statuses restyle a row; the rest inherit the base look.
const ROW_CLASS: Partial<Record<PlanTask["status"], string>> = {
  in_progress: s.taskInProgress,
  completed: s.taskCompleted
};

const GLYPH_CLASS: Partial<Record<PlanTask["status"], string>> = {
  in_progress: s.glyphInProgress,
  completed: s.glyphCompleted
};

interface Props {
  revisionId: string;
  tasks: PlanTask[];
  comments: Array<PlanCommentMeta & { eventId: string; ts: number }>;
  locked: boolean;
}

export function PlanTaskTree({ revisionId, tasks, comments, locked }: Props) {
  if (tasks.length === 0) {
    return <div className={s.empty}>No tasks defined in this revision.</div>;
  }

  return (
    <ol className={s.tasks}>
      {tasks.map((t, i) => (
        <PlanTaskRow
          key={t.id}
          index={i + 1}
          task={t}
          revisionId={revisionId}
          comments={comments}
          locked={locked}
        />
      ))}
    </ol>
  );
}

interface RowProps {
  index: number;
  task: PlanTask;
  revisionId: string;
  comments: Props["comments"];
  locked: boolean;
}

function PlanTaskRow({ index, task, revisionId, comments, locked }: RowProps) {
  const [open, setOpen] = useState(false);
  const taskComments = comments.filter((c) => c.taskId === task.id);
  const hasComments = taskComments.length > 0;
  const status = task.status;

  return (
    // The whole tree arrives in one commit, so the rows are staggered rather
    // than landing together. `index` is 1-based for display.
    <motion.li
      {...enterAt(index - 1)}
      className={[s.task, ROW_CLASS[status] ?? ""].filter(Boolean).join(" ")}
    >
      <div className={s.row}>
        <span
          className={[s.glyph, GLYPH_CLASS[status] ?? ""]
            .filter(Boolean)
            .join(" ")}
          aria-hidden
        >
          <Icon name={statusIcon(status)} size={11} />
        </span>
        <span className={s.index}>{index}.</span>
        <span className={s.content}>
          {status === "in_progress" ? task.activeForm : task.content}
        </span>
        <Chip tone={statusTone(status)}>{statusLabel(status)}</Chip>
        <Tooltip
          label={
            hasComments ? `${taskComments.length} comment(s)` : "Add a comment"
          }
        >
          <button
            type="button"
            className={[s.commentBtn, hasComments ? s.hasComments : ""]
              .filter(Boolean)
              .join(" ")}
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
          >
            <Icon name="at" size={11} />
            {hasComments && (
              <span className={s.commentCount}>{taskComments.length}</span>
            )}
          </button>
        </Tooltip>
      </div>
      {/* PlanCommentThread is a plain component, so the collapse needs its own
          element to animate — and one that clips, since EXPAND works on
          height. */}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div key="thread" className={s.threadWrap} {...EXPAND}>
            <PlanCommentThread
              revisionId={revisionId}
              taskId={task.id}
              comments={taskComments}
              locked={locked}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.li>
  );
}

// `status`, not `s` — `s` is the styles object at module scope.
function statusIcon(status: PlanTask["status"]): IconName {
  if (status === "completed") return "check";
  if (status === "in_progress") return "bolt";
  return "dots";
}

function statusTone(status: PlanTask["status"]) {
  if (status === "completed") return "success" as const;
  if (status === "in_progress") return "accent" as const;
  return "default" as const;
}

function statusLabel(status: PlanTask["status"]): string {
  if (status === "completed") return "done";
  if (status === "in_progress") return "active";
  return "pending";
}
