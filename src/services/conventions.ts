// Discovers project-conventions files (CLAUDE.md, AGENTS.md, etc.) so the
// model gets the user's house rules without requiring them to write a
// CLAUDE.md from scratch. Honors files written for other AI tools too —
// users shouldn't maintain N copies of the same conventions.
//
// Cached per-workspace; a FileSystemWatcher invalidates the cache on
// create/change/delete of any of the discovered paths.

import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export type ConventionsSource =
  | "claude-root"
  | "claude-dotfolder"
  | "agents"
  | "copilot"
  | "cursor"
  | "cline";

export interface ConventionsFile {
  source: ConventionsSource;
  absolutePath: string;
  workspaceRelativePath: string;
  content: string;
  /** True only when source === "claude-root" — Claude CLI auto-loads this so
   *  re-injecting via --append-system-prompt would double-load. */
  alreadyLoadedByCli: boolean;
  /** True if both CLAUDE.md and AGENTS.md are present in the workspace.
   *  Surface a one-time toast offering the user a chance to switch. */
  hasAlternative: boolean;
}

const PRIORITY: Array<{ rel: string; source: ConventionsSource }> = [
  { rel: "CLAUDE.md", source: "claude-root" },
  { rel: ".claude/CLAUDE.md", source: "claude-dotfolder" },
  { rel: "AGENTS.md", source: "agents" },
  { rel: ".github/copilot-instructions.md", source: "copilot" },
  { rel: ".cursorrules", source: "cursor" },
  { rel: ".clinerules", source: "cline" }
];

const cache = new Map<string, ConventionsFile | null>();
const watchers = new Map<string, vscode.FileSystemWatcher>();

export async function loadConventions(
  workspaceRoot: string
): Promise<ConventionsFile | null> {
  if (cache.has(workspaceRoot)) return cache.get(workspaceRoot)!;

  let chosen: ConventionsFile | null = null;
  let altExists = false;

  for (const { rel, source } of PRIORITY) {
    const abs = path.join(workspaceRoot, rel);
    try {
      const content = await fs.readFile(abs, "utf8");
      if (!chosen) {
        chosen = {
          source,
          absolutePath: abs,
          workspaceRelativePath: rel,
          content,
          alreadyLoadedByCli: source === "claude-root",
          hasAlternative: false
        };
      } else if (source === "agents" || source === "claude-root") {
        altExists = true;
      }
    } catch {
      /* not present */
    }
  }

  if (chosen) chosen.hasAlternative = altExists;

  cache.set(workspaceRoot, chosen);
  ensureWatcher(workspaceRoot);
  return chosen;
}

function ensureWatcher(workspaceRoot: string): void {
  if (watchers.has(workspaceRoot)) return;
  const pattern = new vscode.RelativePattern(
    workspaceRoot,
    "{CLAUDE.md,.claude/CLAUDE.md,AGENTS.md,.github/copilot-instructions.md,.cursorrules,.clinerules}"
  );
  const w = vscode.workspace.createFileSystemWatcher(pattern);
  const invalidate = (): void => {
    cache.delete(workspaceRoot);
  };
  w.onDidCreate(invalidate);
  w.onDidChange(invalidate);
  w.onDidDelete(invalidate);
  watchers.set(workspaceRoot, w);
}

export function disposeConventionsWatchers(): void {
  for (const w of watchers.values()) w.dispose();
  watchers.clear();
  cache.clear();
}
