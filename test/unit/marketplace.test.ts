import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { installRoot } from "../../src/services/marketplace.js";

// installRoot is the path-traversal guard that decides where a marketplace
// skill is written / removed. Security-relevant, so we lock the guard.

describe("marketplace installRoot path-traversal guard", () => {
  it("resolves a clean name under ~/.claude/skills for user scope", () => {
    expect(installRoot("my-skill", "user", undefined)).toBe(
      path.join(os.homedir(), ".claude", "skills", "my-skill")
    );
  });

  it("resolves a clean name under <workspace>/.claude/skills for project scope", () => {
    expect(installRoot("my-skill", "project", "/ws")).toBe(
      path.join("/ws", ".claude", "skills", "my-skill")
    );
  });

  it("returns null for project scope with no workspace open", () => {
    expect(installRoot("my-skill", "project", undefined)).toBeNull();
  });

  it("rejects names containing a forward slash", () => {
    expect(installRoot("a/b", "user", "/ws")).toBeNull();
    expect(installRoot("../evil", "user", "/ws")).toBeNull();
  });

  it("rejects names containing a backslash", () => {
    expect(installRoot("a\\b", "user", "/ws")).toBeNull();
    expect(installRoot("..\\evil", "user", "/ws")).toBeNull();
  });

  it("rejects '.' and '..'", () => {
    expect(installRoot(".", "user", "/ws")).toBeNull();
    expect(installRoot("..", "user", "/ws")).toBeNull();
  });

  it("rejects an empty name", () => {
    expect(installRoot("", "user", "/ws")).toBeNull();
  });
});
