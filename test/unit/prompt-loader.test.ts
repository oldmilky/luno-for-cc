import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

import {
  getCommonPrompt,
  getModePrompt,
  getTaskTypePrompt
} from "../../src/services/prompt-loader.js";

const MODES = ["plan", "default", "acceptEdits", "auto", "bypass"] as const;

describe("getCommonPrompt", () => {
  it("teaches the link format the renderer now honours", () => {
    // markdown-links.ts routes a relative href to `openFile`. Teaching the
    // format is half of that feature; without it the model writes plain paths
    // and nothing is clickable.
    const md = getCommonPrompt();
    expect(md).toMatch(/\]\(src\/core\/session\.ts#L42\)/);
    expect(md).toMatch(/workspace root/);
  });

  it("carries the rules that used to be copied into every mode", () => {
    const md = getCommonPrompt();
    expect(md).toMatch(/AskUserQuestion/);
    expect(md).toMatch(/conventions/i);
    expect(md).toMatch(/no preamble/i);
  });
});

describe("getModePrompt", () => {
  it("returns non-empty content for each mode", () => {
    for (const mode of MODES) {
      expect(getModePrompt(mode).length).toBeGreaterThan(0);
    }
  });

  it("leaves the shared rules to the common prompt", () => {
    // The point of common.md. A mode file restating it is how the two drift
    // until they contradict each other, and only one of them gets fixed.
    for (const mode of MODES) {
      expect(getModePrompt(mode)).not.toMatch(/AskUserQuestion/);
    }
  });

  it("tells acceptEdits that only the edits are free", () => {
    const md = getModePrompt("acceptEdits").toLowerCase();
    expect(md).toMatch(/edits apply without asking/);
    expect(md).toMatch(/card/);
  });

  it("warns auto mode that destructive calls still surface a card", () => {
    // `decidePermission` wraps every auto-allow branch in `!destructive &&
    // !network`, so this holds however the CLI's classifier votes. A model
    // that believed otherwise would report a delete as done while it waits.
    const md = getModePrompt("auto").toLowerCase();
    expect(md).toMatch(/destructive and network calls still surface a card/);
  });

  it("tells plan mode the five sections and where the steps come from", () => {
    const md = getModePrompt("plan");
    for (const section of [
      "Context",
      "Approach",
      "Conventions",
      "Risks",
      "Verification"
    ]) {
      expect(md).toMatch(new RegExp(`## ${section}`));
    }
    // Steps reach the plan card through TodoWrite, and a file reference inside
    // a step's text becomes a jump on that card.
    expect(md).toMatch(/TodoWrite/);
    expect(md).toMatch(/ExitPlanMode/);
  });

  it("no longer warns about a parser that is not that strict", () => {
    // `matchSectionHeading` matches the keyword anywhere in the heading, so
    // "Potential Risks" was never at risk of a missing-section badge. The old
    // prompt spent a paragraph on it.
    expect(getModePrompt("plan")).not.toMatch(/false "missing section"/);
  });
});

describe("getTaskTypePrompt", () => {
  it("returns null for generic", () => {
    expect(getTaskTypePrompt("generic")).toBeNull();
  });

  it("returns content for each task type", () => {
    for (const t of [
      "backend",
      "frontend",
      "fullstack",
      "devops",
      "integration",
      "docs-driven",
      "refactor",
      "bugfix",
      "migration",
      "new-impl"
    ] as const) {
      expect(getTaskTypePrompt(t)?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("says it is a stand-in for conventions the project never wrote", () => {
    // buildArgs only sends these when no conventions file is loaded. The file
    // has to say so, or the model treats generic advice as house style.
    for (const t of ["backend", "frontend", "bugfix"] as const) {
      expect(getTaskTypePrompt(t)).toMatch(/no conventions of its own/);
    }
  });
});

describe("LUNO_PROMPTS_DIR override", () => {
  let tmpDir: string;
  const original = process.env.LUNO_PROMPTS_DIR;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "luno-prompts-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (original === undefined) delete process.env.LUNO_PROMPTS_DIR;
    else process.env.LUNO_PROMPTS_DIR = original;
  });

  it("reads mode prompt from disk when env var is set", () => {
    fs.writeFileSync(path.join(tmpDir, "auto-mode.md"), "OVERRIDE_AUTO");
    process.env.LUNO_PROMPTS_DIR = tmpDir;
    expect(getModePrompt("auto")).toBe("OVERRIDE_AUTO");
  });

  it("finds the kebab-case file for acceptEdits", () => {
    // The mode id is camelCase and the file is not. Deriving the name from the
    // id looked for `acceptEdits-mode.md`, so this one mode silently ignored
    // the override.
    fs.writeFileSync(
      path.join(tmpDir, "accept-edits-mode.md"),
      "OVERRIDE_EDITS"
    );
    process.env.LUNO_PROMPTS_DIR = tmpDir;
    expect(getModePrompt("acceptEdits")).toBe("OVERRIDE_EDITS");
  });

  it("reads the common prompt from disk when env var is set", () => {
    fs.writeFileSync(path.join(tmpDir, "common.md"), "OVERRIDE_COMMON");
    process.env.LUNO_PROMPTS_DIR = tmpDir;
    expect(getCommonPrompt()).toBe("OVERRIDE_COMMON");
  });

  it("falls back to bundled when override file is missing", () => {
    process.env.LUNO_PROMPTS_DIR = tmpDir;
    expect(getModePrompt("plan").length).toBeGreaterThan(0);
    expect(getCommonPrompt().length).toBeGreaterThan(0);
  });

  it("reads task-type prompt from disk when env var is set", () => {
    fs.mkdirSync(path.join(tmpDir, "task-types"));
    fs.writeFileSync(
      path.join(tmpDir, "task-types", "backend.md"),
      "OVERRIDE_BACKEND"
    );
    process.env.LUNO_PROMPTS_DIR = tmpDir;
    expect(getTaskTypePrompt("backend")).toBe("OVERRIDE_BACKEND");
  });
});
