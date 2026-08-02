// ─────────────────────────────────────────────────────────────
// Background agents — the panel the CLI tells people to run
// `/workflows` for, in a client that has no slash commands.
//
// Every number here comes from `agentPanel()`; none is computed
// again in the view. The three that look wrong at first glance —
// progress counted in agents, tokens read off the task rather
// than summed from its agents, elapsed taken from the CLI's own
// `durationMs` — are measured rules, and
// `docs/WORKFLOW-AGENTS-PANEL.md` holds the capture behind each.
// ─────────────────────────────────────────────────────────────

import { useEffect, useId, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Icon } from "../../design/icons";
import { Tooltip } from "../../design/primitives";
import { BACKDROP, OVERLAY_PANEL } from "../../design/motion";
import { formatDuration, formatTokens } from "./tool-buckets";
import { workflowAgentOutcome } from "./subagent-state";
import type { AgentPanel, AgentRun } from "./subagent-state";
import type { WorkflowProgressEntry } from "../../lib/rpc";
import s from "./BackgroundAgentsModal.module.scss";

interface BackgroundAgentsModalProps {
  panel: AgentPanel;
  onClose: () => void;
  /** Hands the decision to the existing stop confirmation — there is no way to
   *  stop one agent, so this is the only control the CLI's vocabulary allows. */
  onStopAll: () => void;
}

/**
 * A second-hand, alive only while this panel is open and something is running.
 *
 * The one number on this surface the CLI does not report: an agent that has not
 * finished has no `durationMs`, so how long it has been going is `now` minus
 * its own `startedAt`. Everything else here is the CLI's own figure and needs
 * no clock — which is why the tick lives in the view and not in `agentPanel`.
 */
function useSecondHand(live: boolean): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!live) return;
    const tick = () => setNow(Date.now());
    // The first reading is deferred by a task rather than taken in the effect
    // body: a synchronous `setState` there is a second render on mount, which
    // `react-hooks/set-state-in-effect` flags and which buys nothing — the
    // elapsed time lands within the same frame either way.
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [live]);
  return now;
}

export function BackgroundAgentsModal({
  panel,
  onClose,
  onStopAll
}: BackgroundAgentsModalProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Keyboard focus follows the dialog in, and goes back where it came from on
  // the way out — otherwise Tab resumes from the composer behind the scrim.
  useEffect(() => {
    const returnTo = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => returnTo?.focus?.();
  }, []);

  const live = panel.running > 0;
  const pct = panel.total > 0 ? (panel.done / panel.total) * 100 : 0;
  const now = useSecondHand(live);

  return (
    <motion.div className={s.backdrop} onClick={onClose} {...BACKDROP}>
      <motion.div
        ref={panelRef}
        className={s.panel}
        onClick={(e) => e.stopPropagation()}
        // The dialog is the panel, not the scrim around it, and its name is the
        // heading it already draws — a second `aria-label` here would give the
        // toolbar button and this surface the same accessible name.
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        {...OVERLAY_PANEL}
      >
        <div className={s.hairline} />

        <div className={s.head}>
          <div className={s.headRow}>
            <div className={`${s.iconTile}${live ? ` ${s.iconTileLive}` : ""}`}>
              <Icon name="layers" size={20} />
            </div>
            <div className={s.headText}>
              <h2 className={s.title} id={titleId}>
                Background agents
              </h2>
              {/* Never "N of M still working": the two numbers answer
                  different questions — how much is alive, and how many agents
                  have answered — and a workflow between phases makes them
                  disagree. The bar below carries the total. */}
              <p className={s.sub}>
                {live
                  ? `${panel.running} still working`
                  : `${panel.total} agent${panel.total === 1 ? "" : "s"} · all finished`}
              </p>
            </div>
            <div className={s.stats}>
              <Tooltip label="What these agents have spent, as the CLI reports it">
                <span className={s.stat}>{formatTokens(panel.tokens)}</span>
              </Tooltip>
              <span className={s.statDot} aria-hidden>
                ·
              </span>
              <Tooltip label="The longest launch's own elapsed time">
                <span className={s.stat}>
                  {formatDuration(panel.elapsedMs)}
                </span>
              </Tooltip>
              {panel.etaMs !== undefined && (
                <>
                  <span className={s.statDot} aria-hidden>
                    ·
                  </span>
                  <Tooltip
                    label={`A guess, from the ${panel.etaSample} agents that have already finished`}
                  >
                    <span className={`${s.stat} ${s.eta}`}>
                      ≈{formatDuration(panel.etaMs)}
                    </span>
                  </Tooltip>
                </>
              )}
            </div>
          </div>

          <div className={s.barRow}>
            <div
              className={s.bar}
              role="progressbar"
              aria-valuenow={panel.done}
              aria-valuemin={0}
              aria-valuemax={panel.total}
              aria-label="Agents finished"
            >
              <div className={s.fill} style={{ width: `${pct}%` }} />
            </div>
            <span className={s.barLabel}>
              {panel.done} / {panel.total} done
            </span>
          </div>
        </div>

        <div className={s.body}>
          {panel.runs.map((run) => (
            <RunBlock key={run.taskId} run={run} now={now} />
          ))}
        </div>

        <div className={s.foot}>
          <div className={s.escHint}>
            <kbd className={s.kbd}>Esc</kbd>
            <span>to close</span>
          </div>
          {/* Only while there is something to stop, and it asks rather than
              acts: stopping reaches the CLI as an `interrupt`, which takes
              every agent at once. The confirmation that already exists names
              what is about to be lost. */}
          {live && (
            <button type="button" className={s.stopAll} onClick={onStopAll}>
              <Icon name="stop" size={10} />
              Stop all
            </button>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

/** One launch: a workflow with its phases under it, or a lone agent. */
function RunBlock({ run, now }: { run: AgentRun; now: number }) {
  const running = run.outcome === "running";
  return (
    <div className={s.run}>
      <div className={s.runHead}>
        <span className={s.runIcon} aria-hidden>
          <Icon
            name={run.kind === "workflow" ? "layers" : "branch"}
            size={12}
          />
        </span>
        <span className={s.runName}>{run.name}</span>
        {run.description && (
          <span className={s.runDesc}>{run.description}</span>
        )}
        <span className={s.runMeta}>
          {/* Only a workflow counts agents — a lone one is its own row, and
              "1 running · 0 done" beside its name says nothing twice. */}
          {run.kind === "workflow" && (
            <span>{workflowCount(run, running)}</span>
          )}
          <span>{formatTokens(run.tokens)}</span>
          {run.durationMs !== undefined && (
            <span>{formatDuration(run.durationMs)}</span>
          )}
          <StateMark outcome={run.outcome} />
        </span>
      </div>

      {/* Says the breakdown is missing, never why. A workflow that ended
          before its first `task_progress`, one from a session saved before the
          field existed, one swept as interrupted — all land here, and an empty
          phase list would read as "this workflow dispatched nobody" for every
          one of them. */}
      {run.detailsUnavailable && (
        <div className={s.note}>
          {running ? "agents not reported yet" : "no agent breakdown reported"}
        </div>
      )}

      {run.phases.map((phase) => (
        <div key={phase.index} className={s.phase}>
          {phase.title && <div className={s.phaseTitle}>{phase.title}</div>}
          {phase.agents.map((agent, i) => (
            <AgentRow
              // The CLI resends the whole array on every move, so a row has to
              // be keyed by the agent's own identity. A position key relabels a
              // row in place when two agents in a phase swap order.
              key={
                agent.agentId ??
                (agent.index !== undefined
                  ? `i${agent.index}`
                  : `${phase.index}-${i}`)
              }
              agent={agent}
              now={now}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function AgentRow({
  agent,
  now
}: {
  agent: WorkflowProgressEntry;
  now: number;
}) {
  const outcome = workflowAgentOutcome(agent);
  const running = outcome === "running";
  // A finished agent carries its own measured duration; a running one carries
  // only when it began, and `now` is zero until the tick starts.
  const elapsed =
    agent.durationMs ??
    (running && agent.startedAt !== undefined && now > 0
      ? Math.max(0, now - agent.startedAt)
      : undefined);

  return (
    <div className={`${s.agent}${running ? "" : ` ${s.agentDone}`}`}>
      <StateMark outcome={outcome} small />
      <span className={s.agentLabel}>
        {agent.label ?? agent.promptPreview ?? "Agent"}
      </span>
      <span className={s.agentMeta}>
        {agent.tokens !== undefined && (
          <span>{formatTokens(agent.tokens)}</span>
        )}
        {agent.toolCalls !== undefined && agent.toolCalls > 0 && (
          <span>
            {agent.toolCalls} {agent.toolCalls === 1 ? "tool" : "tools"}
          </span>
        )}
        {elapsed !== undefined && <span>{formatDuration(elapsed)}</span>}
      </span>
    </div>
  );
}

/**
 * What a workflow's row says about its agents.
 *
 * A live workflow with nothing running is a real state, not a contradiction —
 * it is between phases, and the next one has not been dispatched. Saying
 * "0 running" beside a spinner reads as a bug; the agents that have answered
 * are what there is to report.
 */
function workflowCount(run: AgentRun, running: boolean): string {
  if (!running) return `${run.total} ${run.total === 1 ? "agent" : "agents"}`;
  if (run.running === 0) return `${run.done} done · starting more`;
  return `${run.running} running · ${run.done} done`;
}

/** The same four outcomes everywhere on this surface, drawn one way. */
function StateMark({
  outcome,
  small = false
}: {
  outcome: ReturnType<typeof workflowAgentOutcome>;
  small?: boolean;
}) {
  const size = small ? 9 : 11;
  return (
    <span
      className={[
        s.mark,
        outcome === "failed" ? s.markFailed : "",
        outcome === "interrupted" ? s.markInterrupted : ""
      ]
        .filter(Boolean)
        .join(" ")}
      aria-hidden
    >
      {outcome === "running" && <span className={s.spinner} />}
      {outcome === "done" && <Icon name="check" size={size} />}
      {(outcome === "failed" || outcome === "interrupted") && (
        <Icon name="x" size={size} />
      )}
    </span>
  );
}
