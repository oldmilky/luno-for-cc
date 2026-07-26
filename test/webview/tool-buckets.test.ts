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

  it("sniffs the bash command to sub-classify shell calls", () => {
    expect(classifyTool("Bash", JSON.stringify({ command: "find . -name x" }))).toBe("explore");
    expect(classifyTool("Bash", JSON.stringify({ command: "rg pattern" }))).toBe("search");
    expect(classifyTool("Bash", JSON.stringify({ command: "cat file.ts" }))).toBe("read");
    expect(classifyTool("Bash", JSON.stringify({ command: "npm test" }))).toBe("run");
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
