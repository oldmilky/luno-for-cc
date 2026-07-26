// ─────────────────────────────────────────────────────────────
// One plan step rendered as a self-contained card. The same
// component handles three visual densities controlled by `mode`:
//
//   "active"    — the step the agent is currently waiting on.
//                 Full controls: Open file ↗, Skip, Modify, Accept.
//   "completed" — read-only summary for steps already accepted /
//                 completed. Tasks tree shows them collapsed.
//   "upcoming"  — preview-only with reduced opacity; clicking
//                 "Open file" still works so the user can sneak
//                 ahead and read the source.
//
// File refs are rendered as clickable chips that fire
// planOpenFileRef → vscode.window.showTextDocument on the
// extension host. Comments tied to this step (taskId === task.id)
// surface as a count chip on the row; clicking it doesn't open
// the modal popover — that lives in the editor decorations and
// the chat-side comments list.
// ─────────────────────────────────────────────────────────────

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Icon, IconName } from "../../design/icons";
import { Chip, Tooltip } from "../../design/primitives";
import { ENTER, EXPAND } from "../../design/motion";
import { send } from "../../lib/rpc";
import type { PlanCommentMeta, PlanTask, PlanTaskFileRef } from "./types";
import s from "./PlanStepCard.module.scss";
import btn from "./PlanButton.module.scss";

type StepMode = "active" | "completed" | "upcoming";

// Density and status are separate axes on the same card, so they map to
// separate class tables. Statuses with no visual of their own map to "".
const MODE_CLASS: Record<StepMode, string> = {
  active: s.active,
  completed: s.completed,
  upcoming: s.upcoming
};

const STATUS_CLASS: Record<PlanTask["status"], string> = {
  pending: "",
  in_progress: "",
  completed: "",
  accepted: "",
  skipped: s.statusSkipped
};

const GLYPH_CLASS: Record<PlanTask["status"], string> = {
  pending: "",
  in_progress: s.glyphInProgress,
  completed: s.glyphDone,
  accepted: s.glyphDone,
  skipped: s.glyphSkipped
};

interface Props {
  task: PlanTask;
  index: number;
  total: number;
  revisionId: string;
  mode: StepMode;
  /** All comments on this revision (used to show a count for this task). */
  comments: PlanCommentMeta[];
  /** Disable controls when the revision is superseded. */
  locked: boolean;
}

export function PlanStepCard({
  task,
  index,
  total,
  revisionId,
  mode,
  comments,
  locked
}: Props) {
  const [modifyOpen, setModifyOpen] = useState(false);
  const [modifyDraft, setModifyDraft] = useState("");

  const stepComments = comments.filter(
    (c) => c.taskId === task.id && !c.deleted
  );
  const status = task.status;
  const fileRefs = task.fileRefs ?? [];

  const accept = () => {
    if (locked || mode !== "active") return;
    send({ type: "planAcceptStep", revisionId, taskId: task.id });
  };
  const skip = () => {
    if (locked || mode !== "active") return;
    send({ type: "planSkipStep", revisionId, taskId: task.id });
  };
  const submitModify = () => {
    const instr = modifyDraft.trim();
    if (!instr || locked || mode !== "active") return;
    send({
      type: "planModifyStep",
      revisionId,
      taskId: task.id,
      instruction: instr
    });
    setModifyDraft("");
    setModifyOpen(false);
  };

  return (
    <div
      className={[s.step, MODE_CLASS[mode], STATUS_CLASS[status]]
        .filter(Boolean)
        .join(" ")}
    >
      <div className={s.row}>
        <span
          className={[s.glyph, GLYPH_CLASS[status]].filter(Boolean).join(" ")}
          aria-hidden
        >
          <Icon name={statusIcon(status)} size={11} />
        </span>
        <span className={s.num}>
          Step {index + 1}/{total}
        </span>
        <span className={s.statusChip}>
          <Chip tone={statusTone(status)}>{statusLabel(status)}</Chip>
        </span>
        {stepComments.length > 0 && (
          // Comments land on a step that is already on screen, so the count
          // arrives on its own rather than with the card.
          <Tooltip label="Comments on this step">
            <motion.span className={s.commentsChip} {...ENTER}>
              <Icon name="at" size={10} />
              {stepComments.length}
            </motion.span>
          </Tooltip>
        )}
      </div>

      <div className={s.content}>
        {mode === "completed" && status === "in_progress"
          ? task.activeForm
          : task.content}
      </div>

      {fileRefs.length > 0 && (
        <div className={s.files}>
          {fileRefs.map((ref, i) => (
            <FileRefChip key={`${ref.path}:${ref.startLine}:${i}`} ref={ref} />
          ))}
        </div>
      )}

      {/* Three states share this slot: the action row, the modify composer,
          and nothing at all once the step stops being the active one. `wait`
          is what keeps the swap honest — running both at once would balloon
          the card to the height of the row plus the composer and then snap
          back. `initial={false}` so the row does not play on mount. */}
      <AnimatePresence initial={false} mode="wait">
        {mode === "active" && !locked ? (
          modifyOpen ? (
            <motion.div key="modify" className={s.modify} {...EXPAND}>
              <textarea
                autoFocus
                className={s.modifyInput}
                rows={3}
                placeholder="What should change about this step?"
                value={modifyDraft}
                onChange={(e) => setModifyDraft(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    submitModify();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setModifyOpen(false);
                    setModifyDraft("");
                  }
                }}
              />
              <div className={s.modifyActions}>
                <button
                  type="button"
                  className={btn.btn}
                  onClick={() => {
                    setModifyOpen(false);
                    setModifyDraft("");
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className={`${btn.btn} ${btn.primary}`}
                  onClick={submitModify}
                  disabled={!modifyDraft.trim()}
                >
                  Submit modification
                </button>
              </div>
            </motion.div>
          ) : (
            <motion.div key="actions" className={s.actions} {...EXPAND}>
              <Tooltip label="Skip this step (don't execute it)">
                <button
                  type="button"
                  className={`${s.action} ${s.actionSkip}`}
                  onClick={skip}
                >
                  <Icon name="x" size={10} />
                  Skip
                </button>
              </Tooltip>
              <Tooltip label="Suggest a change to this step">
                <button
                  type="button"
                  className={`${s.action} ${s.actionModify}`}
                  onClick={() => setModifyOpen(true)}
                >
                  <Icon name="edit" size={10} />
                  Modify
                </button>
              </Tooltip>
              <span className={s.actionSpacer} />
              <Tooltip label="Approve and execute this step">
                <button
                  type="button"
                  className={`${s.action} ${s.actionAccept}`}
                  onClick={accept}
                >
                  <Icon name="check" size={10} />
                  Accept &amp; continue
                </button>
              </Tooltip>
            </motion.div>
          )
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function FileRefChip({ ref }: { ref: PlanTaskFileRef }) {
  const label = ref.label || ref.path;
  const range =
    ref.startLine === ref.endLine
      ? `:${ref.startLine}`
      : `:${ref.startLine}-${ref.endLine}`;
  return (
    <Tooltip label={`Open ${ref.path}${range}`}>
      <button
        type="button"
        className={s.file}
        onClick={() =>
          send({
            type: "planOpenFileRef",
            path: ref.path,
            startLine: ref.startLine,
            endLine: ref.endLine
          })
        }
      >
        <Icon name="file" size={10} />
        <span className={s.fileLabel}>{label}</span>
        {ref.startLine !== 1 || ref.endLine !== 1 ? (
          <span className={s.fileRange}>{range}</span>
        ) : null}
      </button>
    </Tooltip>
  );
}

// `status`, not `s` — `s` is the styles object at module scope.
function statusIcon(status: PlanTask["status"]): IconName {
  switch (status) {
    case "completed":
      return "check";
    case "accepted":
      return "check";
    case "in_progress":
      return "bolt";
    case "skipped":
      return "x";
    default:
      return "dots";
  }
}

function statusTone(status: PlanTask["status"]) {
  switch (status) {
    case "completed":
    case "accepted":
      return "success" as const;
    case "in_progress":
      return "accent" as const;
    case "skipped":
      return "default" as const;
    default:
      return "default" as const;
  }
}

function statusLabel(status: PlanTask["status"]): string {
  switch (status) {
    case "completed":
      return "done";
    case "accepted":
      return "accepted";
    case "in_progress":
      return "running";
    case "skipped":
      return "skipped";
    default:
      return "pending";
  }
}
