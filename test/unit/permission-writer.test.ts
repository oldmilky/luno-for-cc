import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("vscode", () => ({}));

import { mergeAllowRule } from "../../src/core/permission-rules.js";
import {
  FILE_SCOPES,
  availableFileScopes,
  settingsPathFor,
  writeAllowRule,
  workspaceTrustWarning
} from "../../src/services/permission-writer.js";

describe("mergeAllowRule — the only thing that decides a file's contents", () => {
  it("creates the whole shape when there is no file yet", () => {
    const { text, added } = mergeAllowRule(null, "Bash(bun run:*)");
    expect(added).toBe(true);
    expect(JSON.parse(text)).toEqual({
      permissions: { allow: ["Bash(bun run:*)"] }
    });
  });

  it("adds to an existing allow list", () => {
    const before = JSON.stringify({ permissions: { allow: ["Read"] } });
    const { text } = mergeAllowRule(before, "Write");
    expect(JSON.parse(text).permissions.allow).toEqual(["Read", "Write"]);
  });

  it("keeps every unrelated key exactly as it was", () => {
    // The whole risk of this function: it edits a file someone else wrote.
    const before = JSON.stringify({
      model: "sonnet",
      env: { FOO: "bar" },
      permissions: { deny: ["Bash(curl:*)"], defaultMode: "acceptEdits" },
      hooks: { PostToolUse: [] }
    });
    const { text } = mergeAllowRule(before, "Write");
    const after = JSON.parse(text);
    expect(after.model).toBe("sonnet");
    expect(after.env).toEqual({ FOO: "bar" });
    expect(after.hooks).toEqual({ PostToolUse: [] });
    expect(after.permissions.deny).toEqual(["Bash(curl:*)"]);
    expect(after.permissions.defaultMode).toBe("acceptEdits");
    expect(after.permissions.allow).toEqual(["Write"]);
  });

  it("reports no change when the rule is already there", () => {
    const before = JSON.stringify({ permissions: { allow: ["Write"] } });
    expect(mergeAllowRule(before, "Write").added).toBe(false);
  });

  it("does not mutate the object it parsed out of the text", () => {
    const before = JSON.stringify({ permissions: { allow: ["Read"] } });
    mergeAllowRule(before, "Write");
    expect(JSON.parse(before).permissions.allow).toEqual(["Read"]);
  });

  it("ends the file with a newline, as an editor would", () => {
    expect(mergeAllowRule(null, "Write").text.endsWith("\n")).toBe(true);
  });

  it("treats an empty or whitespace-only file as no file", () => {
    expect(mergeAllowRule("", "Write").added).toBe(true);
    expect(mergeAllowRule("   \n", "Write").added).toBe(true);
  });
});

describe("mergeAllowRule — what it refuses rather than guesses", () => {
  // Every one of these leaves a file the user owns untouched. Guessing at a
  // shape we do not understand is how a settings file gets destroyed.
  it("refuses a file that is not valid JSON", () => {
    expect(() => mergeAllowRule("{ oops", "Write")).toThrow(/not valid JSON/);
  });

  it("refuses a file that is not a JSON object", () => {
    expect(() => mergeAllowRule("[1,2]", "Write")).toThrow(/not a JSON object/);
  });

  it("refuses a `permissions` that is not an object", () => {
    expect(() => mergeAllowRule('{"permissions":"all"}', "Write")).toThrow(
      /`permissions` is not an object/
    );
  });

  it("refuses an `allow` that is not an array", () => {
    expect(() =>
      mergeAllowRule('{"permissions":{"allow":"Write"}}', "Write")
    ).toThrow(/not an array/);
  });
});

describe("settingsPathFor — and the one scope that has no path", () => {
  it("names the two project files and the user file", () => {
    expect(settingsPathFor("project", "/w")).toBe(
      path.join("/w", ".claude", "settings.json")
    );
    expect(settingsPathFor("local", "/w")).toBe(
      path.join("/w", ".claude", "settings.local.json")
    );
    expect(settingsPathFor("user", "/w")).toContain("settings.json");
  });

  it("has no path for LUNO's own storage — that is not a file", () => {
    expect(settingsPathFor("luno", "/w")).toBeNull();
  });

  it("offers no project scope when no folder is open", () => {
    expect(availableFileScopes(undefined)).toEqual(["user"]);
    expect(availableFileScopes("/w")).toEqual(["project", "local", "user"]);
  });

  it("never offers managed as a target", () => {
    // Not a runtime check but a type-level absence, asserted here so a future
    // widening of `GrantScope` trips something. An admin's policy file is not
    // a place this extension writes.
    expect(FILE_SCOPES).not.toContain("managed");
    expect([...FILE_SCOPES]).toEqual(["project", "local", "user"]);
  });
});

describe("writeAllowRule — against a real disk", () => {
  let root = "";
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "luno-write-"));
    process.env.CLAUDE_CONFIG_DIR = path.join(root, "home-claude");
  });

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const read = (p: string) => JSON.parse(fs.readFileSync(p, "utf8"));

  it("creates the file and its directory when neither exists", async () => {
    const { file, added } = await writeAllowRule(
      "project",
      root,
      "Bash(bun run:*)"
    );
    expect(added).toBe(true);
    expect(read(file).permissions.allow).toEqual(["Bash(bun run:*)"]);
  });

  it("merges into a file the user already had, keeping their keys", async () => {
    const file = path.join(root, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ model: "opus", permissions: { deny: ["Write"] } })
    );
    await writeAllowRule("project", root, "Read");
    expect(read(file)).toEqual({
      model: "opus",
      permissions: { deny: ["Write"], allow: ["Read"] }
    });
  });

  it("writes nothing at all when the rule is already present", async () => {
    const file = path.join(root, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ permissions: { allow: ["Read"] } })
    );
    const before = fs.statSync(file).mtimeMs;
    const result = await writeAllowRule("project", root, "Read");
    expect(result.added).toBe(false);
    expect(fs.statSync(file).mtimeMs).toBe(before);
  });

  it("leaves a broken file exactly as it was", async () => {
    // The failure that matters: a settings file we cannot parse must come out
    // of this byte-identical, not half-rewritten.
    const file = path.join(root, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ this is not json");
    await expect(writeAllowRule("project", root, "Read")).rejects.toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe("{ this is not json");
  });

  it("leaves no temp file behind on success", async () => {
    await writeAllowRule("project", root, "Read");
    const dir = path.join(root, ".claude");
    expect(fs.readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  it("writes the local file separately from the project one", async () => {
    await writeAllowRule("project", root, "Read");
    await writeAllowRule("local", root, "Write");
    expect(
      read(path.join(root, ".claude", "settings.json")).permissions.allow
    ).toEqual(["Read"]);
    expect(
      read(path.join(root, ".claude", "settings.local.json")).permissions.allow
    ).toEqual(["Write"]);
  });

  it("writes the user file under CLAUDE_CONFIG_DIR", async () => {
    const { file } = await writeAllowRule("user", root, "Glob");
    expect(file).toContain("home-claude");
    expect(read(file).permissions.allow).toEqual(["Glob"]);
  });

  it("refuses LUNO's own storage as a file target", async () => {
    await expect(writeAllowRule("luno", root, "Read")).rejects.toThrow(
      /nowhere to write/
    );
  });

  it("refuses a project scope with no folder open", async () => {
    await expect(
      writeAllowRule("project", undefined, "Read")
    ).rejects.toThrow();
  });
});

describe("workspaceTrustWarning — a rule the CLI will ignore", () => {
  // MEASURED, and it cost the end-to-end proof its first run: the CLI ignores
  // `permissions` from a project settings file until the folder is trusted,
  // saying so only on stderr. Written perfectly, honoured not at all.
  let home = "";
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "luno-home-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const writeClaudeJson = (projects: unknown) =>
    fs.writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({ projects })
    );

  it("stays quiet for a folder the CLI has been told to trust", async () => {
    writeClaudeJson({ "c:/work/app": { hasTrustDialogAccepted: true } });
    expect(await workspaceTrustWarning("c:/work/app")).toBeUndefined();
  });

  it("matches the folder however the separators are spelled", async () => {
    // The CLI stores forward slashes even on Windows; a caller has backslashes.
    writeClaudeJson({ "c:/work/app": { hasTrustDialogAccepted: true } });
    expect(await workspaceTrustWarning("C:\\work\\app")).toBeUndefined();
  });

  it("warns about a folder that has never been trusted", async () => {
    writeClaudeJson({ "c:/other": { hasTrustDialogAccepted: true } });
    expect(await workspaceTrustWarning("c:/work/app")).toContain("trust");
  });

  it("warns when the folder is known but trust was not accepted", async () => {
    writeClaudeJson({ "c:/work/app": { hasTrustDialogAccepted: false } });
    expect(await workspaceTrustWarning("c:/work/app")).toContain("trust");
  });

  it("says nothing when the answer cannot be read at all", async () => {
    // A warning invented from a file we failed to parse is its own kind of lie.
    fs.writeFileSync(path.join(home, ".claude.json"), "{ broken");
    expect(await workspaceTrustWarning("c:/work/app")).toBeUndefined();
  });

  it("says nothing when there is no folder to be trusted", async () => {
    expect(await workspaceTrustWarning(undefined)).toBeUndefined();
  });
});
