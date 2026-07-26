import { describe, it, expect } from "vitest";
import {
  collapseWhitespace,
  truncate,
  compactPath
} from "../../webview/src/features/plan/utils.js";

describe("collapseWhitespace", () => {
  it("collapses runs of whitespace to single spaces and trims", () => {
    expect(collapseWhitespace("  a\n\t b ")).toBe("a b");
    expect(collapseWhitespace("one   two")).toBe("one two");
  });
});

describe("truncate", () => {
  it("returns the flattened string unchanged when within the limit", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });
  it("appends an ellipsis when over the limit", () => {
    expect(truncate("hello world", 5)).toBe("hell…");
  });
  it("collapses whitespace before measuring length", () => {
    expect(truncate("a    b", 10)).toBe("a b");
  });
});

describe("compactPath", () => {
  it("leaves short paths (<= 3 segments) unchanged", () => {
    expect(compactPath("/a/b")).toBe("/a/b");
    expect(compactPath("a/b/c")).toBe("a/b/c");
  });
  it("compacts the middle of long RELATIVE paths correctly", () => {
    expect(compactPath("a/b/c/d.md")).toBe("a/…/c/d.md");
  });

  // KNOWN BUG: for an ABSOLUTE path, split("/") yields a leading "" segment,
  // so parts[0]||"/" becomes "/" and the result gains a doubled slash
  // ("//…/c/d.md"). The function's own docstring claims "/a/b/c/d.md" →
  // "/a/…/c/d.md". Workspace paths in this extension are absolute, so this is
  // the common case. See webview/src/features/plan/utils.ts:20-24.
  it("documents the actual (buggy) double-slash output for absolute paths", () => {
    expect(compactPath("/a/b/c/d.md")).toBe("//…/c/d.md");
  });
  it.fails("should match its docstring contract for absolute paths", () => {
    expect(compactPath("/a/b/c/d.md")).toBe("/a/…/c/d.md");
  });
});
