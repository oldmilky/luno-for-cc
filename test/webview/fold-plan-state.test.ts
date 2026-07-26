import { describe, it, expect } from "vitest";
import {
  foldPlanState,
  looksLikePlanFile,
  unresolvedComments
} from "../../webview/src/features/plan/foldPlanState.js";

// foldPlanState only uses `import type`, so it runs in node.

const ev = (o: any): any => o;

const revision = (revisionId: string, body = "# Plan", extra: any = {}) =>
  ev({
    id: `rev-${revisionId}`,
    ts: 1,
    kind: "plan_revision",
    title: `Plan ${revisionId}`,
    body,
    meta: { revisionId, body, tasks: [], bodyChanged: true, ...extra }
  });

const comment = (commentId: string, revisionId: string, extra: any = {}) =>
  ev({
    id: `c-${commentId}`,
    ts: 2,
    kind: "plan_comment",
    title: "Plan comment",
    body: "a comment",
    meta: { commentId, revisionId, taskId: "__general__", body: "a comment", ...extra }
  });

describe("looksLikePlanFile", () => {
  it("accepts *.md under a plans/ segment", () => {
    expect(looksLikePlanFile("/x/plans/foo.md")).toBe(true);
    expect(looksLikePlanFile("/home/.claude/projects/abc/plans/p.markdown")).toBe(true);
    expect(looksLikePlanFile("plans/p.md")).toBe(true);
  });
  it("rejects non-plan paths and non-markdown files", () => {
    expect(looksLikePlanFile("/x/foo.md")).toBe(false);
    expect(looksLikePlanFile("/x/plans/foo.txt")).toBe(false);
    expect(looksLikePlanFile("")).toBe(false);
  });
});

describe("foldPlanState", () => {
  it("produces one view per plan_revision in order", () => {
    const views = foldPlanState([revision("r1"), revision("r2")]);
    expect(views.map((v) => v.meta.revisionId)).toEqual(["r1", "r2"]);
  });

  it("attaches comments to their revision and builds rootComments", () => {
    const views = foldPlanState([revision("r1"), comment("c1", "r1")]);
    expect(views[0].comments).toHaveLength(1);
    expect(views[0].rootComments).toHaveLength(1);
  });

  it("excludes soft-deleted comments", () => {
    const views = foldPlanState([
      revision("r1"),
      comment("c1", "r1"),
      comment("c2", "r1", { deleted: true })
    ]);
    expect(views[0].comments.map((c) => c.commentId)).toEqual(["c1"]);
  });

  it("nests replies under their parent and keeps a single root", () => {
    const views = foldPlanState([
      revision("r1"),
      comment("c1", "r1"),
      comment("c2", "r1", { parentCommentId: "c1" })
    ]);
    expect(views[0].rootComments).toHaveLength(1);
    expect(views[0].rootComments[0].replies.map((r) => r.commentId)).toEqual(["c2"]);
  });

  it("promotes orphan replies (missing parent) to root so they aren't lost", () => {
    const views = foldPlanState([
      revision("r1"),
      comment("c2", "r1", { parentCommentId: "ghost" })
    ]);
    expect(views[0].rootComments.map((c) => c.commentId)).toEqual(["c2"]);
  });

  it("synthesizes a plan view from a plan-file write in legacy sessions", () => {
    const views = foldPlanState([
      ev({
        id: "t1",
        ts: 1,
        kind: "tool_call",
        title: "Tool: Write",
        body: JSON.stringify({ path: "/x/plans/impl.md", content: "# Synth Plan\n\nbody" }),
        meta: { id: "tool-1", name: "Write" }
      })
    ]);
    expect(views).toHaveLength(1);
    expect(views[0].meta.planFilePath).toBe("/x/plans/impl.md");
    expect(views[0].meta.body).toContain("Synth Plan");
  });

  it("does NOT synthesize for writes to non-plan files", () => {
    const views = foldPlanState([
      ev({
        id: "t1",
        ts: 1,
        kind: "tool_call",
        title: "Tool: Write",
        body: JSON.stringify({ path: "/x/src/index.ts", content: "x" }),
        meta: { id: "tool-1", name: "Write" }
      })
    ]);
    expect(views).toHaveLength(0);
  });

  it("attaches answers to the revision that holds the question", () => {
    const views = foldPlanState([
      revision("r1"),
      ev({
        id: "q1",
        ts: 2,
        kind: "plan_question",
        title: "Q",
        body: "?",
        meta: { questionId: "qid", toolUseId: "t", revisionId: "r1", questions: [] }
      }),
      ev({
        id: "a1",
        ts: 3,
        kind: "plan_answer",
        title: "A",
        body: "answer",
        meta: { questionId: "qid", answers: [{ choice: "Yes" }] }
      })
    ]);
    expect(views[0].answeredQuestionIds.has("qid")).toBe(true);
    expect(views[0].answers).toHaveLength(1);
  });
});

describe("unresolvedComments", () => {
  it("returns only comments without resolvedAt / resolvedInRevisionId", () => {
    const views = foldPlanState([
      revision("r1"),
      comment("open", "r1"),
      comment("manuallyResolved", "r1", { resolvedAt: 123 }),
      comment("autoResolved", "r1", { resolvedInRevisionId: "r2" })
    ]);
    const open = unresolvedComments(views[0]);
    expect(open.map((c) => c.commentId)).toEqual(["open"]);
  });
});
