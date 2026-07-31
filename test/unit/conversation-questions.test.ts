// ─────────────────────────────────────────────────────────────
// The answer to an AskUserQuestion reaches the timeline.
//
// It travels to the model as the tool's own `updatedInput`, which leaves
// nothing behind: the card that collected it is a permission prompt and is
// gone the moment it is answered. Without a record, reopening the chat shows
// a turn built on a decision with no trace of the decision.
//
// Two shapes meet in `recordAnswerFromTool`. On the wire the answers are keyed
// by question text; on the timeline they are positional, which is what every
// stored session already carries. The question event is the only thing that
// knows both orders, so these tests are mostly about that mapping.
// ─────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PlanHandlers } from "../../src/ui/domains/plan-handlers.js";
import { Session } from "../../src/core/session.js";

// plan-handlers imports vscode for the actions that open editors; none of the
// paths under test reach them, so the module only has to resolve.
vi.mock("vscode", () => ({
  window: { showErrorMessage: async () => undefined },
  workspace: {
    getConfiguration: () => ({ get: (_k: string, d?: unknown) => d })
  },
  Uri: { file: (p: string) => ({ fsPath: p }) }
}));

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const QUESTIONS = [
  {
    question: "Which library?",
    header: "Library",
    options: [{ label: "date-fns" }]
  },
  { question: "Behind a flag?", header: "Rollout", options: [{ label: "Yes" }] }
];

/** A session with one question already asked, and the handlers over it. */
function asked(
  toolUseId = "tu-1",
  questionId = "qid-1",
  questions = QUESTIONS
) {
  const session = new Session("s");
  session.emitPlanQuestion({
    questionId,
    toolUseId,
    questions: questions as never
  });
  const posted: unknown[] = [];
  const plan = new PlanHandlers({
    post: (m: unknown) => posted.push(m),
    sessions: {
      current: session,
      scheduleSave() {},
      resumeId: undefined
    } as never,
    artifacts: {} as never,
    startPrompt: async () => {
      throw new Error("answering a question must not open a turn");
    },
    refreshAuth: async () => {}
  });
  const answerEvents = () =>
    session.timeline.filter((e) => e.kind === "plan_answer");
  return { session, plan, posted, answerEvents };
}

const choices = (e: { meta?: unknown }) =>
  (e.meta as { answers: Array<{ choice: string }> }).answers.map(
    (a) => a.choice
  );

describe("recording an AskUserQuestion answer", () => {
  it("maps the wire's question-keyed answers onto positional ones", () => {
    const { plan, posted, answerEvents } = asked();

    plan.recordAnswerFromTool("tu-1", {
      "Which library?": "date-fns",
      "Behind a flag?": "Yes"
    });

    const [answer] = answerEvents();
    expect(answer).toBeDefined();
    expect((answer.meta as { questionId: string }).questionId).toBe("qid-1");
    expect(choices(answer)).toEqual(["date-fns", "Yes"]);
    // Posted too, so an open panel updates without waiting for a reload.
    expect(
      posted.some((m) => (m as { type?: string }).type === "timeline")
    ).toBe(true);
  });

  it("keeps the answers in question order, not in the order they arrived", () => {
    const { plan, answerEvents } = asked();
    plan.recordAnswerFromTool("tu-1", {
      "Behind a flag?": "Yes",
      "Which library?": "date-fns"
    });
    expect(choices(answerEvents()[0])).toEqual(["date-fns", "Yes"]);
  });

  it("records a partial answer, leaving the skipped question empty", () => {
    const { plan, answerEvents } = asked();
    plan.recordAnswerFromTool("tu-1", { "Behind a flag?": "Yes" });
    expect(choices(answerEvents()[0])).toEqual(["", "Yes"]);
  });

  it("writes nothing when there is no question to attach to", () => {
    const { plan, answerEvents } = asked();
    // A tool id nothing on the timeline asked about.
    plan.recordAnswerFromTool("tu-nope", { "Which library?": "date-fns" });
    // No tool id at all.
    plan.recordAnswerFromTool("", { "Which library?": "date-fns" });
    expect(answerEvents()).toHaveLength(0);
  });

  it("writes nothing when nothing was actually answered", () => {
    // Skip sends `deny` and never reaches here, but a shape change or a
    // question the user cleared would arrive as an object matching nothing.
    const { plan, answerEvents } = asked();
    plan.recordAnswerFromTool("tu-1", { "Some other question?": "x" });
    plan.recordAnswerFromTool("tu-1", {});
    expect(answerEvents()).toHaveLength(0);
  });

  it("answers the newest question when a tool id repeats", () => {
    const { session, plan, answerEvents } = asked();
    session.emitPlanQuestion({
      questionId: "qid-2",
      toolUseId: "tu-1",
      questions: [QUESTIONS[0]] as never
    });

    plan.recordAnswerFromTool("tu-1", { "Which library?": "date-fns" });

    expect((answerEvents()[0].meta as { questionId: string }).questionId).toBe(
      "qid-2"
    );
  });
});

describe("the event that gets stored", () => {
  it("summarises the answer in the body, so the raw log reads", () => {
    const session = new Session("s");
    const ev = session.emitPlanAnswer({
      questionId: "q",
      answers: [{ choice: "date-fns" }, { choice: "Yes" }]
    });
    expect(ev.kind).toBe("plan_answer");
    expect(ev.body).toBe("date-fns · Yes");
  });
});
