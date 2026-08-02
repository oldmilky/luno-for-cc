import { describe, it, expect } from "vitest";
import {
  foldSubagents,
  groupWorkflowProgress,
  workflowAgentOutcome,
  subagentOutcome,
  liveAgents,
  agentPanel,
  mergeTaskState,
  runningUnits,
  TASK_TOOL_NAMES
} from "../../webview/src/features/chat/subagent-state";
import type {
  TimelineEvent,
  WorkflowProgressEntry
} from "../../webview/src/lib/rpc";

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

  // An agent with no phase must sort *after* the real ones. Its group renders
  // without a heading, and at the front that headless list read as an
  // unlabelled first phase sitting above the workflow's actual work.
  it("puts agents that named no phase last, not first", () => {
    const groups = groupWorkflowProgress([
      phase(1, "Find"),
      phase(2, "Verify"),
      { type: "workflow_agent", label: "loose" },
      agent(1, "grep the logs")
    ]);

    expect(groups.map((g) => g.title)).toEqual(["Find", "Verify", ""]);
    expect(groups[2].agents[0].label).toBe("loose");
  });

  // The row's outcome comes from the same mapping the card uses. A boolean here
  // drew a tick on an errored agent and span forever on a failed one — the CLI
  // sends eight words and the predicate knew two.
  it("reads every state the CLI actually sends", () => {
    const state = (s?: string) =>
      workflowAgentOutcome({ type: "workflow_agent", state: s });

    expect(state("start")).toBe("running");
    expect(state("running")).toBe("running");
    expect(state(undefined)).toBe("running");
    expect(state("done")).toBe("done");
    expect(state("completed")).toBe("done");
    expect(state("error")).toBe("failed");
    expect(state("failed")).toBe("failed");
    expect(state("killed")).toBe("interrupted");
    expect(state("skipped")).toBe("interrupted");
  });

  // The regression this pair exists to prevent: two functions in one file
  // disagreeing about the same word.
  it("agrees with the card's own mapping on every word", () => {
    for (const word of [
      "start",
      "running",
      "done",
      "completed",
      "error",
      "failed",
      "killed",
      "skipped",
      "stopped",
      "interrupted",
      "cancelled",
      "whatever_comes_next"
    ]) {
      expect(
        workflowAgentOutcome({ type: "workflow_agent", state: word })
      ).toBe(subagentOutcome(word));
    }
  });
});

// The status the card reads is a free string the CLI adds to between releases,
// and the card had no render test — so a value the host already treated as
// terminal could reach it and quietly take the success branch. `stopped` did.
describe("subagentOutcome", () => {
  it("treats a missing or running status as still working", () => {
    expect(subagentOutcome(undefined)).toBe("running");
    expect(subagentOutcome("")).toBe("running");
    expect(subagentOutcome("running")).toBe("running");
  });

  it("names the four ways an agent fails", () => {
    for (const s of ["failed", "error", "cancelled", "canceled"]) {
      expect(subagentOutcome(s)).toBe("failed");
    }
  });

  // The defect this function was extracted for. `isTerminalTaskStatus` counts
  // `stopped` terminal and documents it as a backgrounded agent whose process
  // was killed under it — so the neutral branch drew a green tick on an agent
  // that never finished.
  it("reads a killed background agent as interrupted, not as done", () => {
    expect(subagentOutcome("stopped")).toBe("interrupted");
    expect(subagentOutcome("interrupted")).toBe("interrupted");
  });

  it("closes normally on completed", () => {
    expect(subagentOutcome("completed")).toBe("done");
  });

  // A word we have not seen is not evidence of failure, and claiming one would
  // be the worse lie of the two.
  it("does not invent a failure out of a status it does not know", () => {
    expect(subagentOutcome("some_future_state")).toBe("done");
  });
});

// What Stop, rewind and edit ask about before destroying it. The number is the
// whole point: a warning that says "you have background work" is a shrug, one
// that says "4 agents, the longest at 38m" is a decision.
describe("live agents", () => {
  const task = (status: string | undefined, durationMs?: number) => ({
    taskId: `t${status}${durationMs ?? ""}`,
    status,
    durationMs
  });

  it("counts only the ones that have not reported a terminal status", () => {
    const progress = {
      a: task("running", 1_000),
      b: task(undefined, 2_000),
      c: task("completed", 9_000),
      d: task("failed", 9_000),
      e: task("interrupted", 9_000)
    } as never;

    expect(liveAgents(progress)).toEqual({ count: 2, longestMs: 2_000 });
  });

  it("reports the longest elapsed, not the sum or the last", () => {
    const progress = {
      a: task("running", 4_000),
      b: task("running", 61_000),
      c: task("running", 900)
    } as never;

    expect(liveAgents(progress).longestMs).toBe(61_000);
  });

  // A task that has not reported usage yet still counts — it is running, and
  // the elapsed time is the part we do not know.
  it("counts an agent that has reported no duration", () => {
    expect(liveAgents({ a: task("running") } as never)).toEqual({
      count: 1,
      longestMs: 0
    });
  });

  it("is empty when nothing is running", () => {
    expect(liveAgents({} as never)).toEqual({ count: 0, longestMs: 0 });
    expect(liveAgents({ a: task("completed", 5) } as never)).toEqual({
      count: 0,
      longestMs: 0
    });
  });
});

// The background-agents panel. Three of its rules are the opposite of the
// obvious version because a recorded run said so — see
// `docs/WORKFLOW-AGENTS-PANEL.md`. These are the tests that keep them that way.
describe("agentPanel", () => {
  /** Every agent starting together, so concurrency is the whole fleet. */
  const TOGETHER = 1_785_239_740_000;

  const agent = (
    label: string,
    state: string,
    extra: Partial<WorkflowProgressEntry> = {}
  ): WorkflowProgressEntry => ({
    type: "workflow_agent",
    phaseIndex: 1,
    phaseTitle: "One",
    label,
    state,
    ...extra
  });

  const workflow = (
    agents: WorkflowProgressEntry[],
    over: Record<string, unknown> = {}
  ) => ({
    taskId: "wf",
    taskType: "local_workflow",
    workflowName: "review-changes",
    status: "running",
    totalTokens: 19_210,
    durationMs: 5_593,
    workflowProgress: agents.length
      ? [{ type: "workflow_phase", index: 1, title: "One" }, ...agents]
      : undefined,
    ...over
  });

  const lone = (status: string, over: Record<string, unknown> = {}) => ({
    taskId: "solo",
    taskType: "local_agent",
    subagentType: "Explore",
    status,
    totalTokens: 9_000,
    durationMs: 22_000,
    ...over
  });

  // A workflow of four and a lone Explore must not weigh the same in one bar.
  it("counts agents rather than launches", () => {
    const progress = {
      wf: workflow([
        agent("a", "done", { durationMs: 1_000 }),
        agent("b", "done", { durationMs: 2_000 }),
        agent("c", "start"),
        agent("d", "running")
      ]),
      solo: lone("running")
    } as never;

    const panel = agentPanel(progress);
    expect(panel.total).toBe(5);
    expect(panel.done).toBe(2);
    expect(panel.running).toBe(3);
  });

  // The capture: the task's `usage.total_tokens` and its one agent's `tokens`
  // were the same 19210. Summing both would report 38420.
  it("reads tokens off the task, never the sum of its agents", () => {
    const progress = {
      wf: workflow(
        [agent("only", "done", { tokens: 19_210, durationMs: 5_580 })],
        { status: "completed" }
      )
    } as never;

    expect(agentPanel(progress).tokens).toBe(19_210);
  });

  // A running agent carries no `tokens` field at all, so the sum would read
  // low for exactly as long as anyone is watching.
  it("does not let a running agent's missing tokens lower the total", () => {
    const progress = {
      wf: workflow([
        agent("finished", "done", { tokens: 19_210, durationMs: 5_580 }),
        agent("still going", "running")
      ])
    } as never;

    expect(agentPanel(progress).tokens).toBe(19_210);
  });

  it("withholds an estimate until three agents have finished", () => {
    const two = {
      wf: workflow([
        agent("a", "done", { durationMs: 1_000, startedAt: TOGETHER }),
        agent("b", "done", { durationMs: 3_000, startedAt: TOGETHER }),
        agent("c", "running", { startedAt: TOGETHER }),
        agent("d", "running", { startedAt: TOGETHER })
      ])
    } as never;
    expect(agentPanel(two).etaMs).toBeUndefined();

    const three = {
      wf: workflow([
        agent("a", "done", { durationMs: 1_000, startedAt: TOGETHER }),
        agent("b", "done", { durationMs: 2_000, startedAt: TOGETHER }),
        agent("c", "done", { durationMs: 3_000, startedAt: TOGETHER }),
        agent("d", "running", { startedAt: TOGETHER }),
        agent("e", "running", { startedAt: TOGETHER })
      ])
    } as never;
    // Median 2000ms, all five overlapped, two left: one more wave.
    expect(agentPanel(three).etaMs).toBe(2_000);
  });

  // An older CLI sends no `startedAt`, and a concurrency of zero would divide.
  it("still estimates when the CLI sent no start times", () => {
    const progress = {
      wf: workflow([
        agent("a", "done", { durationMs: 1_000 }),
        agent("b", "done", { durationMs: 2_000 }),
        agent("c", "done", { durationMs: 3_000 }),
        agent("d", "running"),
        agent("e", "running")
      ])
    } as never;

    expect(agentPanel(progress).etaMs).toBe(4_000);
  });

  // `workflow_progress` can stop arriving before an agent's own terminal state
  // does. One row stuck at `start` must not keep the button lit forever.
  it("leaves nothing running once the CLI closes the run", () => {
    const progress = {
      wf: workflow(
        [agent("a", "done", { durationMs: 1_000 }), agent("stuck", "start")],
        { status: "completed" }
      )
    } as never;

    const panel = agentPanel(progress);
    expect(panel.running).toBe(0);
    expect(panel.done).toBe(2);
    expect(panel.etaMs).toBeUndefined();
  });

  it("marks a restored workflow as unknown rather than empty", () => {
    const progress = { wf: workflow([], { status: "completed" }) } as never;

    const [run] = agentPanel(progress).runs;
    expect(run.detailsUnavailable).toBe(true);
    expect(run.phases).toEqual([]);
    expect(run.total).toBe(1);
  });

  it("reports the longest run's own duration, not a sum", () => {
    const progress = {
      wf: workflow([agent("a", "running")]),
      solo: lone("running", { durationMs: 61_000 })
    } as never;

    expect(agentPanel(progress).elapsedMs).toBe(61_000);
  });

  it("puts what is still running first", () => {
    const progress = {
      solo: lone("completed"),
      wf: workflow([agent("a", "running")])
    } as never;

    expect(agentPanel(progress).runs.map((r) => r.taskId)).toEqual([
      "wf",
      "solo"
    ]);
  });

  it("is empty when nothing has been dispatched", () => {
    expect(agentPanel({} as never)).toEqual({
      runs: [],
      running: 0,
      done: 0,
      total: 0,
      tokens: 0,
      elapsedMs: 0,
      etaMs: undefined
    });
  });
});

// The panel outlives the work it reports on, and `taskProgress` does not: the
// host deletes a task from it as the closing row lands, and `turnEnd` sweeps
// the rest. Reading it alone made the toolbar button vanish at exactly the
// moment someone would ask what the audit cost.
describe("mergeTaskState", () => {
  const finished = {
    taskId: "wf",
    taskType: "local_workflow",
    workflowName: "review-changes",
    status: "completed",
    totalTokens: 19_210,
    durationMs: 5_593
  };

  it("keeps a run the live map has already dropped", () => {
    const merged = mergeTaskState(
      new Map([["wf", finished]]) as never,
      {} as never
    );
    const panel = agentPanel(merged);

    expect(panel.total).toBe(1);
    expect(panel.tokens).toBe(19_210);
    expect(panel.running).toBe(0);
  });

  // Live is the fresher of the two while a run is open — the timeline holds
  // only the dispatch until the closing row arrives.
  it("lets live detail win over what the timeline stored", () => {
    const merged = mergeTaskState(
      new Map([
        ["wf", { ...finished, status: "running", totalTokens: 0 }]
      ]) as never,
      { wf: { taskId: "wf", totalTokens: 42_000 } } as never
    );

    expect(agentPanel(merged).tokens).toBe(42_000);
  });
});

// The stop confirmation and the panel used to disagree one click apart: a
// workflow with two running agents read "2 running" on one and "1 agent still
// working" on the other. One definition now feeds both.
describe("runningUnits — the count both surfaces read", () => {
  const wfTask = (states: string[], status = "running") => ({
    taskId: "wf",
    taskType: "local_workflow",
    status,
    durationMs: 60_000,
    workflowProgress: [
      { type: "workflow_phase", index: 1, title: "One" },
      ...states.map((state, i) => ({
        type: "workflow_agent",
        agentId: `a${i}`,
        phaseIndex: 1,
        label: `a${i}`,
        state
      }))
    ]
  });

  it("counts a workflow's running agents, not the workflow", () => {
    expect(runningUnits(wfTask(["done", "running", "running"]) as never)).toBe(
      2
    );
  });

  it("counts a lone agent as itself", () => {
    expect(runningUnits({ taskId: "solo", status: "running" } as never)).toBe(
      1
    );
  });

  it("is zero once the task has reported a terminal status", () => {
    expect(runningUnits(wfTask(["running"], "completed") as never)).toBe(0);
  });

  // The floor. A workflow between phases has dispatched nobody at this
  // instant — counted as zero it takes the confirmation off Stop, and the
  // interrupt goes through silently.
  it("never reports zero for a workflow that is still alive", () => {
    expect(runningUnits(wfTask(["done", "done"]) as never)).toBe(1);
  });

  it("is the same number the panel and the stop warning both show", () => {
    const progress = {
      wf: wfTask(["done", "running", "running"]),
      solo: { taskId: "solo", status: "running", durationMs: 9_000 }
    } as never;

    expect(liveAgents(progress).count).toBe(3);
    expect(agentPanel(progress).running).toBe(3);
  });

  // Same pairing at the moment the disagreement used to appear.
  it("agrees between phases too", () => {
    const progress = { wf: wfTask(["done", "done"]) } as never;

    expect(liveAgents(progress).count).toBe(1);
    expect(agentPanel(progress).running).toBe(1);
    // The row still reports its own agents honestly — none of them is running.
    expect(agentPanel(progress).runs[0].running).toBe(0);
  });
});
