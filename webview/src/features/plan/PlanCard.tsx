// ─────────────────────────────────────────────────────────────
// Compact Plan Card — the chat-stream representation of a plan
// revision. Shows only the title and a short prose preview plus
// "Proceed" and "Open" actions. Clicking "Open" mounts a
// PlanFullView with the full markdown, task tree, comments, and
// question cards. Clicking "Proceed" sends an approval prompt
// so the agent moves out of plan mode and starts executing.
//
// All persistent state (comments, answers, revisions, rewind
// anchors) lives in the timeline events; this component is a
// pure projection of the matching PlanRevisionView.
// ─────────────────────────────────────────────────────────────

import { useMemo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Icon } from "../../design/icons";
import { Chip, Tooltip } from "../../design/primitives";
import { ENTER, ENTER_CARD, EXPAND } from "../../design/motion";
import { send } from "../../lib/rpc";
import { unresolvedComments } from "./foldPlanState";
import { extractPlanSummary } from "./summary";
import type { PlanRevisionView } from "./types";
import s from "./PlanCard.module.scss";
import btn from "./PlanButton.module.scss";

interface Props {
  view: PlanRevisionView;
  /** The previous revision in chronological order, used for diffing. */
  previous?: PlanRevisionView;
  /** This is the latest revision — input controls are live. */
  isLatest: boolean;
  /** Index in the revision list, 1-based. */
  ordinal: number;
}

export function PlanCard({ view, isLatest, ordinal }: Props) {
  const summary = useMemo(
    () => extractPlanSummary(view.meta.body),
    [view.meta.body]
  );
  const pending = unresolvedComments(view).length;
  const branched = !!view.meta.parentRevisionId;
  const proceeded = !!view.meta.proceeded;
  const taskCount = view.meta.tasks.length;
  const completed = view.meta.tasks.filter(
    (t) => t.status === "completed"
  ).length;

  const proceed = () => {
    // Don't send a chat prompt directly — that would inject a "Plan approved"
    // user bubble while leaving the agent stuck in plan mode (which can't
    // write). The extension shows a permission popup, switches mode, and
    // continues the same conversation in one motion.
    send({ type: "planProceedRequest", revisionId: view.meta.revisionId });
  };

  const openInEditor = () => {
    // Open as a real editor tab — the artifact view lives in the main
    // editor area, not inline in the chat. Matches the Antigravity feel
    // where the plan is a first-class document the user navigates.
    send({ type: "planOpenInEditor", revisionId: view.meta.revisionId });
  };

  const tasksProgress = taskCount > 0 ? completed / taskCount : null;
  const revisionLabel =
    ordinal > 1 ? `Updated · v${ordinal}` : branched ? "Updated" : null;

  return (
    <motion.div
      {...ENTER_CARD}
      className={[s.card, !isLatest ? s.locked : "", branched ? s.branched : ""]
        .filter(Boolean)
        .join(" ")}
    >
      <div className={s.head}>
        <span className={s.icon} aria-hidden>
          <Icon name="layers" size={14} />
        </span>
        <div className={s.titleblock}>
          <span className={s.title}>{summary.title}</span>
          {revisionLabel && (
            <Tooltip
              label={
                branched
                  ? "This plan was revised after a rewind."
                  : "This plan has been updated."
              }
            >
              <span className={s.revtag}>
                <Icon name="refresh" size={9} />
                {revisionLabel}
              </span>
            </Tooltip>
          )}
        </div>
        <span className={s.chips}>
          {proceeded && (
            // Flips the moment the user approves, on a card that is already
            // sitting in the transcript — so it arrives on its own.
            <motion.span className={s.chipEnter} {...ENTER}>
              <Tooltip label="Plan locked. Rewind to this revision's checkpoint to edit.">
                <Chip tone="info">proceeded</Chip>
              </Tooltip>
            </motion.span>
          )}
          {!isLatest && <Chip tone="default">superseded</Chip>}
        </span>
      </div>

      {summary.preview && <p className={s.preview}>{summary.preview}</p>}

      {/* The task list arrives on a later revision event than the plan body,
          and the stat row tracks comments the user is still writing — both
          open and close under a card that never unmounts, so both need the
          presence wrapper to get an exit at all. `initial={false}` keeps them
          from re-playing when the card mounts with them already there. */}
      <AnimatePresence initial={false}>
        {tasksProgress !== null && (
          <motion.div key="progress" className={s.progress} {...EXPAND}>
            <div className={s.progressLabel}>
              <span>
                Tasks {completed}/{taskCount}
              </span>
            </div>
            <div className={s.progressBar}>
              <div
                className={s.progressFill}
                style={{ width: `${Math.round(tasksProgress * 100)}%` }}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {(pending > 0 || view.questions.length > view.answers.length) && (
          <motion.div key="meta" className={s.meta} {...EXPAND}>
            {pending > 0 && (
              <span className={`${s.stat} ${s.statWarn}`}>
                <Icon name="at" size={10} />
                {pending} unresolved comment{pending !== 1 ? "s" : ""}
              </span>
            )}
            {view.questions.length > view.answers.length && (
              <span className={`${s.stat} ${s.statAccent}`}>
                <Icon name="bolt" size={10} />
                needs answer
              </span>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <div className={s.actions}>
        {/* The label only applies once the plan is proceeded — `disabled`
            suppresses it the rest of the time rather than swapping the
            element, which would remount the button mid-hover. */}
        <Tooltip
          label="Plan locked. Rewind to this revision's checkpoint to edit."
          disabled={!proceeded}
        >
          <button
            type="button"
            className={`${btn.btn} ${btn.success}`}
            onClick={proceed}
            disabled={!isLatest || proceeded}
          >
            <Icon name="check" size={11} />
            Proceed
          </button>
        </Tooltip>
        <button
          type="button"
          className={`${btn.btn} ${btn.ghost}`}
          onClick={openInEditor}
        >
          <Icon name="arrow" size={11} />
          Open in editor
        </button>
      </div>
    </motion.div>
  );
}
