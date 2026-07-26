import { describe, it, expect } from "vitest";
import { buildArgs } from "../../src/providers/claude-cli.js";

// Focused on the auto-mode tool pre-allow list. The existing claude-cli.test.ts
// only checks a simple "^npm test$" pattern's presence; these exercise the
// regex→CLI-pattern translation with the DEFAULT config patterns (which use
// alternation) and the MCP server pre-allow paths.

const base = { binary: "claude", cwd: "/tmp" } as const;

function allowedToolsArgs(args: string[]): string[] {
  const i = args.indexOf("--allowedTools");
  if (i === -1) return [];
  // Everything after --allowedTools up to the next flag.
  const out: string[] = [];
  for (let j = i + 1; j < args.length; j++) {
    if (args[j].startsWith("--")) break;
    out.push(args[j]);
  }
  return out;
}

describe("buildArgs auto-mode allowedTools", () => {
  it("pre-allows the standard read/edit tools in auto mode", () => {
    const args = buildArgs("hi", "sonnet", {
      ...base,
      permissionMode: "auto",
      allowedBashPatterns: ["^npm test$"]
    });
    const tools = allowedToolsArgs(args);
    for (const t of ["Read", "Glob", "Grep", "Edit", "Write"]) {
      expect(tools).toContain(t);
    }
  });

  it("pre-allows connected MCP servers as mcp__<server> in auto mode", () => {
    const args = buildArgs("hi", "sonnet", {
      ...base,
      permissionMode: "auto",
      mcpServerNames: ["linear", "notion"]
    });
    const tools = allowedToolsArgs(args);
    expect(tools).toContain("mcp__linear");
    expect(tools).toContain("mcp__notion");
  });

  it("pre-allows MCP servers in DEFAULT mode too (explicit consent grant)", () => {
    const args = buildArgs("hi", "sonnet", {
      ...base,
      permissionMode: "default",
      mcpServerNames: ["linear"]
    });
    const tools = allowedToolsArgs(args);
    expect(tools).toContain("mcp__linear");
  });

  // ───────────────────────────────────────────────────────────
  // The shipped default config uses regex alternation:
  //   "^git (status|diff|log|branch)$", "^npm (test|run test)$"
  // The CLI's --allowedTools Bash(<pattern>) matches a literal command, NOT a
  // regex, so each alternation must be EXPANDED into separate literal patterns
  // or it never matches (verified end-to-end against the bundled CLI).
  // ───────────────────────────────────────────────────────────
  it("expands regex alternation in the default config patterns into literals", () => {
    const args = buildArgs("hi", "sonnet", {
      ...base,
      permissionMode: "auto",
      allowedBashPatterns: [
        "^git (status|diff|log|branch)$",
        "^npm (test|run test)$"
      ]
    });
    const tools = allowedToolsArgs(args);
    for (const t of [
      "Bash(git status)",
      "Bash(git diff)",
      "Bash(git log)",
      "Bash(git branch)",
      "Bash(npm test)",
      "Bash(npm run test)"
    ]) {
      expect(tools).toContain(t);
    }
    // The un-expanded regex form must NOT survive.
    expect(tools).not.toContain("Bash(npm (test|run test))");
  });

  it("never pre-allows destructive or network commands, even if allow-listed", () => {
    const args = buildArgs("hi", "sonnet", {
      ...base,
      permissionMode: "auto",
      // A user who (unwisely) allow-lists dangerous + network commands.
      allowedBashPatterns: ["^rm .*$", "^git push$", "^curl .*$", "^npm test$"]
    });
    const tools = allowedToolsArgs(args);
    // The safe one survives…
    expect(tools).toContain("Bash(npm test)");
    // …but the dangerous / network ones are dropped (they'll surface the card).
    expect(tools.some((t) => t.startsWith("Bash(rm"))).toBe(false);
    expect(tools).not.toContain("Bash(git push)");
    expect(tools.some((t) => t.startsWith("Bash(curl"))).toBe(false);
  });

  it("auto-approve patterns translate to literal CLI globs (no regex alternation)", () => {
    const args = buildArgs("hi", "sonnet", {
      ...base,
      permissionMode: "auto",
      allowedBashPatterns: ["^npm (test|run test)$"]
    });
    const bash = allowedToolsArgs(args).filter((t) => t.startsWith("Bash("));
    for (const b of bash) {
      expect(b.includes("|")).toBe(false);
    }
  });

  it("translates a simple anchored pattern by stripping the anchors", () => {
    const args = buildArgs("hi", "sonnet", {
      ...base,
      permissionMode: "auto",
      allowedBashPatterns: ["^npm test$"]
    });
    const tools = allowedToolsArgs(args);
    expect(tools).toContain("Bash(npm test)");
  });
});
