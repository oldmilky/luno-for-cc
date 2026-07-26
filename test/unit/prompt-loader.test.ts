import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

import {
  getModePrompt,
  getTaskTypePrompt
} from "../../src/services/prompt-loader.js";

describe("getModePrompt", () => {
  it("returns non-empty content for each mode", () => {
    expect(getModePrompt("plan").length).toBeGreaterThan(0);
    expect(getModePrompt("default").length).toBeGreaterThan(0);
    expect(getModePrompt("auto").length).toBeGreaterThan(0);
  });

  it("plan-mode prompt mentions structured sections", () => {
    const md = getModePrompt("plan");
    expect(md).toMatch(/Context/);
    expect(md).toMatch(/Approach/);
    expect(md).toMatch(/Risks/);
    expect(md).toMatch(/Verification/);
  });

  it("auto-mode prompt instructs no preamble", () => {
    const md = getModePrompt("auto");
    expect(md.toLowerCase()).toMatch(/no preamble/);
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
      "integration",
      "docs-driven",
      "refactor"
    ] as const) {
      const md = getTaskTypePrompt(t);
      expect(md).toBeTruthy();
      expect(md!.length).toBeGreaterThan(0);
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

  it("falls back to bundled when override file is missing", () => {
    process.env.LUNO_PROMPTS_DIR = tmpDir;
    const md = getModePrompt("plan");
    expect(md.length).toBeGreaterThan(0);
    expect(md).not.toBe("");
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
