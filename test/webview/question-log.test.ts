import { describe, it, expect } from "vitest";
import {
  answerText,
  foldQuestions
} from "../../webview/src/features/chat/question-log.js";

// question-log.ts is React-free, so it runs in the node environment.
// It is the transcript's only account of an AskUserQuestion: the card that
// collected the answer is a permission prompt and is gone once answered.

const ev = (o: Record<string, unknown>): any => ({
  id: String(o.id ?? "e"),
  ts: 1,
  kind: o.kind,
  title: "",
  body: "",
  meta: o.meta
});

const question = (id: string, questions: unknown[]) =>
  ev({
    id: `q-${id}`,
    kind: "plan_question",
    meta: { questionId: id, toolUseId: `tu-${id}`, questions }
  });

describe("foldQuestions", () => {
  it("keeps a question that never landed under a plan revision", () => {
    // The hole this closes: the plan panel's fold attaches a question to a
    // revision or drops it, so a clarifying question asked outside plan mode
    // had no record anywhere.
    const map = foldQuestions([
      question("q1", [{ question: "Which library?", options: [] }])
    ]);
    expect(map.get("q1")).toMatchObject({
      questionId: "q1",
      answered: false,
      answers: []
    });
  });

  it("pairs an answer with its question", () => {
    const map = foldQuestions([
      question("q1", [
        { question: "Which library?", options: [] },
        { question: "Behind a flag?", options: [] }
      ]),
      ev({
        kind: "plan_answer",
        meta: {
          questionId: "q1",
          answers: [{ choice: "date-fns" }, { choice: "Yes" }]
        }
      })
    ]);
    const view = map.get("q1")!;
    expect(view.answered).toBe(true);
    expect(view.answers.map((a) => a.choice)).toEqual(["date-fns", "Yes"]);
  });

  it("ignores an answer whose question is not on the timeline", () => {
    // Rewinding past the question leaves the answer with no prompt to render
    // against — a list of choices to an unknown question is worse than none.
    const map = foldQuestions([
      ev({ kind: "plan_answer", meta: { questionId: "ghost", answers: [] } })
    ]);
    expect(map.size).toBe(0);
  });

  it("keeps several questions apart", () => {
    const map = foldQuestions([
      question("q1", [{ question: "A?", options: [] }]),
      ev({
        kind: "plan_answer",
        meta: { questionId: "q1", answers: [{ choice: "a" }] }
      }),
      question("q2", [{ question: "B?", options: [] }])
    ]);
    expect(map.get("q1")?.answered).toBe(true);
    expect(map.get("q2")?.answered).toBe(false);
  });
});

describe("answerText", () => {
  it("reads a plain choice", () => {
    expect(answerText({ choice: "date-fns" })).toBe("date-fns");
  });

  it("resolves the legacy __other sentinel to what was typed", () => {
    // Sessions saved before the answer moved onto the permission response
    // still carry it; rendering raw would show the user `__other`.
    expect(answerText({ choice: "__other", note: " dayjs " })).toBe("dayjs");
    expect(answerText({ choice: "__other" })).toBe("Other");
  });

  it("is empty for a question with no answer", () => {
    expect(answerText(undefined)).toBe("");
  });
});
