// ─────────────────────────────────────────────────────────────
// Subagent folding — the two `subagent` timeline events each
// dispatched agent produces, collapsed into one card's worth of
// state.
//
// Pure and separate from ChatScreen so it can be tested without a
// renderer, the same way plan state and file edits are.
// ─────────────────────────────────────────────────────────────

import type {
  SubagentTaskView,
  TimelineEvent,
  WorkflowProgressEntry
} from "../../lib/rpc";

/**
 * Tool names whose call registers a background task, and so renders as a card
 * rather than as a tool chip.
 *
 * `Agent` is what 2.1.220 actually sends for a dispatch; `Task` is the older
 * name and still turns up in stored sessions. `Workflow` belongs here for the
 * same reason both of those do — it returns `async_launched` and the run it
 * started is reported through `task_*` — and without it a workflow rendered
 * twice: once as a chip saying "Ran 1 tool", once as the card beside it.
 */
export const TASK_TOOL_NAMES = new Set(["Agent", "Task", "Workflow"]);

export interface FoldedSubagents {
  /** taskId → everything the timeline knows about that agent. */
  byTaskId: Map<string, SubagentTaskView>;
  /** `Agent` tool_use id → taskId. The dispatch arrives as an ordinary
   *  tool_call before the task events do; this is what lets it be replaced by
   *  the card rather than rendered as a second, emptier chip beside it. */
  taskIdByToolUse: Map<string, string>;
  /** taskId → ms between the card opening and closing, for runs the CLI put no
   *  duration on. Measured off our own timestamps, so it is only a fallback. */
  elapsed: Map<string, number>;
}

/**
 * Collapse every `subagent` event in a timeline into one view per agent.
 *
 * A plain spread merge is enough: both events cross `postMessage` (or a JSON
 * file, for a stored session), and neither carries a key it has no value for —
 * so a later phase can add to the card but never blank it.
 */
export function foldSubagents(events: TimelineEvent[]): FoldedSubagents {
  const byTaskId = new Map<string, SubagentTaskView>();
  const taskIdByToolUse = new Map<string, string>();
  const elapsed = new Map<string, number>();
  const openedAt = new Map<string, number>();

  for (const e of events) {
    if (e.kind !== "subagent") continue;
    const meta = e.meta as (SubagentTaskView & { phase?: string }) | undefined;
    if (!meta?.taskId) continue;

    const merged = { ...byTaskId.get(meta.taskId), ...meta };
    byTaskId.set(meta.taskId, merged);
    if (merged.toolUseId) taskIdByToolUse.set(merged.toolUseId, meta.taskId);

    if (meta.phase === "start") {
      openedAt.set(meta.taskId, e.ts);
    } else if (meta.phase === "end") {
      const opened = openedAt.get(meta.taskId);
      if (opened !== undefined) elapsed.set(meta.taskId, e.ts - opened);
    }
  }
  return { byTaskId, taskIdByToolUse, elapsed };
}

/**
 * Where agents that named no phase are collected.
 *
 * Sorts last rather than first: the group renders without a heading (there is
 * no title to draw), and at index -1 that headless list appeared *above* the
 * workflow's real phases, reading as an unlabelled first phase.
 */
const ORPHAN_PHASE_INDEX = Number.MAX_SAFE_INTEGER;

/** One phase of a workflow with the agents the CLI reported under it. */
export interface WorkflowPhaseGroup {
  /** Phase index as the CLI numbered it, or {@link ORPHAN_PHASE_INDEX} for
   *  agents that named no phase. */
  index: number;
  title: string;
  agents: WorkflowProgressEntry[];
}

/**
 * Fold `workflow_progress` into the phases it describes.
 *
 * The CLI sends phases and agents interleaved in one array, related by
 * `phaseIndex`, and re-sends the whole array each time anything moves. Grouping
 * is therefore done on read rather than accumulated.
 *
 * An agent whose phase was never announced still gets a group — built from its
 * own `phaseTitle`, or untitled. Dropping it would hide a running agent because
 * of a missing heading, which is the opposite of what this view is for.
 */
export function groupWorkflowProgress(
  entries: WorkflowProgressEntry[] | undefined
): WorkflowPhaseGroup[] {
  if (!entries?.length) return [];
  const groups = new Map<number, WorkflowPhaseGroup>();

  const groupFor = (index: number, title: string) => {
    const existing = groups.get(index);
    if (existing) {
      if (!existing.title && title) existing.title = title;
      return existing;
    }
    const created = { index, title, agents: [] };
    groups.set(index, created);
    return created;
  };

  for (const e of entries) {
    if (e.type === "workflow_phase") {
      groupFor(e.index ?? ORPHAN_PHASE_INDEX, e.title ?? "");
    }
  }
  for (const e of entries) {
    if (e.type !== "workflow_agent") continue;
    groupFor(
      e.phaseIndex ?? ORPHAN_PHASE_INDEX,
      e.phaseTitle ?? ""
    ).agents.push(e);
  }

  return [...groups.values()].sort((a, b) => a.index - b.index);
}

/** How a card or an agent row reads: what the reported word actually means. */
export type SubagentOutcome = "running" | "failed" | "interrupted" | "done";

const RUNNING_WORDS = new Set(["running", "start", "queued"]);
/** Stopped by something going wrong. `cancelled` has always been counted here
 *  rather than as an interruption; unifying the two vocabularies was not the
 *  moment to quietly re-colour it. */
const FAILED_WORDS = new Set(["failed", "error", "cancelled", "canceled"]);
/** Stopped by something outside it, with nothing having gone wrong. */
const INTERRUPTED_WORDS = new Set([
  "interrupted",
  "stopped",
  "killed",
  "skipped"
]);

/**
 * Map a CLI status word onto what the UI shows.
 *
 * **One function on purpose.** A task's `status` and a workflow agent's `state`
 * are two vocabularies from the same CLI describing the same four outcomes, and
 * keeping a predicate per call site is precisely how this went wrong twice: a
 * card drew a green tick on an agent whose process had been killed (`stopped`),
 * and a workflow row drew one on an agent that had errored while spinning
 * forever on one that had merely failed. Both are the same missing branch.
 *
 * Vocabulary read off the shipped 2.1.220 binary around `workflow_agent`:
 * `start`, `running`, `done`, `completed`, `error`, `failed`, `killed`,
 * `skipped` — plus what the host already treats as terminal for a task.
 *
 * Anything unrecognised reads as `done`: a word we have not seen is not
 * evidence of failure, and a row that spins forever claims work nothing is
 * doing. Neither is true, and the tick is the cheaper lie to correct.
 */
export function subagentOutcome(word: string | undefined): SubagentOutcome {
  if (!word || RUNNING_WORDS.has(word)) return "running";
  if (FAILED_WORDS.has(word)) return "failed";
  if (INTERRUPTED_WORDS.has(word)) return "interrupted";
  return "done";
}

/** The same mapping for one row of a workflow's progress. */
export function workflowAgentOutcome(
  entry: WorkflowProgressEntry
): SubagentOutcome {
  return subagentOutcome(entry.state);
}

export interface LiveAgents {
  /** How many dispatched agents have not reported a terminal status. */
  count: number;
  /** The longest one's elapsed time, or 0 where none has reported any. */
  longestMs: number;
}

/**
 * What is still running, for the surfaces that have to warn before ending it.
 *
 * Stop, rewind and edit each destroy background work as a side effect of doing
 * something else — measured, an `interrupt` stops a running agent 10ms after
 * the request, and rewind takes the whole process with it. A warning is only
 * worth reading if it says how much: "4 agents, 38 minutes" is a decision, "you
 * have background work" is a shrug.
 */
export function liveAgents(
  progress: Record<string, SubagentTaskView>
): LiveAgents {
  let count = 0;
  let longestMs = 0;
  for (const task of Object.values(progress)) {
    const units = runningUnits(task);
    if (units === 0) continue;
    count += units;
    longestMs = Math.max(longestMs, task.durationMs ?? 0);
  }
  return { count, longestMs };
}

/**
 * How much of one task is still alive, counted in agents rather than launches.
 *
 * The single definition behind both the stop confirmation and the panel — they
 * used to disagree, and the disagreement was visible one click apart: a
 * workflow with two running agents read "2 running" on one surface and "1 agent
 * still working" on the other. The warning was the one understating it, on the
 * only path that destroys work.
 *
 * **Floored at one while the task is live.** A workflow between phases has
 * dispatched nobody at this instant; counted honestly as zero it would darken
 * the toolbar button mid-run and, far worse, take the confirmation off Stop
 * entirely — the interrupt would go through silently and take the workflow with
 * it.
 */
export function runningUnits(task: SubagentTaskView): number {
  if (subagentOutcome(task.status) !== "running") return 0;
  const agents = (task.workflowProgress ?? []).filter(
    (e) => e.type === "workflow_agent"
  );
  if (agents.length === 0) return 1;
  const live = agents.filter(
    (a) => workflowAgentOutcome(a) === "running"
  ).length;
  return Math.max(live, 1);
}

/**
 * Everything the conversation knows about its background work: live detail
 * layered over what the timeline remembers.
 *
 * Both are needed and neither is enough. `taskProgress` holds only what is
 * *running* — the host deletes a task from it the moment the closing row lands,
 * and `turnEnd` sweeps whatever is left — so a panel reading it alone would go
 * blank the instant an audit finished, which is when its cost is most worth
 * seeing. The timeline keeps every agent that ever ran, and survives a reload,
 * but stops moving once the card closes.
 */
export function mergeTaskState(
  history: Map<string, SubagentTaskView>,
  live: Record<string, SubagentTaskView>
): Record<string, SubagentTaskView> {
  const merged: Record<string, SubagentTaskView> = {};
  for (const [taskId, task] of history) merged[taskId] = task;
  for (const [taskId, task] of Object.entries(live)) {
    merged[taskId] = { ...merged[taskId], ...task };
  }
  return merged;
}

/** One background launch as the panel lists it: a workflow with its phases, or
 *  a single dispatched agent. */
export interface AgentRun {
  taskId: string;
  kind: "workflow" | "agent";
  /** The workflow's script name, or the agent's type. */
  name: string;
  description?: string;
  outcome: SubagentOutcome;
  /** Empty for a single agent, and for a workflow whose breakdown never
   *  arrived. */
  phases: WorkflowPhaseGroup[];
  /** A workflow restored from storage: `workflow_progress` rides the live path
   *  only, so its agents are *unknown*, not absent. A row that says so beats a
   *  phase list that renders empty and reads as "zero agents". */
  detailsUnavailable: boolean;
  running: number;
  done: number;
  total: number;
  tokens: number;
  toolCalls: number;
  durationMs?: number;
  etaMs?: number;
  /** Finished agents the estimate was drawn from. Shown in its tooltip: a
   *  number offered without its sample is a number nobody can weigh. */
  etaSample?: number;
}

export interface AgentPanel {
  /**
   * Work still alive, in agents — {@link runningUnits} summed, so a live
   * workflow between phases still counts for one. Deliberately not the sum of
   * `run.running`: a row reports its own agents, and this reports whether
   * anything is happening at all.
   */
  running: number;
  runs: AgentRun[];
  done: number;
  total: number;
  tokens: number;
  elapsedMs: number;
  etaMs?: number;
  etaSample?: number;
}

/** Finished agents an estimate needs before it means anything. Two samples out
 *  of a fleet of twelve is not a pace, it is a coincidence. */
const ETA_MIN_SAMPLE = 3;

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * The largest number of this run's agents that overlapped at any one moment.
 *
 * Reconstructed from their own intervals because the CLI states its concurrency
 * cap nowhere. An agent that has not finished has no end, and is given none —
 * reading the clock here would put `Date.now()` in a render and answer the same
 * question, since every unfinished agent is by definition still live at this
 * instant. Floored at 1: an older CLI sends no `startedAt` at all, and a zero
 * here would divide.
 */
function observedConcurrency(agents: WorkflowProgressEntry[]): number {
  const edges: Array<{ at: number; delta: number }> = [];
  for (const a of agents) {
    if (a.startedAt === undefined) continue;
    const ended =
      a.durationMs !== undefined ? a.startedAt + a.durationMs : Infinity;
    edges.push({ at: a.startedAt, delta: 1 });
    edges.push({ at: ended, delta: -1 });
  }
  // Ends before starts at an equal timestamp, so two agents that merely touch
  // are not counted as having run together.
  edges.sort((x, y) => x.at - y.at || x.delta - y.delta);

  let live = 0;
  let peak = 0;
  for (const e of edges) {
    live += e.delta;
    peak = Math.max(peak, live);
  }
  return Math.max(peak, 1);
}

function runEta(
  agents: WorkflowProgressEntry[],
  done: number,
  total: number
): { ms: number; sample: number } | undefined {
  const samples = agents
    .filter(
      (a) => workflowAgentOutcome(a) !== "running" && a.durationMs !== undefined
    )
    .map((a) => a.durationMs as number);
  const remaining = total - done;
  if (samples.length < ETA_MIN_SAMPLE || remaining <= 0) return undefined;
  return {
    ms: medianOf(samples) * Math.ceil(remaining / observedConcurrency(agents)),
    sample: samples.length
  };
}

/**
 * Everything the background-agents panel shows, folded out of the live task
 * state the chat already holds.
 *
 * Three rules here are measured rather than chosen, and each one is the
 * opposite of the obvious version — see `docs/WORKFLOW-AGENTS-PANEL.md` for the
 * capture they came from:
 *
 * - **Progress counts agents, not launches.** A workflow of fourteen and a lone
 *   `Explore` must not weigh the same in one bar.
 * - **Tokens come from the task, never from summing its agents.** The two are
 *   the same number, so adding them double-counts — and a running agent carries
 *   no `tokens` field at all, so the sum reads zero for exactly as long as
 *   anyone is watching.
 * - **Elapsed is the CLI's own `durationMs`**, which moves between events. No
 *   local start timestamp is invented.
 *
 * Reads no clock at all, which is what lets a component call it during render:
 * `react-hooks/purity` fails the build on a `Date.now()` in a `useMemo`, and
 * nothing here needed one.
 */
export function agentPanel(
  progress: Record<string, SubagentTaskView>
): AgentPanel {
  const runs: AgentRun[] = [];

  for (const task of Object.values(progress)) {
    const outcome = subagentOutcome(task.status);
    const live = outcome === "running";
    const isWorkflow = task.taskType === "local_workflow";
    const phases = groupWorkflowProgress(task.workflowProgress);
    const agents = phases.flatMap((p) => p.agents);

    let total = 1;
    let done = live ? 0 : 1;
    if (agents.length > 0) {
      total = agents.length;
      done = agents.filter((a) => workflowAgentOutcome(a) !== "running").length;
      // A run the CLI has closed leaves nothing running, whatever its last rows
      // still say: `workflow_progress` can stop arriving before an agent's own
      // terminal state does, and one row stuck at `start` would keep the
      // toolbar button lit for the rest of the conversation.
      if (!live) done = total;
    }

    const eta =
      live && agents.length > 0 ? runEta(agents, done, total) : undefined;

    runs.push({
      taskId: task.taskId,
      kind: isWorkflow ? "workflow" : "agent",
      name: isWorkflow
        ? (task.workflowName ?? "Workflow")
        : (task.subagentType ?? "Agent"),
      description: task.description,
      outcome,
      phases,
      detailsUnavailable: isWorkflow && agents.length === 0,
      running: total - done,
      done,
      total,
      tokens: task.totalTokens ?? 0,
      toolCalls: task.toolUses ?? 0,
      durationMs: task.durationMs,
      etaMs: eta?.ms,
      etaSample: eta?.sample
    });
  }

  // Running first, insertion order otherwise — `sort` is stable, and the order
  // tasks arrived in is the order their cards sit in the timeline. Keyed on the
  // run's own outcome rather than on its agent count, so a workflow between
  // phases does not sink below the finished ones while it is still working.
  runs.sort(
    (a, b) => Number(b.outcome === "running") - Number(a.outcome === "running")
  );

  let running = 0;
  let done = 0;
  let total = 0;
  let tokens = 0;
  let elapsedMs = 0;
  let etaMs: number | undefined;
  let etaSample: number | undefined;
  for (const task of Object.values(progress)) running += runningUnits(task);
  for (const run of runs) {
    done += run.done;
    total += run.total;
    tokens += run.tokens;
    elapsedMs = Math.max(elapsedMs, run.durationMs ?? 0);
    // The latest finish among what is still going: the question the header
    // answers is when *everything* is done, not when the next thing is. The
    // sample travels with it, because it describes that estimate and no other.
    if (run.etaMs !== undefined && run.etaMs > (etaMs ?? -1)) {
      etaMs = run.etaMs;
      etaSample = run.etaSample;
    }
  }

  return { runs, running, done, total, tokens, elapsedMs, etaMs, etaSample };
}
