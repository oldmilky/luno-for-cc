// ─────────────────────────────────────────────────────────────
// The slash commands the composer suggests.
//
// Expansion is emphatically NOT ours: the CLI resolves `/name` itself, on the
// stream-json input path this extension uses — verified against 2.1.219, where
// `/lunoprobe` arrived as a `Skill` tool call without the extension doing
// anything. So the prompt text goes out untouched and this module only answers
// "what could the user type".
//
// Three sources, because none alone is enough:
//
//   • The CLI's own list, which it reports on every turn's `init` event. It is
//     authoritative and covers built-ins and plugins, but it is names only and
//     arrives no earlier than the first turn — the CLI emits nothing until it
//     is given a message, so there is no way to ask it up front for free.
//   • `.claude/commands/**.md` on disk.
//   • `.claude/skills/*/SKILL.md`, which Claude Code also exposes as `/name`.
//     This is the one that matters in practice: shipping without it left the
//     popover empty on a machine whose commands are all skills, which is the
//     normal case.
//
// The two disk sources are read every time and carry the descriptions that
// make the list worth opening.
// ─────────────────────────────────────────────────────────────

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { discoverClaudeSkills } from "./claude-skills.js";

export interface SlashCommand {
  /** Without the leading slash, exactly as the CLI names it. */
  name: string;
  description?: string;
  /** Where it came from, so the list can show the user's own first. */
  source: "project" | "user" | "cli";
}

/** Directory recursion bound. Command trees are shallow; this only stops a
 *  symlink loop from turning a popover into a hang. */
const MAX_DEPTH = 4;

/**
 * Read `.claude/commands` from the project and the user's home.
 *
 * Never throws: a missing directory is the normal case, and no popover is a
 * better outcome than a broken composer.
 */
export async function scanCommandFiles(
  workspaceRoot: string | undefined
): Promise<SlashCommand[]> {
  const roots: Array<{ dir: string; source: "project" | "user" }> = [];
  if (workspaceRoot) {
    roots.push({
      dir: path.join(workspaceRoot, ".claude", "commands"),
      source: "project"
    });
  }
  roots.push({
    dir: path.join(os.homedir(), ".claude", "commands"),
    source: "user"
  });

  const out = new Map<string, SlashCommand>();
  for (const { dir, source } of roots) {
    for (const found of await walk(dir, dir, source, 0)) {
      // The project's own definition wins over a same-named one in the home
      // directory, which is the precedence Claude Code itself applies.
      if (!out.has(found.name)) out.set(found.name, found);
    }
  }

  // Skills answer to `/name` exactly as commands do, and on most machines they
  // are all the user has — `.claude/commands` is frequently empty while
  // `.claude/skills` is not.
  for (const skill of await discoverClaudeSkills(workspaceRoot)) {
    if (out.has(skill.id)) continue;
    out.set(skill.id, {
      name: skill.id,
      description: skill.description,
      source: skill.source
    });
  }

  return [...out.values()];
}

async function walk(
  base: string,
  dir: string,
  source: "project" | "user",
  depth: number
): Promise<SlashCommand[]> {
  if (depth > MAX_DEPTH) return [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: SlashCommand[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(base, full, source, depth + 1)));
      continue;
    }
    if (!entry.name.endsWith(".md")) continue;
    out.push({
      name: commandName(base, full),
      description: await readDescription(full),
      source
    });
  }
  return out;
}

/** `commands/review.md` → `review`; `commands/git/sync.md` → `git:sync`, which
 *  is how Claude Code namespaces a nested command. */
function commandName(base: string, file: string): string {
  return path
    .relative(base, file)
    .replace(/\.md$/i, "")
    .split(/[\\/]/)
    .join(":");
}

/** The `description:` line from YAML frontmatter, when the file has one. */
async function readDescription(file: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
  return parseDescription(text);
}

/** Exported for testing: frontmatter parsing is the part that silently returns
 *  nothing when the shape is a little different from expected. */
export function parseDescription(text: string): string | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return undefined;
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^description:\s*(.+?)\s*$/.exec(line);
    if (!kv) continue;
    return kv[1].replace(/^["']|["']$/g, "") || undefined;
  }
  return undefined;
}

/**
 * Fold the CLI's names into what disk gave us.
 *
 * Disk entries keep their description and source; anything the CLI knows about
 * and disk did not is added as `cli`. The result is sorted so the user's own
 * commands lead — those are the ones they are reaching for, and the CLI's list
 * runs to well over a hundred entries on a machine with plugins installed.
 */
export function mergeCommands(
  fromDisk: SlashCommand[],
  fromCli: string[]
): SlashCommand[] {
  const byName = new Map(fromDisk.map((c) => [c.name, c]));
  for (const name of fromCli) {
    if (!byName.has(name)) byName.set(name, { name, source: "cli" });
  }

  const rank = (s: SlashCommand["source"]) =>
    s === "project" ? 0 : s === "user" ? 1 : 2;
  return [...byName.values()].sort(
    (a, b) => rank(a.source) - rank(b.source) || a.name.localeCompare(b.name)
  );
}
