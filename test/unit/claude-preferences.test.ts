import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("vscode", () => ({}));

import {
  claudePreferences,
  modelPolicy,
  readSetting
} from "../../src/services/claude-settings.js";

let root = "";
let configDir = "";
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;

/** Write a settings file for one tier. */
const write = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};
const userFile = () => path.join(configDir, "settings.json");
const projectFile = () => path.join(root, ".claude", "settings.json");
const localFile = () => path.join(root, ".claude", "settings.local.json");

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "luno-pref-"));
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "luno-pcfg-"));
  process.env.CLAUDE_CONFIG_DIR = configDir;
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe("readSetting — the tier order is a corporate contract", () => {
  it("reads the user tier when nothing else sets the key", () => {
    write(userFile(), { model: "sonnet" });
    expect(readSetting("model", root)).toBe("sonnet");
  });

  it("lets the project override the user", () => {
    write(userFile(), { model: "sonnet" });
    write(projectFile(), { model: "opus" });
    expect(readSetting("model", root)).toBe("opus");
  });

  it("lets local override both — it is the most specific a person owns", () => {
    write(userFile(), { model: "sonnet" });
    write(projectFile(), { model: "opus" });
    write(localFile(), { model: "haiku" });
    expect(readSetting("model", root)).toBe("haiku");
  });

  it("passes over a tier that does not set the key rather than stopping", () => {
    write(userFile(), { model: "sonnet" });
    write(projectFile(), { effortLevel: "low" });
    expect(readSetting("model", root)).toBe("sonnet");
    expect(readSetting("effortLevel", root)).toBe("low");
  });

  it("ignores the project pair entirely when no folder is open", () => {
    write(userFile(), { model: "sonnet" });
    write(projectFile(), { model: "opus" });
    expect(readSetting("model", undefined)).toBe("sonnet");
  });

  it("survives a broken file in one tier without losing the others", () => {
    fs.mkdirSync(path.dirname(projectFile()), { recursive: true });
    fs.writeFileSync(projectFile(), "{ not json");
    write(userFile(), { model: "sonnet" });
    expect(readSetting("model", root)).toBe("sonnet");
  });
});

describe("claudePreferences — defaults, never restrictions", () => {
  it("reads the model, the mode and thinking", () => {
    write(userFile(), {
      model: "opus",
      alwaysThinkingEnabled: false,
      permissions: { defaultMode: "acceptEdits" }
    });
    expect(claudePreferences(root)).toMatchObject({
      model: "opus",
      thinking: false,
      defaultMode: "acceptEdits"
    });
  });

  it("says nothing about a key nobody set", () => {
    // Undefined has to stay undefined: it is what lets LUNO's own default win
    // rather than being overwritten by a value nobody chose.
    expect(claudePreferences(root)).toEqual({
      model: undefined,
      defaultMode: undefined,
      effort: undefined,
      thinking: undefined
    });
  });

  it("takes `manual` as the alias for `default` that the schema says it is", () => {
    write(userFile(), { permissions: { defaultMode: "manual" } });
    expect(claudePreferences(root).defaultMode).toBe("default");
  });

  it("maps bypassPermissions to LUNO's own name for it", () => {
    write(userFile(), { permissions: { defaultMode: "bypassPermissions" } });
    expect(claudePreferences(root).defaultMode).toBe("bypass");
  });

  it("drops a mode with no LUNO surface rather than guessing one", () => {
    // `dontAsk` mapped to `bypass` would turn a mode the admin chose into a
    // stronger one they did not.
    write(userFile(), { permissions: { defaultMode: "dontAsk" } });
    expect(claudePreferences(root).defaultMode).toBeUndefined();
  });

  it("ignores a mode that is simply a typo", () => {
    write(userFile(), { permissions: { defaultMode: "acceptEdit" } });
    expect(claudePreferences(root).defaultMode).toBeUndefined();
  });
});

describe("claudePreferences — effort is never widened to max", () => {
  // The one with teeth. Claude's enum is low|medium|high|xhigh; LUNO's picker
  // and `--effort` both accept `max`. A file that says xhigh is not permission
  // to run max, and a panel that quietly raised it would be spending on an
  // intensity nobody chose.
  it("takes each level the schema actually defines", () => {
    for (const level of ["low", "medium", "high", "xhigh"]) {
      write(userFile(), { effortLevel: level });
      expect(claudePreferences(root).effort).toBe(level);
    }
  });

  it("refuses `max`, which is not in Claude's enum at all", () => {
    write(userFile(), { effortLevel: "max" });
    expect(claudePreferences(root).effort).toBeUndefined();
  });

  it("refuses anything else a hand-edited file might carry", () => {
    for (const bad of ["highest", "HIGH", 3, null, ""]) {
      write(userFile(), { effortLevel: bad });
      expect(claudePreferences(root).effort).toBeUndefined();
    }
  });
});

describe("modelPolicy — the restriction half", () => {
  it("reports no policy when nobody set one", () => {
    expect(modelPolicy(root).availableModels).toBeUndefined();
  });

  it("reads an allowlist and its enforcement flag", () => {
    write(userFile(), {
      availableModels: ["opus", "sonnet"],
      enforceAvailableModels: true
    });
    expect(modelPolicy(root)).toEqual({
      availableModels: ["opus", "sonnet"],
      enforceAvailableModels: true
    });
  });

  it("keeps an empty list as an empty list, not as “no policy”", () => {
    // The two mean opposite things: absent is "everything", empty is
    // "default only".
    write(userFile(), { availableModels: [] });
    expect(modelPolicy(root).availableModels).toEqual([]);
  });

  it("drops non-string entries rather than passing them to a matcher", () => {
    write(userFile(), { availableModels: ["opus", 42, null] });
    expect(modelPolicy(root).availableModels).toEqual(["opus"]);
  });

  it("treats a non-array allowlist as no policy at all", () => {
    write(userFile(), { availableModels: "opus" });
    expect(modelPolicy(root).availableModels).toBeUndefined();
  });
});
