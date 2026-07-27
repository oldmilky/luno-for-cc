// ─────────────────────────────────────────────────────────────
// Subagent folding — the two `subagent` timeline events each
// dispatched agent produces, collapsed into one card's worth of
// state.
//
// Pure and separate from ChatScreen so it can be tested without a
// renderer, the same way plan state and file edits are.
// ─────────────────────────────────────────────────────────────

import type { SubagentTaskView, TimelineEvent } from "../../lib/rpc";

/** Tool names that dispatch a subagent. `Agent` is what 2.1.220 actually
 *  sends; `Task` is the older name and still turns up in stored sessions. */
export const AGENT_TOOL_NAMES = new Set(["Agent", "Task"]);

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
