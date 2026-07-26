// ─────────────────────────────────────────────────────────────
// Discover Claude Code skills installed on disk.
//
// Claude Code skills are markdown files under:
//   ~/.claude/skills/<name>/SKILL.md          (user-level)
//   <workspace>/.claude/skills/<name>/SKILL.md (project-level)
//
// Each SKILL.md begins with YAML frontmatter that names and
// describes the skill. The CLI auto-loads matching skills based
// on the user's prompt — we don't need to invoke them ourselves,
// we just need to *list* them so the user can see what's
// available and toggle preferences in the picker.
// ─────────────────────────────────────────────────────────────

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

export type SkillSource = "user" | "project";

export interface DiscoveredSkill {
  /** Directory name — used as a stable id. */
  id: string;
  /** Human-readable name from frontmatter, falls back to id. */
  name: string;
  /** First sentence of the description from frontmatter. */
  description: string;
  source: SkillSource;
  /** Absolute path to the SKILL.md file. */
  path: string;
}

/**
 * Scan both user-level and project-level skills directories and return
 * everything that has a readable SKILL.md. Project-level skills come
 * second so they sort below user skills in the default order; the picker
 * can group/sort however it wants.
 */
export async function discoverClaudeSkills(
  workspaceRoot?: string
): Promise<DiscoveredSkill[]> {
  const roots: { dir: string; source: SkillSource }[] = [
    { dir: path.join(os.homedir(), ".claude", "skills"), source: "user" }
  ];
  if (workspaceRoot) {
    roots.push({
      dir: path.join(workspaceRoot, ".claude", "skills"),
      source: "project"
    });
  }

  const out: DiscoveredSkill[] = [];
  for (const { dir, source } of roots) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    await Promise.all(
      entries.map(async (name) => {
        if (name.startsWith(".")) return;
        const skillDir = path.join(dir, name);
        const file = path.join(skillDir, "SKILL.md");
        try {
          const stat = await fs.stat(skillDir);
          if (!stat.isDirectory()) return;
          const content = await fs.readFile(file, "utf-8");
          const fm = parseFrontmatter(content);
          out.push({
            id: name,
            name: fm.name ?? name,
            description: fm.description ?? "Custom skill",
            source,
            path: file
          });
        } catch {
          // No SKILL.md or unreadable — skip.
        }
      })
    );
  }

  return out;
}

interface Frontmatter {
  name?: string;
  description?: string;
}

/**
 * Parse the YAML-ish frontmatter block at the top of a SKILL.md. Only
 * understands `name:` and `description:` since that's all we display;
 * a real YAML parser would be overkill for two single-line scalars.
 */
export function parseFrontmatter(content: string): Frontmatter {
  const m = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const fm = m[1];
  const name = fm.match(/^name:\s*(.+?)\s*$/m)?.[1]?.trim();
  const rawDesc = fm.match(/^description:\s*(.+?)\s*$/m)?.[1]?.trim();
  // Strip optional surrounding quotes the user might have added.
  const description = rawDesc
    ? rawDesc.replace(/^['"](.+)['"]$/, "$1").slice(0, 240)
    : undefined;
  return { name, description };
}
