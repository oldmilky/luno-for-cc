import { describe, expect, it } from "vitest";

import { SubagentRoster } from "../../src/ui/domains/subagent-roster.js";
import type { SubagentUpdate } from "../../src/core/types.js";

const update = (over: Partial<SubagentUpdate> & { taskId: string }) =>
  ({ phase: "progress", ...over }) as SubagentUpdate;

describe("folding an update into the roster", () => {
  it("reports the first sighting of a task as started", () => {
    const roster = new SubagentRoster();
    const out = roster.accept(
      update({ taskId: "t1", phase: "started", description: "read the docs" })
    );
    expect(out).toMatchObject({ kind: "started" });
    expect(roster.openCount).toBe(1);
  });

  it("keeps what `task_started` said when a later phase omits it", () => {
    const roster = new SubagentRoster();
    roster.accept(
      update({ taskId: "t1", phase: "started", description: "read the docs" })
    );
    const out = roster.accept(update({ taskId: "t1", lastToolName: "Grep" }));
    // The progress event carries no description; erasing it would leave the row
    // an anonymous "Agent".
    expect(out).toMatchObject({
      kind: "progress",
      task: { description: "read the docs", lastToolName: "Grep" }
    });
  });

  it("lets the incoming event win over what the task looked like", () => {
    const roster = new SubagentRoster();
    roster.accept(
      update({ taskId: "t1", phase: "started", lastToolName: "Read" })
    );
    const out = roster.accept(update({ taskId: "t1", lastToolName: "Grep" }));
    expect(out).toMatchObject({ task: { lastToolName: "Grep" } });
  });

  // A workflow puts the agent's own label in `last_tool_name`, and the same
  // string is already the activity — showing it twice reads as a tool call.
  it("drops the tool name on a workflow task", () => {
    const roster = new SubagentRoster();
    roster.accept(
      update({ taskId: "t1", phase: "started", taskType: "local_workflow" })
    );
    const out = roster.accept(
      update({ taskId: "t1", lastToolName: "Reply with exactly the word OK" })
    );
    expect(out).toMatchObject({ kind: "progress" });
    expect((out as { task: SubagentUpdate }).task.lastToolName).toBeUndefined();
  });

  it("closes the task on `notification` and takes it off the roster", () => {
    const roster = new SubagentRoster();
    roster.accept(update({ taskId: "t1", phase: "started" }));
    const out = roster.accept(
      update({ taskId: "t1", phase: "notification", summary: "done" })
    );
    expect(out).toMatchObject({ kind: "ended", task: { summary: "done" } });
    expect(roster.openCount).toBe(0);
  });
});

// Measured: a `task_progress` landing 1.4s after the `task_notification` that
// ended a task. Without the guard it went back among the live ones and the
// sweep then filed it `interrupted`, over the status the CLI had reported.
describe("an event arriving after the CLI already ended the task", () => {
  const ended = () => {
    const roster = new SubagentRoster();
    roster.accept(update({ taskId: "t1", phase: "started" }));
    roster.accept(
      update({ taskId: "t1", phase: "notification", status: "stopped" })
    );
    return roster;
  };

  it("is ignored rather than resurrecting the task", () => {
    const roster = ended();
    expect(roster.accept(update({ taskId: "t1" }))).toEqual({
      kind: "ignored"
    });
    expect(roster.openCount).toBe(0);
  });

  it("cannot be swept as interrupted, because it is not open", () => {
    const roster = ended();
    roster.accept(update({ taskId: "t1" }));
    expect(roster.sweep()).toEqual([]);
  });

  it("does not silence a different task", () => {
    const roster = ended();
    expect(
      roster.accept(update({ taskId: "t2", phase: "started" }))
    ).toMatchObject({
      kind: "started"
    });
  });
});

describe("sweeping what the dead process left open", () => {
  it("returns every open task and empties the roster", () => {
    const roster = new SubagentRoster();
    roster.accept(update({ taskId: "t1", phase: "started" }));
    roster.accept(update({ taskId: "t2", phase: "started" }));
    expect(roster.sweep().map((t) => t.taskId)).toEqual(["t1", "t2"]);
    expect(roster.openCount).toBe(0);
    expect(roster.sweep()).toEqual([]);
  });

  // Measured: an agent closed yellow at 38.6s by a sweep and reopened green at
  // 107.6s. Only a status the CLI reported blocks that healing.
  it("leaves a swept task able to heal when its notification lands", () => {
    const roster = new SubagentRoster();
    roster.accept(update({ taskId: "t1", phase: "started" }));
    roster.sweep();
    expect(
      roster.accept(
        update({ taskId: "t1", phase: "notification", status: "completed" })
      )
    ).toMatchObject({ kind: "ended", task: { status: "completed" } });
  });
});

describe("what the surface reads", () => {
  it("hands back the open tasks so their cards can be rebuilt", () => {
    const roster = new SubagentRoster();
    roster.accept(update({ taskId: "t1", phase: "started", description: "a" }));
    roster.accept(update({ taskId: "t2", phase: "started", description: "b" }));
    roster.accept(update({ taskId: "t1", phase: "notification" }));
    expect(roster.open().map((t) => t.description)).toEqual(["b"]);
  });
});
