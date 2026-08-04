import { describe, expect, it } from "vitest";

import {
  answersFromApproval,
  INTERACTIVE_TOOLS
} from "../../src/core/permission-policy.js";

// The answers the user picked reach the model as the tool's own input, so an
// approved request is the only place they exist. Everything below is about
// telling that apart from the several other shapes an approval can have.
describe("reading answers back off an approval", () => {
  const answers = { "Which one?": "the first" };

  it("takes them from an allowed interactive tool", () => {
    expect(
      answersFromApproval("allow", "AskUserQuestion", { answers })
    ).toEqual(answers);
  });

  it("takes nothing from a denial — there is nothing to answer with", () => {
    expect(
      answersFromApproval("deny", "AskUserQuestion", { answers })
    ).toBeUndefined();
  });

  it("takes nothing when the approval carries no updated input", () => {
    expect(
      answersFromApproval("allow", "AskUserQuestion", undefined)
    ).toBeUndefined();
  });

  // A Write's `updatedInput` is a file path and its contents. Reading `answers`
  // off it would find nothing today and something wrong the day a tool happens
  // to name a field that.
  it("takes nothing from a tool whose request is not a question", () => {
    expect(
      answersFromApproval("allow", "Write", { answers, file_path: "a.ts" })
    ).toBeUndefined();
  });

  it("takes nothing when the request was never recorded", () => {
    expect(
      answersFromApproval("allow", undefined, { answers })
    ).toBeUndefined();
  });

  // Each of these is the CLI having changed a schema we would then be
  // misreading, which is worse than reading nothing.
  it.each([
    ["absent", {}],
    ["null", { answers: null }],
    ["an array", { answers: ["the first"] }],
    ["a string", { answers: "the first" }]
  ])("takes nothing when `answers` is %s", (_shape, input) => {
    expect(
      answersFromApproval("allow", "AskUserQuestion", input)
    ).toBeUndefined();
  });

  // The keying is the point: a second interactive tool added to the set must
  // not have its answers silently dropped here.
  it("follows the interactive-tool set rather than a hard-coded name", () => {
    for (const tool of INTERACTIVE_TOOLS) {
      expect(answersFromApproval("allow", tool, { answers })).toEqual(answers);
    }
  });
});
