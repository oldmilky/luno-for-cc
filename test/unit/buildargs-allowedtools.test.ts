import { describe, it, expect } from "vitest";
import {
  buildArgs,
  respawnFingerprint
} from "../../src/providers/claude-cli.js";

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

// The editor's Problems ride along as their own `--append-system-prompt`, so
// they can be dropped without disturbing the mode or conventions prompts.
describe("buildArgs diagnostics", () => {
  /** Every `--append-system-prompt` value, in order. */
  function appends(args: string[]): string[] {
    const out: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--append-system-prompt") out.push(args[i + 1]);
    }
    return out;
  }

  it("passes the editor's problems to the CLI", () => {
    const args = buildArgs("hi", "sonnet", {
      ...base,
      diagnostics: "# Problems currently reported in the editor\n\na.ts:1:1 …"
    });

    expect(appends(args).some((a) => a.includes("Problems"))).toBe(true);
  });

  it("adds no argument at all when there is nothing to report", () => {
    const withNone = buildArgs("hi", "sonnet", { ...base, diagnostics: null });
    const without = buildArgs("hi", "sonnet", { ...base });

    expect(appends(withNone)).toEqual(appends(without));
  });
});

/** The value after a flag, or undefined when the flag is absent. */
function after(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

describe("buildArgs — the argv-shaped settings", () => {
  it("adds no flag at all when nothing is configured", () => {
    // Every user's default. A flag with nothing after it is worse than none.
    const args = buildArgs("hi", "sonnet", { ...base });
    for (const flag of [
      "--add-dir",
      "--fallback-model",
      "--max-budget-usd",
      "--name",
      "--safe-mode"
    ]) {
      expect(args).not.toContain(flag);
    }
  });

  it("passes every extra directory after one --add-dir", () => {
    const args = buildArgs("hi", "sonnet", {
      ...base,
      additionalDirectories: ["/w/lib", "/w/docs"]
    });
    const i = args.indexOf("--add-dir");
    expect(args.slice(i + 1, i + 3)).toEqual(["/w/lib", "/w/docs"]);
  });

  it("passes fallbacks as one comma-separated value", () => {
    const args = buildArgs("hi", "sonnet", {
      ...base,
      model: "sonnet",
      fallbackModels: ["opus", "haiku"]
    });
    expect(after(args, "--fallback-model")).toBe("opus,haiku");
    // One flag, not one per model.
    expect(args.filter((a) => a === "--fallback-model")).toHaveLength(1);
  });

  it("omits a budget of zero rather than capping every turn at nothing", () => {
    expect(buildArgs("hi", "s", { ...base, maxBudgetUsd: 0 })).not.toContain(
      "--max-budget-usd"
    );
    expect(
      after(
        buildArgs("hi", "s", { ...base, maxBudgetUsd: 4 }),
        "--max-budget-usd"
      )
    ).toBe("4");
  });

  it("names the session for the CLI's own /resume picker", () => {
    expect(
      after(
        buildArgs("hi", "s", { ...base, sessionName: "Fix the parser" }),
        "--name"
      )
    ).toBe("Fix the parser");
  });

  it("turns customizations off only when asked", () => {
    expect(buildArgs("hi", "s", { ...base, safeMode: true })).toContain(
      "--safe-mode"
    );
    expect(buildArgs("hi", "s", { ...base, safeMode: false })).not.toContain(
      "--safe-mode"
    );
  });

  it("does not replace a live process when the chat is renamed", () => {
    // The name is what `/resume` shows in a terminal. Nothing about a running
    // turn depends on it, and respawning would take any live agent with it.
    const before = buildArgs("hi", "s", { ...base, sessionName: "one" });
    const after2 = buildArgs("hi", "s", { ...base, sessionName: "two" });
    expect(respawnFingerprint(before)).toBe(respawnFingerprint(after2));
  });

  it("does replace it when the folders the agent can see change", () => {
    // The opposite case, and it has to be the opposite: a running CLI cannot
    // be told about a folder it was not spawned with.
    const before = buildArgs("hi", "s", { ...base });
    const after2 = buildArgs("hi", "s", {
      ...base,
      additionalDirectories: ["/w/lib"]
    });
    expect(respawnFingerprint(before)).not.toBe(respawnFingerprint(after2));
  });
});
