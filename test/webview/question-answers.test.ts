import { describe, it, expect } from "vitest";
import {
  OTHER,
  allAnswered,
  buildAnswers,
  buildUpdatedInput,
  emptyDrafts,
  isAnswered,
  readQuestions
} from "../../webview/src/features/chat/question-answers.js";

// question-answers.ts is React-free on purpose, so it runs in the node
// environment with no DOM. What it builds is the whole answer channel:
// `AskUserQuestion` hands its input back as its result, so the object these
// functions produce IS what the model reads.

const oneQuestion = {
  questions: [
    {
      question: "Which library?",
      header: "Library",
      options: [
        { label: "date-fns", description: "tree-shakeable" },
        { label: "luxon", description: "immutable" }
      ]
    }
  ]
};

describe("readQuestions", () => {
  it("reads the wire shape, preview included", () => {
    const qs = readQuestions({
      questions: [
        {
          question: "Which layout?",
          header: "Layout",
          multiSelect: true,
          options: [
            { label: "Grid", description: "even", preview: "```\n[][]\n```" },
            { label: "List" }
          ]
        }
      ]
    });
    expect(qs).toEqual([
      {
        question: "Which layout?",
        header: "Layout",
        multiSelect: true,
        options: [
          { label: "Grid", description: "even", preview: "```\n[][]\n```" },
          { label: "List", description: undefined, preview: undefined }
        ]
      }
    ]);
  });

  it("returns null for anything that is not a question payload", () => {
    expect(readQuestions(undefined)).toBeNull();
    expect(readQuestions({})).toBeNull();
    expect(readQuestions({ questions: "nope" })).toBeNull();
    expect(readQuestions({ questions: [] })).toBeNull();
    // A question with no text is not a question — the card would render an
    // unanswerable blank, so it falls back to the generic permission card.
    expect(readQuestions({ questions: [{ question: "   " }] })).toBeNull();
  });

  it("drops malformed options rather than the whole question", () => {
    const qs = readQuestions({
      questions: [{ question: "Pick", options: [{ label: "a" }, {}, null, 7] }]
    });
    expect(qs?.[0].options).toEqual([
      { label: "a", description: undefined, preview: undefined }
    ]);
  });
});

describe("buildAnswers", () => {
  const qs = readQuestions(oneQuestion)!;

  it("keys by question text, not by index", () => {
    const drafts = [{ picked: ["date-fns"], otherText: "" }];
    expect(buildAnswers(qs, drafts)).toEqual({ "Which library?": "date-fns" });
  });

  it("comma-joins a multi-select answer", () => {
    const multi = readQuestions({
      questions: [
        {
          question: "Which features?",
          multiSelect: true,
          options: [{ label: "SSR" }, { label: "ISR" }, { label: "Edge" }]
        }
      ]
    })!;
    const drafts = [{ picked: ["SSR", "Edge"], otherText: "" }];
    expect(buildAnswers(multi, drafts)).toEqual({
      "Which features?": "SSR, Edge"
    });
  });

  it("substitutes the typed text for Other — the sentinel never ships", () => {
    const drafts = [{ picked: [OTHER], otherText: "  dayjs  " }];
    const answers = buildAnswers(qs, drafts);
    expect(answers).toEqual({ "Which library?": "dayjs" });
    expect(JSON.stringify(answers)).not.toContain(OTHER.trim());
    expect(JSON.stringify(answers)).not.toContain("__other");
  });

  it("omits a question with nothing chosen instead of sending an empty string", () => {
    // The CLI reads a missing key as "not answered"; "" would read as one.
    expect(buildAnswers(qs, [{ picked: [], otherText: "" }])).toEqual({});
    expect(buildAnswers(qs, [{ picked: [OTHER], otherText: "   " }])).toEqual(
      {}
    );
  });
});

describe("buildUpdatedInput", () => {
  it("carries the payload's own questions and any field we do not render", () => {
    const input = {
      questions: oneQuestion.questions,
      metadata: { source: "remember" }
    };
    const qs = readQuestions(input)!;
    const out = buildUpdatedInput(input, qs, [
      { picked: ["luxon"], otherText: "" }
    ]);
    expect(out).toEqual({
      questions: oneQuestion.questions,
      metadata: { source: "remember" },
      answers: { "Which library?": "luxon" }
    });
  });
});

describe("allAnswered", () => {
  const two = readQuestions({
    questions: [
      { question: "A?", options: [{ label: "a1" }] },
      { question: "B?", options: [{ label: "b1" }] }
    ]
  })!;

  it("is false until every question has an answer", () => {
    expect(allAnswered(two, emptyDrafts(two))).toBe(false);
    expect(
      allAnswered(two, [
        { picked: ["a1"], otherText: "" },
        { picked: [], otherText: "" }
      ])
    ).toBe(false);
    expect(
      allAnswered(two, [
        { picked: ["a1"], otherText: "" },
        { picked: ["b1"], otherText: "" }
      ])
    ).toBe(true);
  });

  it("does not count Other with nothing typed in it", () => {
    expect(
      allAnswered(two, [
        { picked: [OTHER], otherText: "" },
        { picked: ["b1"], otherText: "" }
      ])
    ).toBe(false);
  });
});

describe("isAnswered", () => {
  it("marks a tab only once its question carries something", () => {
    expect(isAnswered(undefined)).toBe(false);
    expect(isAnswered({ picked: [], otherText: "" })).toBe(false);
    expect(isAnswered({ picked: [OTHER], otherText: "" })).toBe(false);
    expect(isAnswered({ picked: [OTHER], otherText: "x" })).toBe(true);
    expect(isAnswered({ picked: ["a1"], otherText: "" })).toBe(true);
  });
});
