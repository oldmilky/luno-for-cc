import { describe, it, expect } from "vitest";
import {
  allowedModels,
  enforcedDefaultModel,
  isModelAllowed,
  permittedModel
} from "../../src/core/model-allowlist.js";

const picker = [
  { value: "default" },
  { value: "fable" },
  { value: "opus" },
  { value: "sonnet" },
  { value: "haiku" },
  { value: "claude-opus-4-5-20260101" },
  { value: "claude-sonnet-4-6" }
];

describe("isModelAllowed — the three kinds the schema names", () => {
  it("lets everything through when no policy names a model", () => {
    // Absence is not a restriction, and treating it as one would break every
    // machine that has no administrator at all.
    expect(isModelAllowed("opus", undefined)).toBe(true);
    expect(isModelAllowed("anything", undefined)).toBe(true);
  });

  it("reads an empty list as “default only”, not as “no restriction”", () => {
    // READ from the schema, and the reading a reimplementation gets wrong:
    // "If empty array, only the default model is available."
    expect(isModelAllowed("default", [])).toBe(true);
    expect(isModelAllowed("opus", [])).toBe(false);
    expect(isModelAllowed("sonnet", [])).toBe(false);
  });

  it("takes a family alias as covering any version of it", () => {
    expect(isModelAllowed("opus", ["opus"])).toBe(true);
    expect(isModelAllowed("claude-opus-4-5", ["claude-opus"])).toBe(true);
    expect(isModelAllowed("sonnet", ["opus"])).toBe(false);
  });

  it("takes a version prefix as covering only that version", () => {
    expect(isModelAllowed("opus-4-5-20260101", ["opus-4-5"])).toBe(true);
    expect(isModelAllowed("opus-4-1", ["opus-4-5"])).toBe(false);
  });

  it("does not let a prefix run past a version boundary", () => {
    // `opus-4` must not cover `opus-40`, which is a different model entirely.
    expect(isModelAllowed("opus-40", ["opus-4"])).toBe(false);
    expect(isModelAllowed("opus-4-5", ["opus-4"])).toBe(true);
  });

  it("takes a full id as covering only itself", () => {
    const id = "claude-opus-4-5-20260101";
    expect(isModelAllowed(id, [id])).toBe(true);
    expect(isModelAllowed("claude-opus-4-5-20260202", [id])).toBe(false);
  });

  it("ignores case and surrounding space, which hand-edited files carry", () => {
    expect(isModelAllowed("OPUS", ["  opus  "])).toBe(true);
  });

  it("leaves Default selectable under a non-empty policy", () => {
    // `default` is a pointer to a model rather than one, and it is where the
    // picker starts. Removing it would leave a picker with no valid state.
    expect(isModelAllowed("default", ["opus"])).toBe(true);
  });
});

describe("allowedModels — the picker after the policy", () => {
  it("shows everything when there is no policy", () => {
    expect(allowedModels(picker, undefined)).toHaveLength(picker.length);
  });

  it("keeps only what an administrator allowed", () => {
    expect(allowedModels(picker, ["sonnet"]).map((m) => m.value)).toEqual([
      "default",
      "sonnet",
      "claude-sonnet-4-6"
    ]);
  });

  it("narrows to Default alone on an empty policy", () => {
    expect(allowedModels(picker, []).map((m) => m.value)).toEqual(["default"]);
  });

  it("never hands back an empty picker", () => {
    // A picker with nothing in it is a broken panel. The honest floor is the
    // one selection every policy leaves standing.
    const out = allowedModels(picker, ["nothing-matches-this"]);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].value).toBe("default");
  });
});

describe("enforcedDefaultModel", () => {
  it("does nothing unless enforcement is switched on", () => {
    expect(enforcedDefaultModel(["opus"], false)).toBeNull();
    expect(enforcedDefaultModel(["opus"], undefined)).toBeNull();
  });

  it("does nothing when there is no list to enforce", () => {
    // READ: "Has no effect when availableModels is unset or an empty array."
    expect(enforcedDefaultModel(undefined, true)).toBeNull();
    expect(enforcedDefaultModel([], true)).toBeNull();
  });

  it("points Default at the first allowed entry", () => {
    expect(enforcedDefaultModel(["opus", "sonnet"], true)).toBe("opus");
  });
});

describe("permittedModel — a choice made before the policy arrived", () => {
  it("leaves an allowed choice alone", () => {
    expect(permittedModel("sonnet", ["sonnet", "opus"], false)).toBe("sonnet");
  });

  it("falls back rather than running a model the policy forbids", () => {
    // The same override the picker filter exists to prevent, arriving through
    // a settings file written before the policy did.
    expect(permittedModel("opus", ["sonnet"], false)).toBe("default");
  });

  it("falls back to the enforced default when there is one", () => {
    expect(permittedModel("opus", ["sonnet"], true)).toBe("sonnet");
  });

  it("redirects Default itself only when enforcement says to", () => {
    expect(permittedModel("default", ["sonnet"], false)).toBe("default");
    expect(permittedModel("default", ["sonnet"], true)).toBe("sonnet");
  });

  it("passes anything through when no policy exists", () => {
    expect(permittedModel("opus", undefined, false)).toBe("opus");
    expect(permittedModel(undefined, undefined, false)).toBeUndefined();
  });
});
