import { describe, it, expect } from "vitest";
import { fileTouchedByTool } from "../../src/ui/domains/checkpoint-triggers.js";

// A miss here does not throw — the file simply never enters the checkpoint,
// and the user discovers it when rewind fails to bring the file back. This was
// a private method on a class no test imported, so neither the tool-name list
// nor the path extraction had ever been exercised.

const call = (name: string, input: unknown) => ({
  kind: "tool_call",
  body: JSON.stringify(input),
  meta: { name }
});

describe("fileTouchedByTool", () => {
  it("recognises the tools Claude Code actually writes with", () => {
    for (const name of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) {
      expect(fileTouchedByTool(call(name, { file_path: "a.ts" })), name).toBe(
        "a.ts"
      );
    }
  });

  it("matches case-insensitively", () => {
    // The CLI's casing is not a contract; the gate lowercases before matching.
    expect(fileTouchedByTool(call("WRITE", { path: "a.ts" }))).toBe("a.ts");
    expect(fileTouchedByTool(call("wRiTe", { path: "a.ts" }))).toBe("a.ts");
  });

  it("keeps the legacy names a restored session can still replay", () => {
    // An old history file replays the tool names of its own era.
    for (const name of ["update", "create", "str_replace_editor"]) {
      expect(fileTouchedByTool(call(name, { path: "a.ts" })), name).toBe(
        "a.ts"
      );
    }
  });

  it("ignores tools that do not write", () => {
    for (const name of ["Read", "Grep", "Glob", "Bash", "WebFetch", "Task"]) {
      expect(fileTouchedByTool(call(name, { path: "a.ts" })), name).toBeNull();
    }
  });

  it("accepts all three spellings of the path key, in precedence order", () => {
    expect(fileTouchedByTool(call("Write", { path: "p" }))).toBe("p");
    expect(fileTouchedByTool(call("Write", { file_path: "fp" }))).toBe("fp");
    expect(fileTouchedByTool(call("Write", { filePath: "fP" }))).toBe("fP");
    // `path` wins when more than one is present.
    expect(
      fileTouchedByTool(call("Write", { path: "p", file_path: "fp" }))
    ).toBe("p");
  });

  it("returns null for a write with no usable path", () => {
    expect(fileTouchedByTool(call("Write", {}))).toBeNull();
    expect(fileTouchedByTool(call("Write", { path: "" }))).toBeNull();
    // A non-string path is not coerced — `String(42)` would snapshot a file
    // called "42" and hide the real problem.
    expect(fileTouchedByTool(call("Write", { path: 42 }))).toBeNull();
  });

  it("survives a malformed body instead of throwing", () => {
    // The body is JSON from a subprocess. Throwing here would take down the
    // listener the whole timeline flows through.
    expect(
      fileTouchedByTool({
        kind: "tool_call",
        body: "{not json",
        meta: { name: "Write" }
      })
    ).toBeNull();
    expect(
      fileTouchedByTool({ kind: "tool_call", meta: { name: "Write" } })
    ).toBeNull();
    expect(
      fileTouchedByTool({
        kind: "tool_call",
        body: "null",
        meta: { name: "Write" }
      })
    ).toBeNull();
  });

  it("ignores events that are not tool calls at all", () => {
    for (const kind of ["user", "assistant", "tool_result", "plan_revision"]) {
      expect(
        fileTouchedByTool({
          kind,
          body: JSON.stringify({ path: "a.ts" }),
          meta: { name: "Write" }
        }),
        kind
      ).toBeNull();
    }
  });

  it("returns null when the tool name is missing", () => {
    expect(
      fileTouchedByTool({
        kind: "tool_call",
        body: JSON.stringify({ path: "a" })
      })
    ).toBeNull();
  });
});
