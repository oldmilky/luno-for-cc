// ─────────────────────────────────────────────────────────────
// SubagentCard — one agent the main model dispatched through its
// `Agent` tool. Header carries the agent type, what it was asked,
// live status and how long it ran; the body opens onto the full
// prompt and whatever the agent answered.
//
// The nested tool calls the subagent makes are deliberately not
// rendered: they arrive stamped with `parent_tool_use_id` and are
// dropped in the processor, so the only signal that a long run is
// alive is the count and last-tool name the CLI reports on
// `task_progress`. That is enough to tell working from wedged
// without a second timeline inside this one.
// ─────────────────────────────────────────────────────────────

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ENTER, EXPAND, DURATION, EASE_SOFT } from "../../design/motion";
import { Icon } from "../../design/icons";
import { MarkdownBody } from "./markdown";
import { formatDuration } from "./tool-buckets";
import { send } from "../../lib/rpc";
import type { SubagentTaskView } from "../../lib/rpc";
import { groupWorkflowProgress, isWorkflowAgentDone } from "./subagent-state";
import type { WorkflowPhaseGroup } from "./subagent-state";
import s from "./SubagentCard.module.scss";

interface SubagentCardProps {
  task: SubagentTaskView;
  /** Wall-clock across the card's own two timeline events. Used only when the
   *  CLI reported no duration of its own — a run it never closed has none. */
  fallbackMs?: number;
}

/** Statuses that mean the agent stopped without producing its answer. */
const FAILED = new Set(["failed", "error", "cancelled", "canceled"]);

export function SubagentCard({ task, fallbackMs }: SubagentCardProps) {
  const [open, setOpen] = useState(false);

  const running = !task.status || task.status === "running";
  const failed = FAILED.has(task.status ?? "");
  const interrupted = task.status === "interrupted";
  const ms = task.durationMs ?? fallbackMs;
  const body = task.summary?.trim();
  const outputFile = task.outputFile;
  // A workflow reaches this card through the same events an agent does and
  // means something different by half of them — see `SubagentTask.taskType`.
  const isWorkflow = task.taskType === "local_workflow";
  const phases = groupWorkflowProgress(task.workflowProgress);
  // An agent that died before saying anything has neither summary nor prompt,
  // and used to render as a red bar that refused to open — the one state where
  // the card had something to explain and no way to be asked.
  const canOpen =
    !!body || !!task.prompt || failed || interrupted || phases.length > 0;

  return (
    <motion.div
      {...ENTER}
      className={[
        s.card,
        running ? s.running : "",
        failed ? s.failed : "",
        interrupted ? s.interrupted : ""
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <button
        type="button"
        className={s.head}
        onClick={() => setOpen((o) => !o)}
        disabled={!canOpen}
      >
        <span className={s.icon} aria-hidden>
          <Icon name={isWorkflow ? "layers" : "branch"} size={12} />
        </span>
        <span className={s.name}>
          {isWorkflow
            ? (task.workflowName ?? "Workflow")
            : (task.subagentType ?? "Agent")}
        </span>
        <span className={s.desc}>{headline(task, running)}</span>
        <span className={s.meta}>
          {/* A workflow's `tool_uses` counts the orchestrator's own calls, which
              is 0 for a script that only dispatches. What it has instead of
              steps is agents, so that is what the header counts. */}
          {isWorkflow && agentCount(phases) > 0 && (
            <span className={s.count}>
              {agentCount(phases)}{" "}
              {agentCount(phases) === 1 ? "agent" : "agents"}
            </span>
          )}
          {!isWorkflow && task.toolUses !== undefined && task.toolUses > 0 && (
            <span className={s.count}>
              {task.toolUses} {task.toolUses === 1 ? "step" : "steps"}
            </span>
          )}
          {ms !== undefined && (
            <span className={s.count}>{formatDuration(ms)}</span>
          )}
          {running && <span className={s.spinner} />}
          {!running && !failed && !interrupted && (
            <span className={s.ok}>
              <Icon name="check" size={11} />
            </span>
          )}
          {(failed || interrupted) && (
            <span className={s.err}>
              <Icon name="x" size={11} />
            </span>
          )}
        </span>
        {canOpen && (
          // Rotates rather than grows, so EXPAND's height+opacity preset cannot
          // be spread here — only its timing is shared.
          <motion.span
            className={s.chev}
            animate={{ rotate: open ? 90 : 0 }}
            transition={{ duration: DURATION.expand, ease: EASE_SOFT }}
          >
            <Icon name="chevronR" size={10} />
          </motion.span>
        )}
      </button>

      <AnimatePresence initial={false}>
        {open && canOpen && (
          <motion.div
            {...EXPAND}
            className={s.body}
            style={{ overflow: "hidden" }}
          >
            {(failed || interrupted) && (
              <div className={s.section}>
                <div className={s.sectionLabel}>Outcome</div>
                <div className={s.outcome}>
                  <span className={s.status}>{task.status}</span>
                  {outputFile && (
                    <button
                      type="button"
                      className={s.transcript}
                      onClick={() =>
                        send({ type: "openFile", path: outputFile })
                      }
                    >
                      Open transcript
                    </button>
                  )}
                </div>
              </div>
            )}
            {phases.length > 0 && (
              <div className={s.section}>
                <div className={s.sectionLabel}>Agents</div>
                <div className={s.phases}>
                  {phases.map((phase) => (
                    <div key={phase.index} className={s.phase}>
                      {phase.title && (
                        <div className={s.phaseTitle}>{phase.title}</div>
                      )}
                      {phase.agents.map((agent, i) => (
                        <div
                          key={agent.agentId ?? `${phase.index}-${i}`}
                          className={[
                            s.agent,
                            isWorkflowAgentDone(agent) ? s.agentDone : ""
                          ]
                            .filter(Boolean)
                            .join(" ")}
                        >
                          <span className={s.agentState} aria-hidden>
                            {isWorkflowAgentDone(agent) ? (
                              <Icon name="check" size={9} />
                            ) : (
                              <span className={s.agentSpinner} />
                            )}
                          </span>
                          <span className={s.agentLabel}>
                            {agent.label ?? agent.promptPreview ?? "Agent"}
                          </span>
                          {agent.durationMs !== undefined && (
                            <span className={s.agentMeta}>
                              {formatDuration(agent.durationMs)}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {task.prompt && (
              <div className={s.section}>
                <div className={s.sectionLabel}>
                  {isWorkflow ? "Script" : "Asked"}
                </div>
                <div className={isWorkflow ? s.script : s.prompt}>
                  {task.prompt}
                </div>
              </div>
            )}
            {body && (
              <div className={s.section}>
                <div className={s.sectionLabel}>
                  {failed ? "Failed with" : "Answered"}
                </div>
                <div className={`md ${s.answer}`}>
                  <MarkdownBody text={body} />
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/** How many agents the workflow has reported across all its phases. */
function agentCount(phases: WorkflowPhaseGroup[]): number {
  return phases.reduce((n, phase) => n + phase.agents.length, 0);
}

/**
 * The one line that says what this agent is doing, or was asked to do.
 *
 * A running agent shows its live activity in preference to the task label: a
 * card that reads "Grep · Searching for makeProcessor" is visibly alive, where
 * the label it was dispatched with looks identical whether the agent is working
 * or wedged. Once it stops, that text is stale and the label wins back.
 */
function headline(task: SubagentTaskView, running: boolean): string {
  if (running && task.activity) {
    return task.lastToolName
      ? `${task.lastToolName} · ${task.activity}`
      : task.activity;
  }
  return task.description ?? "";
}
