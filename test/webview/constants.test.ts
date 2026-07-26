import { describe, it, expect } from "vitest";
import {
  findEffort,
  findMode,
  findModel,
  FALLBACK_MODELS,
  EFFORT_LEVELS,
  MODES
} from "../../webview/src/features/chat/constants.js";

describe("findEffort", () => {
  it("returns the matching effort option", () => {
    expect(findEffort("low").short).toBe("Low");
    expect(findEffort("max").label).toBe("Max");
  });
  it("defaults to 'high' (index 2) for unknown / undefined", () => {
    expect(findEffort(undefined).value).toBe("high");
    expect(findEffort("bogus").value).toBe("high");
    expect(EFFORT_LEVELS[2].value).toBe("high");
  });
});

describe("findMode", () => {
  it("returns the matching mode option", () => {
    expect(findMode("plan").label).toBe("Plan");
    expect(findMode("auto").label).toBe("Agent");
  });
  it("defaults to the first mode (default/Ask) for unknown / undefined", () => {
    expect(findMode(undefined).value).toBe("default");
    expect(findMode("bogus").value).toBe("default");
    expect(MODES[0].value).toBe("default");
  });
});

describe("findModel", () => {
  it("returns a model from the provided list when present", () => {
    expect(findModel(FALLBACK_MODELS, "opus").label).toBe("Opus");
  });
  it("synthesizes a 'version' entry with a shortened label when not in the list", () => {
    const m = findModel([], "claude-sonnet-4-6-20250101");
    expect(m.group).toBe("version");
    // shortModel strips the 'claude-' prefix and trailing -YYYYMMDD date.
    expect(m.label).toBe("sonnet-4-6");
    expect(m.supportsTools).toBe(true);
  });
  it("handles an undefined value without throwing", () => {
    const m = findModel(FALLBACK_MODELS, undefined);
    expect(m.value).toBe("");
  });
});
