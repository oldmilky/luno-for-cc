import { describe, it, expect } from "vitest";
import {
  foldSubagents,
  groupWorkflowProgress,
  isWorkflowAgentDone,
  TASK_TOOL_NAMES
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
    expect(TASK_TOOL_NAMES.has("Agent")).toBe(true);
    expect(TASK_TOOL_NAMES.has("Task")).toBe(true);
    expect(TASK_TOOL_NAMES.has("Read")).toBe(false);
  });

  // A `Workflow` call registers a background task exactly as a dispatch does,
  // so it owns the slot its chip would have taken. Left out, the chip and the
  // card both rendered for one launch.
  it("counts a workflow launch as a task the same way", () => {
    expect(TASK_TOOL_NAMES.has("Workflow")).toBe(true);
  });
});

// `workflow_progress` arrives as one flat array with phases and agents
// interleaved, re-sent in full each time anything moves. The card groups it on
// read rather than accumulating, so this is the whole contract.
describe("workflow progress", () => {
  const phase = (index: number, title: string) => ({
    type: "workflow_phase",
    index,
    title
  });
  const agent = (
    phaseIndex: number,
    label: string,
    state = "start",
    phaseTitle = ""
  ) => ({ type: "workflow_agent", phaseIndex, phaseTitle, label, state });

  it("has nothing to group when the CLI sent nothing", () => {
    expect(groupWorkflowProgress(undefined)).toEqual([]);
    expect(groupWorkflowProgress([])).toEqual([]);
  });

  it("puts each agent under the phase it names", () => {
    const groups = groupWorkflowProgress([
      phase(1, "Find"),
      phase(2, "Verify"),
      agent(1, "grep the logs"),
      agent(2, "refute it"),
      agent(1, "grep the tests")
    ]);

    expect(groups.map((g) => g.title)).toEqual(["Find", "Verify"]);
    expect(groups[0].agents.map((a) => a.label)).toEqual([
      "grep the logs",
      "grep the tests"
    ]);
    expect(groups[1].agents).toHaveLength(1);
  });

  it("orders phases by the index the CLI gave them, not by arrival", () => {
    const groups = groupWorkflowProgress([
      phase(3, "Third"),
      phase(1, "First"),
      phase(2, "Second")
    ]);

    expect(groups.map((g) => g.title)).toEqual(["First", "Second", "Third"]);
  });

  // A running agent must never be hidden because its phase heading has not
  // arrived: the whole point of this view is seeing what is in flight.
  it("keeps an agent whose phase was never announced", () => {
    const groups = groupWorkflowProgress([
      agent(4, "orphan work", "start", "Late phase")
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].title).toBe("Late phase");
    expect(groups[0].agents).toHaveLength(1);
  });

  it("groups agents that name no phase at all", () => {
    const groups = groupWorkflowProgress([
      { type: "workflow_agent", label: "loose" }
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].agents[0].label).toBe("loose");
  });

  // Unknown states read as still running, the same way an unknown task status
  // does — a spinner corrects itself, a premature tick does not.
  it("counts only the states that mean the agent stopped", () => {
    expect(isWorkflowAgentDone({ type: "workflow_agent", state: "done" })).toBe(
      true
    );
    expect(
      isWorkflowAgentDone({ type: "workflow_agent", state: "error" })
    ).toBe(true);
    expect(
      isWorkflowAgentDone({ type: "workflow_agent", state: "start" })
    ).toBe(false);
    expect(isWorkflowAgentDone({ type: "workflow_agent" })).toBe(false);
  });
});
