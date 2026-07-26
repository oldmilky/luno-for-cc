import { describe, it, expect, beforeEach } from "vitest";
import { PlanInterceptor, extractFileRefs } from "../../src/core/plan-intercept.js";
import { Session } from "../../src/core/session.js";
import { PlanRevisionMeta } from "../../src/core/types.js";

function lastRevision(s: Session): PlanRevisionMeta | undefined {
  for (let i = s.timeline.length - 1; i >= 0; i--) {
    if (s.timeline[i].kind === "plan_revision") {
      return s.timeline[i].meta as unknown as PlanRevisionMeta;
    }
  }
  return undefined;
}

describe("PlanInterceptor", () => {
  let session: Session;

  beforeEach(() => {
    session = new Session();
  });

  it("emits a single plan_revision when ExitPlanMode arrives alone", () => {
    const p = new PlanInterceptor(session);
    expect(p.consume("ExitPlanMode", "tu_1", { plan: "## Plan\n- step a" })).toBe(true);
    p.flush();

    const revs = session.timeline.filter((e) => e.kind === "plan_revision");
    expect(revs).toHaveLength(1);
    const meta = revs[0].meta as unknown as PlanRevisionMeta;
    expect(meta.body).toBe("## Plan\n- step a");
    expect(meta.tasks).toEqual([]);
    expect(meta.bodyChanged).toBe(true);
    expect(meta.parentRevisionId).toBeUndefined();
    expect(p.interceptedToolIds.has("tu_1")).toBe(true);
  });

  it("pairs ExitPlanMode + TodoWrite into a single revision", () => {
    const p = new PlanInterceptor(session);
    p.consume("ExitPlanMode", "tu_1", { plan: "Body" });
    p.consume("TodoWrite", "tu_2", {
      todos: [
        { id: "t1", content: "Do thing", activeForm: "Doing thing", status: "pending" }
      ]
    });
    p.flush();

    const revs = session.timeline.filter((e) => e.kind === "plan_revision");
    expect(revs).toHaveLength(1);
    const meta = revs[0].meta as unknown as PlanRevisionMeta;
    expect(meta.body).toBe("Body");
    expect(meta.tasks).toHaveLength(1);
    expect(meta.tasks[0].id).toBe("t1");
    expect(meta.tasks[0].status).toBe("pending");
  });

  it("handles TodoWrite-only updates by keeping prior body and marking bodyChanged=false", () => {
    const p1 = new PlanInterceptor(session);
    p1.consume("ExitPlanMode", "tu_1", { plan: "Initial body" });
    p1.consume("TodoWrite", "tu_2", {
      todos: [{ id: "t1", content: "a", activeForm: "doing a", status: "pending" }]
    });
    p1.flush();

    const p2 = new PlanInterceptor(session);
    p2.consume("TodoWrite", "tu_3", {
      todos: [{ id: "t1", content: "a", activeForm: "doing a", status: "completed" }]
    });

    const revs = session.timeline.filter((e) => e.kind === "plan_revision");
    expect(revs).toHaveLength(2);
    const second = revs[1].meta as unknown as PlanRevisionMeta;
    expect(second.body).toBe("Initial body");
    expect(second.bodyChanged).toBe(false);
    expect(second.tasks[0].status).toBe("completed");
    expect(second.parentRevisionId).toBe(
      (revs[0].meta as unknown as PlanRevisionMeta).revisionId
    );
  });

  it("records AskUserQuestion as a plan_question event with all questions", () => {
    const p = new PlanInterceptor(session);
    const handled = p.consume("AskUserQuestion", "tu_q", {
      questions: [
        {
          question: "Which DB?",
          header: "DB",
          multiSelect: false,
          options: [
            { label: "Postgres", description: "default" },
            { label: "Mysql" }
          ]
        }
      ]
    });
    expect(handled).toBe(true);
    const qs = session.timeline.filter((e) => e.kind === "plan_question");
    expect(qs).toHaveLength(1);
    const meta = qs[0].meta as unknown as { questions: Array<{ question: string }> };
    expect(meta.questions[0].question).toBe("Which DB?");
    expect(p.interceptedToolIds.has("tu_q")).toBe(true);
  });

  it("extractFileRefs ignores stray dotted tokens like phase 1.0", () => {
    expect(extractFileRefs("Phase 1.0 begins now")).toEqual([]);
    expect(extractFileRefs("see 1.2.3 below")).toEqual([]);
  });

  it("extractFileRefs dedupes identical paths and ranges", () => {
    const refs = extractFileRefs("foo/bar.ts:5-9 mentioned earlier; revisit foo/bar.ts:5-9.");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({ path: "foo/bar.ts", startLine: 5, endLine: 9 });
  });

  it("does not handle unrelated tool names", () => {
    const p = new PlanInterceptor(session);
    expect(p.consume("Bash", "tu_b", { command: "ls" })).toBe(false);
    expect(session.timeline.length).toBe(0);
    expect(p.interceptedToolIds.size).toBe(0);
  });

  it("links revisions: each new revision points to its predecessor", () => {
    const p1 = new PlanInterceptor(session);
    p1.consume("ExitPlanMode", "tu_1", { plan: "v1" });
    p1.flush();

    const p2 = new PlanInterceptor(session);
    p2.consume("ExitPlanMode", "tu_2", { plan: "v2" });
    p2.flush();

    const revs = session.timeline.filter((e) => e.kind === "plan_revision");
    expect(revs).toHaveLength(2);
    const r1 = revs[0].meta as unknown as PlanRevisionMeta;
    const r2 = revs[1].meta as unknown as PlanRevisionMeta;
    expect(r2.parentRevisionId).toBe(r1.revisionId);
  });

  it("emits a revision immediately when a plan-file Write is intercepted", () => {
    const p = new PlanInterceptor(session);
    const planMd = "# Plan\n\nDo a thing.\n";
    expect(
      p.consume("Write", "tu_w", {
        file_path: "/Users/me/.claude/plans/foo.md",
        content: planMd
      })
    ).toBe(true);
    // Revision is on the timeline before flush() — it appears in place,
    // not at the end of the stream.
    const revs = session.timeline.filter((e) => e.kind === "plan_revision");
    expect(revs).toHaveLength(1);
    const meta = revs[0].meta as unknown as PlanRevisionMeta;
    expect(meta.body).toBe(planMd);
    expect(meta.planFilePath).toBe("/Users/me/.claude/plans/foo.md");
  });

  it("ExitPlanMode with no plan field is a no-op when a plan file already produced a revision", () => {
    const p = new PlanInterceptor(session);
    p.consume("Write", "tu_w", {
      file_path: "plans/strategy.md",
      content: "# Strategy"
    });
    p.consume("ExitPlanMode", "tu_x", {});
    p.flush();

    const revs = session.timeline.filter((e) => e.kind === "plan_revision");
    expect(revs).toHaveLength(1); // the Write produced one; ExitPlanMode adds nothing
    expect((revs[0].meta as unknown as PlanRevisionMeta).body).toBe("# Strategy");
  });

  it("does not snoop writes to non-plan files", () => {
    const p = new PlanInterceptor(session);
    expect(
      p.consume("Write", "tu_w", { file_path: "src/foo.ts", content: "// code" })
    ).toBe(false);
    expect(p.interceptedToolIds.size).toBe(0);
  });

  it("attaches fileRefs parsed from task content to each task", () => {
    const p = new PlanInterceptor(session);
    p.consume("TodoWrite", "tu_t", {
      todos: [
        {
          id: "t1",
          content: "Wire CI gate via .github/workflows/test.yml:14-32",
          activeForm: "Wiring CI gate",
          status: "pending"
        },
        {
          id: "t2",
          content: "Refactor [Open foo](src/lib/foo.ts) and tweak src/lib/bar.ts:5",
          activeForm: "Refactoring",
          status: "pending"
        }
      ]
    });
    p.flush();
    const revs = session.timeline.filter((e) => e.kind === "plan_revision");
    const meta = revs[0].meta as unknown as PlanRevisionMeta;
    expect(meta.tasks[0].fileRefs).toEqual([
      { path: ".github/workflows/test.yml", startLine: 14, endLine: 32 }
    ]);
    expect(meta.tasks[1].fileRefs).toEqual([
      { path: "src/lib/foo.ts", startLine: 1, endLine: 1, label: "Open foo" },
      { path: "src/lib/bar.ts", startLine: 5, endLine: 5 }
    ]);
  });

  it("malformed JSON inputs degrade gracefully", () => {
    const p = new PlanInterceptor(session);
    p.consume("ExitPlanMode", "tu_1", {});
    p.consume("TodoWrite", "tu_2", { todos: "not-an-array" } as unknown as Record<string, unknown>);
    p.flush();
    const meta = lastRevision(session);
    expect(meta).toBeDefined();
    expect(meta!.body).toBe("");
    expect(meta!.tasks).toEqual([]);
  });
});
