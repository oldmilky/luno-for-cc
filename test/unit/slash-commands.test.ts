import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  scanCommandFiles,
  mergeCommands,
  parseDescription,
  type SlashCommand
} from "../../src/services/slash-commands.js";
import {
  filterCommands,
  slashQuery
} from "../../webview/src/features/chat/composer/slash-filter";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "luno-slash-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function writeCommand(rel: string, body: string): Promise<void> {
  const abs = path.join(root, ".claude", "commands", rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body);
}

describe("scanCommandFiles", () => {
  it("finds a project command and its description", async () => {
    await writeCommand(
      "ship.md",
      "---\ndescription: Take a feature end to end\n---\n\nDo the thing.\n"
    );

    const found = (await scanCommandFiles(root)).filter(
      (c) => c.source === "project"
    );

    expect(found).toEqual([
      {
        name: "ship",
        description: "Take a feature end to end",
        source: "project"
      }
    ]);
  });

  // Claude Code namespaces a nested command by its directory, and a popover
  // offering `/sync` for a command that only answers to `/git:sync` would be
  // advertising something that cannot run.
  it("namespaces a command in a subdirectory", async () => {
    await writeCommand("git/sync.md", "Pull and rebase.\n");

    const found = (await scanCommandFiles(root)).filter(
      (c) => c.source === "project"
    );

    expect(found.map((c) => c.name)).toEqual(["git:sync"]);
  });

  it("keeps a command with no frontmatter, without a description", async () => {
    await writeCommand("bare.md", "Just a body.\n");

    const bare = (await scanCommandFiles(root)).find((c) => c.name === "bare");

    expect(bare).toBeDefined();
    expect(bare?.description).toBeUndefined();
  });

  it("ignores anything that is not markdown", async () => {
    await writeCommand("notes.txt", "not a command");

    const found = (await scanCommandFiles(root)).filter(
      (c) => c.source === "project"
    );

    expect(found).toEqual([]);
  });

  it("returns nothing rather than throwing with no commands directory", async () => {
    await expect(scanCommandFiles(root)).resolves.toBeInstanceOf(Array);
  });
});

describe("parseDescription", () => {
  it("reads the description out of frontmatter", () => {
    expect(parseDescription("---\ndescription: Ship it\n---\nbody")).toBe(
      "Ship it"
    );
  });

  it("strips quotes the way YAML would", () => {
    expect(parseDescription('---\ndescription: "Ship it"\n---\n')).toBe(
      "Ship it"
    );
  });

  it("has nothing to say about a file with no frontmatter", () => {
    expect(parseDescription("# Just a heading\n")).toBeUndefined();
  });
});

describe("mergeCommands", () => {
  const disk: SlashCommand[] = [
    { name: "ship", description: "End to end", source: "project" },
    { name: "notes", source: "user" }
  ];

  it("keeps the disk description when the CLI reports the same name", () => {
    const merged = mergeCommands(disk, ["ship", "compact"]);

    expect(merged.find((c) => c.name === "ship")?.description).toBe(
      "End to end"
    );
  });

  it("adds what only the CLI knows", () => {
    const merged = mergeCommands(disk, ["compact"]);

    expect(merged.find((c) => c.name === "compact")?.source).toBe("cli");
  });

  // The CLI's list runs past a hundred entries with plugins installed. The
  // user's own commands are the ones they are reaching for.
  it("puts the user's own commands ahead of the CLI's", () => {
    const merged = mergeCommands(disk, ["aaa-alphabetically-first"]);

    expect(merged.map((c) => c.source)).toEqual(["project", "user", "cli"]);
  });
});

describe("filterCommands", () => {
  const all: SlashCommand[] = [
    { name: "start", source: "project" },
    { name: "status", source: "user" },
    { name: "marketing-skills:content-strategy", source: "cli" },
    { name: "mattpocock-skills:tdd", source: "cli" }
  ];

  it("offers everything before anything is typed", () => {
    expect(filterCommands(all, "")).toHaveLength(4);
  });

  // The case from the brief: "/st" should suggest "/start".
  it("ranks a prefix match above a mere substring", () => {
    const out = filterCommands(all, "st");

    expect(out[0].name).toBe("start");
    expect(out.map((c) => c.name)).toContain("status");
  });

  // A namespaced command is reached for by its short name.
  it("finds a namespaced command by its leaf", () => {
    expect(filterCommands(all, "tdd").map((c) => c.name)).toEqual([
      "mattpocock-skills:tdd"
    ]);
  });

  it("matches regardless of case", () => {
    expect(filterCommands(all, "START").map((c) => c.name)).toContain("start");
  });

  it("offers nothing for a query that matches nothing", () => {
    expect(filterCommands(all, "zzz")).toEqual([]);
  });
});

// What the composer keys the popover off. Extracted from the component so the
// rule can be pinned without a DOM: `/` opens it, more letters narrow it, and
// anything that is not a command being typed closes it.
describe("slashQuery", () => {
  it("opens on a bare slash", () => {
    expect(slashQuery("/")).toBe("");
  });

  it("narrows as the user types", () => {
    expect(slashQuery("/st")).toBe("st");
  });

  it("closes once arguments begin", () => {
    expect(slashQuery("/start now")).toBeNull();
  });

  it("stays shut for ordinary prose", () => {
    expect(slashQuery("what does / mean here")).toBeNull();
  });

  // A path pasted mid-sentence is not a command, and neither is a leading
  // space followed by one — the CLI only expands at offset 0.
  it("stays shut for a slash that is not the first character", () => {
    expect(slashQuery(" /start")).toBeNull();
    expect(slashQuery("see src/gate.ts")).toBeNull();
  });
});

// Shipped without this and the popover was empty on the machine it was built
// for: `.claude/commands` did not exist, while `.claude/skills` held sixteen
// entries. Claude Code exposes a skill as `/name` just like a command.
describe("scanCommandFiles finds skills too", () => {
  async function writeSkill(id: string, body: string): Promise<void> {
    const abs = path.join(root, ".claude", "skills", id, "SKILL.md");
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body);
  }

  it("offers a project skill as a command, with its description", async () => {
    await writeSkill(
      "browser",
      "---\nname: browser\ndescription: Verify the webview in a real browser.\n---\n\nSteps.\n"
    );

    const found = (await scanCommandFiles(root)).find(
      (c) => c.name === "browser"
    );

    expect(found?.source).toBe("project");
    expect(found?.description).toContain("Verify the webview");
  });

  // A name defined both ways is one command, not two rows that look identical.
  it("does not offer the same name twice", async () => {
    await writeCommand("audit.md", "---\ndescription: From commands\n---\n");
    await writeSkill(
      "audit",
      "---\nname: audit\ndescription: From skills\n---\n"
    );

    const audits = (await scanCommandFiles(root)).filter(
      (c) => c.name === "audit"
    );

    expect(audits).toHaveLength(1);
    // `.claude/commands` is the more specific definition and wins.
    expect(audits[0].description).toBe("From commands");
  });
});
