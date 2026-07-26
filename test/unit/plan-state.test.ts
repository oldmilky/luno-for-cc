import { describe, it, expect } from "vitest";
import {
  findCommentEvent,
  findRevisionEvent,
  incompletePlanSections,
  isCommentRevisionProceeded,
  isRevisionProceeded,
  setTaskStatus,
  type PlanEvent
} from "../../src/ui/domains/plan-state.js";

// This logic lived as private methods on a 2981-line class that no test
// imported, so none of it had ever been exercised. It is pure — timeline in,
// answer out — and only the class was keeping it untestable.

const revision = (revisionId: string, meta: Record<string, unknown> = {}) => ({
  kind: "plan_revision",
  meta: { revisionId, ...meta }
});

const comment = (commentId: string, meta: Record<string, unknown> = {}) => ({
  kind: "plan_comment",
  meta: { commentId, ...meta }
});

describe("findRevisionEvent / findCommentEvent", () => {
  it("finds by id and ignores the other kind", () => {
    const timeline: PlanEvent[] = [
      { kind: "user", meta: { revisionId: "r1" } },
      comment("c1", { revisionId: "r1" }),
      revision("r1")
    ];
    // A `user` event carrying the same key must not match — the kind check is
    // what stops an unrelated event with a lookalike meta from answering.
    expect(findRevisionEvent(timeline, "r1")).toBe(timeline[2]);
    expect(findCommentEvent(timeline, "c1")).toBe(timeline[1]);
  });

  it("returns undefined for an unknown id and for a missing meta", () => {
    const timeline: PlanEvent[] = [{ kind: "plan_revision" }, revision("r1")];
    expect(findRevisionEvent(timeline, "nope")).toBeUndefined();
    expect(
      findRevisionEvent([{ kind: "plan_revision" }], "r1")
    ).toBeUndefined();
  });

  it("returns the first match when ids repeat", () => {
    const first = revision("r1", { body: "first" });
    const timeline: PlanEvent[] = [first, revision("r1", { body: "second" })];
    expect(findRevisionEvent(timeline, "r1")).toBe(first);
  });
});

describe("incompletePlanSections", () => {
  it("reports nothing when sections were never parsed", () => {
    // Legacy plans predate section parsing. Reporting them as incomplete would
    // be a warning about the absence of a feature, not about the plan.
    expect(incompletePlanSections(undefined)).toEqual([]);
    expect(incompletePlanSections({} as never)).toEqual([]);
  });

  it("counts a whitespace-only section as missing", () => {
    const gaps = incompletePlanSections({
      sections: { approach: "real content", risks: "   ", verification: "" }
    } as never);
    expect(gaps).toContain("Risks");
    expect(gaps).toContain("Verification");
    expect(gaps).not.toContain("Approach");
  });

  it("returns display labels, capitalised", () => {
    const gaps = incompletePlanSections({ sections: {} } as never);
    expect(gaps.length).toBeGreaterThan(0);
    for (const label of gaps) {
      expect(label[0]).toBe(label[0].toUpperCase());
    }
  });
});

describe("isRevisionProceeded", () => {
  it("is false unless the flag is exactly true", () => {
    expect(isRevisionProceeded([revision("r1")], "r1")).toBe(false);
    expect(
      isRevisionProceeded([revision("r1", { proceeded: false })], "r1")
    ).toBe(false);
    // Truthy-but-not-true must not lock a plan: the lock blocks every edit
    // until a rewind, so a stray string in the metadata would strand the user.
    expect(
      isRevisionProceeded([revision("r1", { proceeded: "yes" })], "r1")
    ).toBe(false);
    expect(
      isRevisionProceeded([revision("r1", { proceeded: true })], "r1")
    ).toBe(true);
  });

  it("is false for a revision that does not exist", () => {
    expect(isRevisionProceeded([], "r1")).toBe(false);
  });
});

describe("isCommentRevisionProceeded", () => {
  it("follows the comment to its revision", () => {
    const timeline: PlanEvent[] = [
      revision("r1", { proceeded: true }),
      comment("c1", { revisionId: "r1" }),
      revision("r2"),
      comment("c2", { revisionId: "r2" })
    ];
    expect(isCommentRevisionProceeded(timeline, "c1")).toBe(true);
    expect(isCommentRevisionProceeded(timeline, "c2")).toBe(false);
  });

  it("is false when the comment has no revision or does not exist", () => {
    expect(isCommentRevisionProceeded([comment("c1")], "c1")).toBe(false);
    expect(isCommentRevisionProceeded([], "c1")).toBe(false);
  });
});

describe("setTaskStatus", () => {
  const withTasks = () =>
    revision("r1", {
      tasks: [
        { id: "t1", status: "pending" },
        { id: "t2", status: "pending" }
      ]
    });

  it("updates the named task and leaves its siblings alone", () => {
    const ev = withTasks();
    const result = setTaskStatus([ev], "r1", "t2", "accepted");

    expect(result?.task).toEqual({ id: "t2", status: "accepted" });
    const tasks = (ev.meta as { tasks: Array<{ id: string; status: string }> })
      .tasks;
    expect(tasks[0].status).toBe("pending");
    expect(tasks[1].status).toBe("accepted");
  });

  it("returns the event so the caller can re-post it", () => {
    const ev = withTasks();
    expect(setTaskStatus([ev], "r1", "t1", "skipped")?.ev).toBe(ev);
  });

  it("returns null rather than throwing on a missing revision or task", () => {
    // Callers treat null as "nothing to do". Throwing here would take down a
    // message handler for a stale click.
    expect(setTaskStatus([withTasks()], "nope", "t1", "accepted")).toBeNull();
    expect(setTaskStatus([withTasks()], "r1", "nope", "accepted")).toBeNull();
    expect(setTaskStatus([revision("r1")], "r1", "t1", "accepted")).toBeNull();
  });

  it("replaces the task object instead of mutating it in place", () => {
    // The webview diffs on identity; mutating the existing object would let a
    // status change render as no change at all.
    const ev = withTasks();
    const before = (ev.meta as { tasks: Array<{ id: string; status: string }> })
      .tasks[0];
    setTaskStatus([ev], "r1", "t1", "in_progress");
    const after = (ev.meta as { tasks: Array<{ id: string; status: string }> })
      .tasks[0];
    expect(after).not.toBe(before);
    expect(before.status).toBe("pending");
  });
});
