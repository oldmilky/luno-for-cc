// ─────────────────────────────────────────────────────────────
// Skills — the picker, the on/off preference, and the marketplace.
//
// The local half and the remote half live together on purpose: installing
// from the marketplace has to re-publish the picker, so splitting them would
// only buy a dependency edge between two files that are always read together.
//
// The disabled-skill set is stored in `globalState` under one key. That key
// stays private to this module — the turn path used to read it directly, and
// now asks `disabledSkillIds()` instead, so the storage shape is ours to
// change.
// ─────────────────────────────────────────────────────────────

import * as vscode from "vscode";
import { discoverClaudeSkills } from "../../services/claude-skills.js";
import { getSkillSuggestion } from "../../services/skill-suggestions.js";
import {
  fetchMarketplace,
  fetchSkillDetail,
  installSkill,
  uninstallSkill,
  type InstallScope,
  type InstallTarget
} from "../../services/marketplace.js";
import type { TaskType } from "../../core/types.js";
import type { Post } from "../messages.js";

const DISABLED_SKILLS_KEY = "luno.disabledSkills.v1";
const SUGGESTION_DISMISSED_KEY = "luno.skillSuggestionDismissed.v1";

export interface SkillInfo {
  id: string;
  name: string;
  category: "tool" | "skill" | "integration";
  description: string;
  enabled: boolean;
  toggleable: boolean;
  external?: boolean;
  /** "user" / "project" for filesystem-discovered skills; undefined otherwise. */
  source?: "user" | "project";
}

/**
 * Skill ids the user switched off in the picker.
 *
 * Exported because the turn path passes them to the CLI — the toggle has to
 * actually skip a skill at invocation time, not just grey out a row.
 */
export function disabledSkillIds(ctx: vscode.ExtensionContext): string[] {
  return ctx.globalState.get<string[]>(DISABLED_SKILLS_KEY, []);
}

/** Publish the picker's contents. */
export async function broadcastSkills(
  post: Post,
  ctx: vscode.ExtensionContext
): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const disabled = new Set(disabledSkillIds(ctx));
  post({
    type: "skills",
    skills: await availableSkills(workspaceRoot, disabled)
  });
}

export async function setSkillEnabled(
  post: Post,
  ctx: vscode.ExtensionContext,
  id: string,
  enabled: boolean
): Promise<void> {
  const set = new Set(disabledSkillIds(ctx));
  if (enabled) set.delete(id);
  else set.add(id);
  await ctx.globalState.update(DISABLED_SKILLS_KEY, Array.from(set));
  await broadcastSkills(post, ctx);
}

/**
 * Offer a skill that suits the task at hand, once. A suggestion the user
 * dismissed stays dismissed for the workspace.
 */
export async function suggestSkill(
  post: Post,
  ctx: vscode.ExtensionContext,
  taskType: TaskType,
  workspaceRoot: string
): Promise<void> {
  const dismissed = ctx.workspaceState.get<string[]>(
    SUGGESTION_DISMISSED_KEY,
    []
  );
  const suggestion = await getSkillSuggestion(taskType, workspaceRoot);
  if (!suggestion) return;
  if (dismissed.includes(suggestion.skillId)) return;
  post({
    type: "skillSuggestion",
    skillId: suggestion.skillId,
    skillName: suggestion.skillName,
    reason: suggestion.reason,
    taskType: suggestion.taskType
  });
}

export async function dismissSuggestion(
  ctx: vscode.ExtensionContext,
  skillId: string
): Promise<void> {
  const list = ctx.workspaceState.get<string[]>(SUGGESTION_DISMISSED_KEY, []);
  if (list.includes(skillId)) return;
  await ctx.workspaceState.update(SUGGESTION_DISMISSED_KEY, [...list, skillId]);
}

// ── Marketplace ──────────────────────────────────────────────

export async function requestMarketplace(
  post: Post,
  offset: number,
  limit: number,
  query: string | undefined
): Promise<void> {
  try {
    const result = await fetchMarketplace({ offset, limit, query });
    post({
      type: "marketplaceList",
      skills: result.skills.map(summarise),
      total: result.total,
      offset: result.offset,
      limit: result.limit
    });
  } catch (err) {
    post({ type: "marketplaceError", message: describe(err) });
  }
}

export async function requestSkillDetail(
  post: Post,
  name: string
): Promise<void> {
  try {
    const { skill, content } = await fetchSkillDetail(name);
    post({ type: "skillDetail", name, skill: summarise(skill), content });
  } catch (err) {
    post({ type: "skillDetail", name, error: describe(err) });
  }
}

export async function installMarketplaceSkill(
  post: Post,
  ctx: vscode.ExtensionContext,
  target: InstallTarget,
  scope: InstallScope
): Promise<void> {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const result = await installSkill(target, scope, cwd);
  post({
    type: "marketplaceInstallResult",
    action: "install",
    name: target.name,
    ok: result.ok,
    scope: result.scope,
    installPath: result.installPath,
    filesWritten: result.filesWritten,
    error: result.error
  });
  // Re-publish so the picker sees the skill in its new on-disk home.
  if (result.ok) await broadcastSkills(post, ctx);
}

export async function uninstallMarketplaceSkill(
  post: Post,
  ctx: vscode.ExtensionContext,
  name: string,
  scope: InstallScope
): Promise<void> {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const result = await uninstallSkill(name, scope, cwd);
  post({
    type: "marketplaceInstallResult",
    action: "uninstall",
    name,
    ok: result.ok,
    scope: result.scope,
    error: result.error
  });
  if (result.ok) await broadcastSkills(post, ctx);
}

/** The subset of a marketplace entry the webview renders. */
function summarise(s: {
  id: string;
  name: string;
  namespace: string;
  description: string;
  author: string;
  stars: number;
  installs: number;
  sourceUrl: string;
  repoOwner: string;
  repoName: string;
  directoryPath: string;
}) {
  return {
    id: s.id,
    name: s.name,
    namespace: s.namespace,
    description: s.description,
    author: s.author,
    stars: s.stars,
    installs: s.installs,
    sourceUrl: s.sourceUrl,
    repoOwner: s.repoOwner,
    repoName: s.repoName,
    directoryPath: s.directoryPath
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * What the composer's picker shows: Claude Code's own capabilities, plus any
 * skill found on disk under `~/.claude/skills/` or
 * `<workspace>/.claude/skills/`.
 *
 * `disabled` only flips the `enabled` flag so the row reads correctly. The
 * toggle is a preference, not a filter — Claude Code loads skills off the
 * prompt, and the CLI is where the exclusion is actually applied.
 */
async function availableSkills(
  workspaceRoot: string | undefined,
  disabled: Set<string>
): Promise<SkillInfo[]> {
  // Surfaced by the CLI, executed inside it — `external`, because LUNO does
  // not own them and cannot toggle them.
  const claudeCode: SkillInfo[] = [
    tool("Read", "Read", "Read files in the workspace"),
    tool("Write", "Write", "Create and edit files"),
    tool("Bash", "Bash", "Run shell commands"),
    skill("Glob", "Glob", "Find files by glob pattern"),
    skill("Grep", "Grep", "Search file contents"),
    skill("Edit", "Edit", "Targeted in-file edits"),
    skill("WebFetch", "WebFetch", "Fetch and read URLs"),
    skill("Task", "Sub-agents", "Spawn parallel sub-agents")
  ];

  // Failures are swallowed: a missing directory or an unreadable SKILL.md is
  // the normal case, not an error worth surfacing in a picker.
  let custom: SkillInfo[];
  try {
    const found = await discoverClaudeSkills(workspaceRoot);
    custom = found.map((s) => ({
      id: s.id,
      name: s.name,
      category: "skill" as const,
      description: s.description,
      enabled: !disabled.has(s.id),
      toggleable: true,
      external: true,
      source: s.source
    }));
  } catch {
    custom = [];
  }

  const integrations: SkillInfo[] = [
    {
      id: "mcp",
      name: "MCP Servers",
      category: "integration",
      description: "Model Context Protocol servers (configure to enable)",
      enabled: false,
      toggleable: false
    }
  ];

  return [...claudeCode, ...custom, ...integrations];
}

function tool(id: string, name: string, description: string): SkillInfo {
  return {
    id,
    name,
    category: "tool",
    description,
    enabled: true,
    toggleable: false,
    external: true
  };
}

function skill(id: string, name: string, description: string): SkillInfo {
  return {
    id,
    name,
    category: "skill",
    description,
    enabled: true,
    toggleable: false,
    external: true
  };
}
