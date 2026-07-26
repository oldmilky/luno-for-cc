import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

// Stub vscode before importing the module under test — conventions.ts uses
// vscode.workspace.createFileSystemWatcher, which doesn't exist in vitest's
// node environment.
vi.mock("vscode", () => ({
  workspace: {
    createFileSystemWatcher: () => ({
      onDidCreate: () => undefined,
      onDidChange: () => undefined,
      onDidDelete: () => undefined,
      dispose: () => undefined
    })
  },
  RelativePattern: class {
    constructor(public root: string, public pattern: string) {}
  }
}));

import {
  loadConventions,
  disposeConventionsWatchers
} from "../../src/services/conventions.js";

describe("loadConventions", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "luno-conv-"));
    disposeConventionsWatchers();
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
    disposeConventionsWatchers();
  });

  it("returns null when no conventions file exists", async () => {
    const result = await loadConventions(workspaceRoot);
    expect(result).toBeNull();
  });

  it("loads CLAUDE.md at root and marks alreadyLoadedByCli", async () => {
    await fs.writeFile(path.join(workspaceRoot, "CLAUDE.md"), "# Hi");
    const result = await loadConventions(workspaceRoot);
    expect(result?.source).toBe("claude-root");
    expect(result?.alreadyLoadedByCli).toBe(true);
    expect(result?.content).toBe("# Hi");
    expect(result?.workspaceRelativePath).toBe("CLAUDE.md");
  });

  it("falls through to AGENTS.md when CLAUDE.md is absent", async () => {
    await fs.writeFile(path.join(workspaceRoot, "AGENTS.md"), "# Agents");
    const result = await loadConventions(workspaceRoot);
    expect(result?.source).toBe("agents");
    expect(result?.alreadyLoadedByCli).toBe(false);
  });

  it("prefers CLAUDE.md over AGENTS.md and flags hasAlternative", async () => {
    await fs.writeFile(path.join(workspaceRoot, "CLAUDE.md"), "# Claude");
    await fs.writeFile(path.join(workspaceRoot, "AGENTS.md"), "# Agents");
    const result = await loadConventions(workspaceRoot);
    expect(result?.source).toBe("claude-root");
    expect(result?.hasAlternative).toBe(true);
  });

  it("falls through to .github/copilot-instructions.md", async () => {
    await fs.mkdir(path.join(workspaceRoot, ".github"));
    await fs.writeFile(
      path.join(workspaceRoot, ".github", "copilot-instructions.md"),
      "# Copilot"
    );
    const result = await loadConventions(workspaceRoot);
    expect(result?.source).toBe("copilot");
    expect(result?.workspaceRelativePath).toBe(".github/copilot-instructions.md");
  });

  it("caches the result for subsequent calls", async () => {
    await fs.writeFile(path.join(workspaceRoot, "CLAUDE.md"), "first");
    const a = await loadConventions(workspaceRoot);
    // Mutate on disk; cached result should still reflect the original read.
    await fs.writeFile(path.join(workspaceRoot, "CLAUDE.md"), "second");
    const b = await loadConventions(workspaceRoot);
    expect(a?.content).toBe(b?.content);
    expect(b?.content).toBe("first");
  });
});
