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
    if (subagentOutcome(task.status) !== "running") continue;
    count += 1;
    longestMs = Math.max(longestMs, task.durationMs ?? 0);
  }
  return { count, longestMs };
}
