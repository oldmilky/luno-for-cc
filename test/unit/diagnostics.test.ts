import { describe, it, expect } from "vitest";
import {
  formatDiagnostics,
  sortDiagnostics,
  type DiagnosticItem
} from "../../src/core/diagnostics.js";

function item(over: Partial<DiagnosticItem> = {}): DiagnosticItem {
  return {
    file: "src/a.ts",
    line: 1,
    column: 1,
    severity: "error",
    message: "Cannot find name 'x'",
    ...over
  };
}

describe("formatDiagnostics", () => {
  it("says nothing when the editor reports nothing", () => {
    expect(formatDiagnostics([])).toBeNull();
  });

  it("renders a diagnostic in the file:line:column shape compilers use", () => {
    const out = formatDiagnostics([item({ source: "ts(2304)" })]);

    expect(out).toContain(
      "src/a.ts:1:1 error [ts(2304)]: Cannot find name 'x'"
    );
  });

  // A truncated list has to keep the errors: warnings are what a user ignores
  // for weeks, and spending the cap on them would hide the breakage.
  it("puts errors before warnings", () => {
    const sorted = sortDiagnostics([
      item({ severity: "warning", file: "src/a.ts" }),
      item({ severity: "error", file: "src/z.ts" })
    ]);

    expect(sorted.map((d) => d.severity)).toEqual(["error", "warning"]);
  });

  it("caps the list and says what it left out", () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      item({ line: i + 1, severity: i < 10 ? "error" : "warning" })
    );

    const out = formatDiagnostics(many, 5) ?? "";

    expect(out.match(/src\/a\.ts:/g)).toHaveLength(5);
    expect(out).toContain("45 more not shown");
    expect(out).toContain("10 error(s), 40 warning(s)");
  });

  // Type checkers emit multi-line messages. Left alone they break the one
  // diagnostic per line shape the list is meant to be scanned by.
  it("folds a multi-line message onto one line", () => {
    const out = formatDiagnostics([
      item({ message: "Type 'A' is not assignable to 'B'.\n  Property 'x'…" })
    ]);

    expect(out).toContain("Type 'A' is not assignable to 'B'. Property 'x'…");
    expect(out?.split("\n").filter((l) => l.includes("src/a.ts"))).toHaveLength(
      1
    );
  });

  it("tells the model these are the editor's view, not proof", () => {
    const out = formatDiagnostics([item()]) ?? "";

    // The agent must not treat a stale diagnostic as ground truth, and it must
    // know not to shell out to a compiler to rediscover them.
    expect(out).toMatch(/language servers/i);
    expect(out).toMatch(/can be stale/i);
  });
});
