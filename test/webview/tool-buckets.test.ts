import { describe, it, expect } from "vitest";
import {
  classifyTool,
  bucketSummary,
  bucketMeta,
  formatDuration
} from "../../webview/src/features/chat/tool-buckets.js";

describe("classifyTool", () => {
  it("maps core tool names to buckets", () => {
    expect(classifyTool("Read")).toBe("read");
    expect(classifyTool("Grep")).toBe("search");
    expect(classifyTool("Glob")).toBe("explore");
    expect(classifyTool("Edit")).toBe("edit");
    expect(classifyTool("MultiEdit")).toBe("edit");
    expect(classifyTool("Write")).toBe("edit");
    expect(classifyTool("WebFetch")).toBe("web");
    expect(classifyTool("Task")).toBe("task");
    expect(classifyTool("Skill")).toBe("skill");
    expect(classifyTool("SomethingElse")).toBe("other");
  });

  // `Task` is the legacy name and only stored sessions still carry it. Counted
  // across the transcripts on disk: `Agent` 219, `Workflow` 71, `Task` none —
  // so matching the legacy name alone left this bucket dead and rendered a
  // dispatch as "Ran Agent".
  it("knows the names the shipped CLI actually dispatches under", () => {
    expect(classifyTool("Agent")).toBe("task");
    expect(classifyTool("Workflow")).toBe("task");
  });

  it("sniffs the bash command to sub-classify shell calls", () => {
    expect(
      classifyTool("Bash", JSON.stringify({ command: "find . -name x" }))
    ).toBe("explore");
    expect(
      classifyTool("Bash", JSON.stringify({ command: "rg pattern" }))
    ).toBe("search");
    expect(
      classifyTool("Bash", JSON.stringify({ command: "cat file.ts" }))
    ).toBe("read");
    expect(classifyTool("Bash", JSON.stringify({ command: "npm test" }))).toBe(
      "run"
    );
  });

  // Measured against a real install: `mcp__luno_ide__openFile` moved the
  // user's editor to another file and the timeline said "Read editor.ts",
  // indistinguishable from a passive read — the generic `open` rule caught it.
  it("keeps the focus-stealing editor tools out of the read bucket", () => {
    expect(classifyTool("mcp__luno_ide__openFile")).toBe("editor");
    expect(classifyTool("mcp__luno_ide__openDiff")).toBe("editor");
  });

  it("leaves the rest of the editor tools generic rather than calling them reads", () => {
    expect(classifyTool("mcp__luno_ide__getOpenEditors")).toBe("other");
    expect(classifyTool("mcp__luno_ide__getDiagnostics")).toBe("other");
    expect(classifyTool("mcp__luno_ide__saveDocument")).toBe("other");
    expect(classifyTool("mcp__luno_ide__closeAllDiffTabs")).toBe("other");
  });

  it("treats a bash call with no/unparseable command as a generic run", () => {
    expect(classifyTool("Bash")).toBe("run");
    expect(classifyTool("Bash", "{bad json")).toBe("run");
  });
});

describe("bucketSummary", () => {
  it("uses singular nouns for a count of 1", () => {
    expect(bucketSummary("read", 1)).toBe("Read 1 file");
    expect(bucketSummary("search", 1)).toBe("Searched 1 pattern");
  });
  it("uses plural nouns for counts > 1", () => {
    expect(bucketSummary("read", 3)).toBe("Read 3 files");
    expect(bucketSummary("explore", 2)).toBe("Explored 2 folders");
  });
});

describe("bucketMeta", () => {
  it("returns the verb/noun metadata for a bucket", () => {
    expect(bucketMeta("search").verb).toBe("Searched");
    expect(bucketMeta("edit").nounPlural).toBe("files");
    expect(bucketMeta("editor").verb).toBe("Opened");
  });
});

describe("formatDuration", () => {
  it("formats sub-second / seconds / minutes correctly", () => {
    expect(formatDuration(500)).toBe("<1s");
    expect(formatDuration(2_000)).toBe("2s");
    expect(formatDuration(47_000)).toBe("47s");
    expect(formatDuration(72_000)).toBe("1m 12s");
    expect(formatDuration(240_000)).toBe("4m");
  });
});
