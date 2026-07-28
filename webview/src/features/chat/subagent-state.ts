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

/** One phase of a workflow with the agents the CLI reported under it. */
export interface WorkflowPhaseGroup {
  /** Phase index as the CLI numbered it, or -1 for agents that named no phase. */
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
    if (e.type === "workflow_phase") groupFor(e.index ?? -1, e.title ?? "");
  }
  for (const e of entries) {
    if (e.type !== "workflow_agent") continue;
    groupFor(e.phaseIndex ?? -1, e.phaseTitle ?? "").agents.push(e);
  }

  return [...groups.values()].sort((a, b) => a.index - b.index);
}

/** Whether this workflow agent has stopped. Anything unrecognised reads as
 *  still running, the same way an unknown task status does. */
export function isWorkflowAgentDone(entry: WorkflowProgressEntry): boolean {
  return entry.state === "done" || entry.state === "error";
}
