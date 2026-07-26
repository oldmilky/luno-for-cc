import { describe, it, expect } from "vitest";
import { foldPlanState } from "../../webview/src/features/plan/foldPlanState";
import type { TimelineEvent } from "../../webview/src/lib/rpc";

let nextId = 0;
const ev = (kind: string, meta: Record<string, unknown>): TimelineEvent => ({
  id: `ev_${++nextId}`,
  ts: Date.now() + nextId,
  kind: kind as TimelineEvent["kind"],
  title: kind,
  meta
});

describe("foldPlanState", () => {
  it("groups replies under their parent comment", () => {
    const events: TimelineEvent[] = [
      ev("plan_revision", {
        revisionId: "r1",
        body: "Some plan",
        tasks: [],
        bodyChanged: true
      }),
      ev("plan_comment", {
        commentId: "c1",
        revisionId: "r1",
        taskId: "__inline__",
        body: "First thoughts",
        quote: "some prose"
      }),
      ev("plan_comment", {
        commentId: "c2",
        revisionId: "r1",
        taskId: "__inline__",
        body: "Reply A",
        parentCommentId: "c1"
      }),
      ev("plan_comment", {
        commentId: "c3",
        revisionId: "r1",
        taskId: "__inline__",
        body: "Reply B",
        parentCommentId: "c1"
      }),
      ev("plan_comment", {
        commentId: "c4",
        revisionId: "r1",
        taskId: "__general__",
        body: "Standalone whole-plan note"
      })
    ];

    const [view] = foldPlanState(events);
    expect(view.rootComments).toHaveLength(2);
    expect(view.rootComments[0].commentId).toBe("c1");
    expect(view.rootComments[0].replies.map((r) => r.commentId)).toEqual(["c2", "c3"]);
    expect(view.rootComments[1].commentId).toBe("c4");
    expect(view.rootComments[1].replies).toEqual([]);
    // Flat list still has all four (legacy contract).
    expect(view.comments).toHaveLength(4);
  });

  it("filters soft-deleted comments out of the rendered view", () => {
    const events: TimelineEvent[] = [
      ev("plan_revision", { revisionId: "r1", body: "", tasks: [], bodyChanged: true }),
      ev("plan_comment", {
        commentId: "c1",
        revisionId: "r1",
        taskId: "__general__",
        body: "Original"
      }),
      ev("plan_comment", {
        commentId: "c2",
        revisionId: "r1",
        taskId: "__general__",
        body: "Deleted",
        deleted: true
      })
    ];
    const [view] = foldPlanState(events);
    expect(view.comments.map((c) => c.commentId)).toEqual(["c1"]);
  });

  it("orphan replies (parent missing) get promoted to root", () => {
    const events: TimelineEvent[] = [
      ev("plan_revision", { revisionId: "r1", body: "", tasks: [], bodyChanged: true }),
      ev("plan_comment", {
        commentId: "child",
        revisionId: "r1",
        taskId: "__general__",
        body: "Reply with no parent",
        parentCommentId: "missing"
      })
    ];
    const [view] = foldPlanState(events);
    expect(view.rootComments.map((c) => c.commentId)).toEqual(["child"]);
  });
});
