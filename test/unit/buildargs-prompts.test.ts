import { describe, it, expect } from "vitest";
import { buildArgs } from "../../src/providers/cli/args.js";
import type { ConventionsFile } from "../../src/services/conventions.js";

// Which system-prompt appends go out, and in which order. The prompts
// themselves are covered by prompt-loader.test.ts; this is about assembly.

const base = { binary: "claude", cwd: "/tmp" } as const;

const CONVENTIONS: ConventionsFile = {
  source: "agents",
  absolutePath: "/tmp/AGENTS.md",
  workspaceRelativePath: "AGENTS.md",
  content: "# House style",
  // Not the CLI's own CLAUDE.md path, so LUNO injects it and the assertion
  // below can see it land.
  alreadyLoadedByCli: false,
  hasAlternative: false
};

/**
 * The pieces of the one `--append-system-prompt` argv carries.
 *
 * One flag, not several: the CLI keeps only the last value it is handed and
 * drops the rest — measured, see `SEPARATOR` in args.ts. Split back apart here
 * so presence and order still read the way they did when each piece had its
 * own flag.
 */
function appends(args: string[]): string[] {
  const i = args.indexOf("--append-system-prompt");
  if (i === -1) return [];
  // Exactly one, or the CLI is dropping something again.
  expect(args.filter((a) => a === "--append-system-prompt")).toHaveLength(1);
  return args[i + 1].split("\n\n---\n\n");
}

describe("buildArgs — system prompt appends", () => {
  it("hands the CLI exactly one append, carrying every piece", () => {
    // The defect this pins: the CLI keeps only the **last**
    // `--append-system-prompt` and silently drops the others. Measured
    // against 2.1.233 — two marked appends went in, the second came back,
    // and swapping their order swapped the answer. LUNO passed up to six, so
    // `common.md` reached the model in no mode at all, and the mode prompt
    // only when no project conventions followed it.
    const args = buildArgs("hi", "sonnet", {
      ...base,
      permissionMode: "plan",
      taskType: "backend",
      conventions: CONVENTIONS,
      disabledSkills: ["some-skill"]
    });

    expect(args.filter((a) => a === "--append-system-prompt")).toHaveLength(1);

    const blob = args[args.indexOf("--append-system-prompt") + 1];
    expect(blob).toContain("# LUNO");
    expect(blob).toContain("some-skill");
    expect(blob).toContain("Project conventions from");
  });

  it("sends the common prompt in every mode", () => {
    for (const permissionMode of [
      "default",
      "acceptEdits",
      "auto",
      "plan",
      "bypass"
    ] as const) {
      const sent = appends(
        buildArgs("hi", "sonnet", { ...base, permissionMode })
      );
      expect(sent.some((a) => a.startsWith("# LUNO"))).toBe(true);
    }
  });

  it("puts the common prompt before the mode prompt", () => {
    // The mode file is written as an amendment — "the mode prompt that follows
    // says only what its posture changes" — so the order is part of the text.
    const sent = appends(
      buildArgs("hi", "sonnet", { ...base, permissionMode: "bypass" })
    );
    const common = sent.findIndex((a) => a.startsWith("# LUNO"));
    const mode = sent.findIndex((a) => a.startsWith("# Bypass mode"));
    expect(common).toBeGreaterThanOrEqual(0);
    expect(mode).toBeGreaterThan(common);
  });

  it("sends the task-type playbook in plan mode when the project has no conventions", () => {
    const sent = appends(
      buildArgs("hi", "sonnet", {
        ...base,
        permissionMode: "plan",
        taskType: "backend"
      })
    );
    expect(sent.some((a) => a.startsWith("# Backend work"))).toBe(true);
  });

  it("withholds the playbook once the project has conventions of its own", () => {
    // A CLAUDE.md says what matters here far more precisely than a generic
    // checklist; landing both makes the vague one compete with the exact one.
    const sent = appends(
      buildArgs("hi", "sonnet", {
        ...base,
        permissionMode: "plan",
        taskType: "backend",
        conventions: CONVENTIONS
      })
    );
    expect(sent.some((a) => a.startsWith("# Backend work"))).toBe(false);
    expect(sent.some((a) => a.includes("House style"))).toBe(true);
  });

  it("never sends a playbook outside plan mode", () => {
    for (const permissionMode of ["default", "acceptEdits", "auto"] as const) {
      const sent = appends(
        buildArgs("hi", "sonnet", {
          ...base,
          permissionMode,
          taskType: "backend"
        })
      );
      expect(sent.some((a) => a.startsWith("# Backend work"))).toBe(false);
    }
  });
});
