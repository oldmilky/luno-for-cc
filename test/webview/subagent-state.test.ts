import { describe, it, expect } from "vitest";
import {
  foldSubagents,
  AGENT_TOOL_NAMES
} from "../../webview/src/features/chat/subagent-state";
import type { TimelineEvent } from "../../webview/src/lib/rpc";

// The chat sees a subagent as two rows: one when it is dispatched, one when it
// answers. The card is a fold of the pair, and the fold has to hold two things
// the host cannot: the dispatch's `tool_use_id`, which is what ties the card to
// the tool call it replaces, and the task label, which the closing row must not
// be allowed to overwrite with whatever the agent was doing at the end.

const TASK = "ad0748687a4aac2a8";
const PARENT = "toolu_01VHk67cxKJ2HnTpAptXs4Xk";

function evt(
  ts: number,
  meta: Record<string, unknown>,
  kind = "subagent"
): TimelineEvent {
  return { id: `e-${ts}`, ts, kind, title: "Agent: Explore", meta };
}

const start = evt(1_000, {
  phase: "start",
  taskId: TASK,
  toolUseId: PARENT,
  subagentType: "Explore",
  description: "Find makeProcessor definition",
  prompt: "Search under src.",
  status: "running"
});

const end = evt(14_400, {
  phase: "end",
  taskId: TASK,
  toolUseId: PARENT,
  subagentType: "Explore",
  description: "Find makeProcessor definition",
  status: "completed",
  summary: "src/providers/claude-cli.ts",
  toolUses: 1,
  durationMs: 13_400
});

describe("foldSubagents", () => {
  it("folds the dispatch and the answer into one card", () => {
    const { byTaskId } = foldSubagents([start, end]);

    expect(byTaskId.size).toBe(1);
    expect(byTaskId.get(TASK)).toMatchObject({
      taskId: TASK,
      subagentType: "Explore",
      status: "completed",
      summary: "src/providers/claude-cli.ts",
      // Carried forward from the dispatch — the closing row is not the only
      // source of truth for the card.
      prompt: "Search under src.",
      description: "Find makeProcessor definition"
    });
  });

  // The card takes the slot of the `Agent` tool call that dispatched it, and
  // that call lands on the timeline first. Without this index the chip and the
  // card would both render, the chip saying nothing useful.
  it("indexes the card by the tool call it replaces", () => {
    const { taskIdByToolUse } = foldSubagents([start, end]);

    expect(taskIdByToolUse.get(PARENT)).toBe(TASK);
  });

  // `task_updated` carries no tool_use_id, so a card whose closing row is the
  // only one present still has to be findable — just not by tool call.
  it("still folds a card whose dispatch row is missing", () => {
    const { byTaskId, taskIdByToolUse } = foldSubagents([
      evt(2_000, { phase: "end", taskId: TASK, status: "failed" })
    ]);

    expect(byTaskId.get(TASK)).toMatchObject({ status: "failed" });
    // Nothing to index it by, so ChatScreen places this one off the timeline
    // row itself rather than off the tool call.
    expect(taskIdByToolUse.size).toBe(0);
  });

  it("measures elapsed time across the pair for a run the CLI never timed", () => {
    const untimed = evt(9_000, {
      phase: "end",
      taskId: TASK,
      status: "interrupted"
    });
    const { elapsed } = foldSubagents([start, untimed]);

    expect(elapsed.get(TASK)).toBe(8_000);
  });

  it("has no elapsed time for a card that never closed", () => {
    expect(foldSubagents([start]).elapsed.has(TASK)).toBe(false);
  });

  it("keeps two agents apart", () => {
    const other = evt(1_200, {
      phase: "start",
      taskId: "second",
      toolUseId: "toolu_second",
      subagentType: "general-purpose"
    });
    const { byTaskId, taskIdByToolUse } = foldSubagents([start, other, end]);

    expect([...byTaskId.keys()]).toEqual([TASK, "second"]);
    expect(byTaskId.get("second")).toMatchObject({
      subagentType: "general-purpose"
    });
    expect(taskIdByToolUse.get("toolu_second")).toBe("second");
  });

  it("ignores rows that are not subagents, and subagent rows with no id", () => {
    const noise = [
      evt(500, { id: "toolu_x", name: "Read" }, "tool_call"),
      evt(600, { phase: "start", subagentType: "Explore" }),
      start
    ];

    expect([...foldSubagents(noise).byTaskId.keys()]).toEqual([TASK]);
  });

  // 2.1.220 sends `Agent`. `Task` is what older sessions on disk still say, and
  // those have to keep rendering as cards rather than reverting to tool chips.
  it("knows both names the dispatching tool has had", () => {
    expect(AGENT_TOOL_NAMES.has("Agent")).toBe(true);
    expect(AGENT_TOOL_NAMES.has("Task")).toBe(true);
    expect(AGENT_TOOL_NAMES.has("Read")).toBe(false);
  });
});
