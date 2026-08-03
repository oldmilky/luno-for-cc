import { describe, it, expect } from "vitest";
import { formatDuration } from "../../webview/src/lib/format.js";

describe("formatDuration", () => {
  it("formats sub-second / seconds / minutes correctly", () => {
    expect(formatDuration(500)).toBe("<1s");
    expect(formatDuration(2_000)).toBe("2s");
    expect(formatDuration(47_000)).toBe("47s");
    expect(formatDuration(72_000)).toBe("1m 12s");
    expect(formatDuration(240_000)).toBe("4m");
  });
});
