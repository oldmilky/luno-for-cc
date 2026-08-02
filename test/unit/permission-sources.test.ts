import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("vscode", () => ({}));

import { managedSettingsDir } from "../../src/services/claude-settings.js";
import {
  permissionSourceFiles,
  readPermissionRules,
  unreadableRuleSources
} from "../../src/services/permission-sources.js";

/** `process.platform` is read-only; this is the standard way to move it. */
function onPlatform(value: NodeJS.Platform, run: () => void) {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value, configurable: true });
  try {
    run();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

describe("managedSettingsDir — P6, and it must not be a guess", () => {
  // Every path here is READ from the reference bundle, which switches on the
  // platform exactly like this. A wrong one reads as "no managed settings",
  // which fails open on the one tier a user must not be able to override.
  it("is the ClaudeCode folder in Application Support on macOS", () => {
    onPlatform("darwin", () =>
      expect(managedSettingsDir()).toBe(
        "/Library/Application Support/ClaudeCode"
      )
    );
  });

  it("is under Program Files on Windows", () => {
    onPlatform("win32", () =>
      expect(managedSettingsDir()).toBe("C:\\Program Files\\ClaudeCode")
    );
  });

  it("is /etc/claude-code everywhere else", () => {
    onPlatform("linux", () =>
      expect(managedSettingsDir()).toBe("/etc/claude-code")
    );
  });
});

describe("permissionSourceFiles", () => {
  it("lists managed first and user last, with the project pair between", () => {
    const files = permissionSourceFiles("/work/app");
    expect(files[0].source).toBe("managed");
    expect(files.map((f) => f.source)).toContain("project");
    expect(files.map((f) => f.source)).toContain("local");
    expect(files.at(-1)!.source).toBe("user");
  });

  it("names the two project files the CLI reads", () => {
    const files = permissionSourceFiles("/work/app");
    const bySource = Object.fromEntries(files.map((f) => [f.source, f.file]));
    expect(bySource.project).toBe(
      path.join("/work/app", ".claude", "settings.json")
    );
    expect(bySource.local).toBe(
      path.join("/work/app", ".claude", "settings.local.json")
    );
  });

  it("drops the project pair when no folder is open", () => {
    const sources = permissionSourceFiles(undefined).map((f) => f.source);
    expect(sources).not.toContain("project");
    expect(sources).not.toContain("local");
    expect(sources).toContain("user");
  });
});

describe("readPermissionRules — off a real disk", () => {
  let root = "";
  let configDir = "";
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "luno-perm-"));
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "luno-cfg-"));
    process.env.CLAUDE_CONFIG_DIR = configDir;
    fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  });

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it("finds nothing, and reports no failure, on a machine with no settings", () => {
    const { rules, unreadable } = readPermissionRules(root);
    expect(rules).toEqual([]);
    expect(unreadable).toEqual([]);
  });

  it("reads the project file and badges it as project", () => {
    fs.writeFileSync(
      path.join(root, ".claude", "settings.json"),
      JSON.stringify({ permissions: { ask: ["Bash(git push:*)"] } }, null, 2)
    );
    const { rules } = readPermissionRules(root);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      source: "project",
      kind: "ask",
      rule: "Bash(git push:*)"
    });
  });

  it("reads the local file separately from the project one", () => {
    fs.writeFileSync(
      path.join(root, ".claude", "settings.json"),
      '{"permissions":{"allow":["Read"]}}'
    );
    fs.writeFileSync(
      path.join(root, ".claude", "settings.local.json"),
      '{"permissions":{"allow":["Write"]}}'
    );
    const { rules } = readPermissionRules(root);
    expect(rules.map((r) => [r.source, r.rule])).toEqual([
      ["project", "Read"],
      ["local", "Write"]
    ]);
  });

  it("reads the user file from CLAUDE_CONFIG_DIR, as the CLI does", () => {
    fs.writeFileSync(
      path.join(configDir, "settings.json"),
      '{"permissions":{"deny":["Bash(curl:*)"]}}'
    );
    const { rules } = readPermissionRules(root);
    expect(rules).toHaveLength(1);
    expect(rules[0].source).toBe("user");
  });

  it("reports a broken settings file rather than passing over it", () => {
    fs.writeFileSync(path.join(root, ".claude", "settings.json"), "{ nope");
    const { rules, unreadable } = readPermissionRules(root);
    expect(rules).toEqual([]);
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0].source).toBe("project");
  });

  it("writes nothing — this phase reads and only reads", () => {
    // Pinned rather than assumed: a grant reaching a settings file is a later
    // phase with its own boundary, and it must not arrive here by accident.
    const before = fs.readdirSync(path.join(root, ".claude"));
    readPermissionRules(root);
    expect(fs.readdirSync(path.join(root, ".claude"))).toEqual(before);
  });
});

describe("unreadableRuleSources", () => {
  it("names Windows Group Policy, which the CLI reads and this cannot", () => {
    onPlatform("win32", () => {
      const sources = unreadableRuleSources();
      expect(sources).toHaveLength(1);
      expect(sources[0]).toContain("HKLM");
    });
  });

  it("claims no gap on a platform that has none", () => {
    onPlatform("darwin", () => expect(unreadableRuleSources()).toEqual([]));
  });
});
