import { describe, expect, it } from "vitest";

import { CYCLE_ORDER, nextCycleMode } from "../../src/core/permission-cycle.js";
import type { PermissionMode } from "../../src/core/types.js";

// The safety property under test is not "the cycle is in this order" — it is
// that Shift+Tab cannot land on a mode with no approval gate. A future mode
// added to CYCLE_ORDER by mistake should fail here rather than in the field.
describe("permission mode cycle", () => {
  it("never yields bypass, from any starting point", () => {
    const starts: PermissionMode[] = ["default", "plan", "auto", "bypass"];
    for (const start of starts) {
      let mode = start;
      // One full lap plus one, so a cycle of any length is covered.
      for (let i = 0; i <= CYCLE_ORDER.length + 1; i++) {
        mode = nextCycleMode(mode);
        expect(mode).not.toBe("bypass");
      }
    }
  });

  it("does not list bypass as cyclable", () => {
    expect(CYCLE_ORDER).not.toContain("bypass");
  });

  it("walks default → plan → auto → default", () => {
    expect(nextCycleMode("default")).toBe("plan");
    expect(nextCycleMode("plan")).toBe("auto");
    expect(nextCycleMode("auto")).toBe("default");
  });

  it("escapes bypass to the first cyclable mode", () => {
    expect(nextCycleMode("bypass")).toBe(CYCLE_ORDER[0]);
  });

  it("recovers from a mode hand-edited into settings", () => {
    expect(nextCycleMode("acceptEdits" as PermissionMode)).toBe(CYCLE_ORDER[0]);
  });

  it("returns to the start after a full lap", () => {
    let mode: PermissionMode = CYCLE_ORDER[0];
    for (let i = 0; i < CYCLE_ORDER.length; i++) mode = nextCycleMode(mode);
    expect(mode).toBe(CYCLE_ORDER[0]);
  });
});
