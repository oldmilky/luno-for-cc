// Maps task types to recommended marketplace skills. When the classifier
// detects a task type in plan mode and the recommended skill isn't installed
// for the current workspace, panel.ts surfaces a one-line suggestion in chat
// (the install button reuses the existing marketplace flow).

import { TaskType } from "../core/types.js";
import { discoverClaudeSkills } from "./claude-skills.js";

export interface SkillSuggestion {
  taskType: TaskType;
  skillId: string;
  skillName: string;
  reason: string;
}

const RECOMMENDATIONS: Partial<Record<TaskType, { skillId: string; skillName: string; reason: string }>> = {
  backend: {
    skillId: "architecture-patterns",
    skillName: "architecture-patterns",
    reason: "best practices for Clean / Hexagonal / DDD backend design"
  },
  frontend: {
    skillId: "frontend-design",
    skillName: "frontend-design",
    reason: "production UI patterns for components, layouts, and accessibility"
  },
  fullstack: {
    skillId: "architecture-patterns",
    skillName: "architecture-patterns",
    reason: "system-level design across frontend and backend layers"
  },
  integration: {
    skillId: "api-design-principles",
    skillName: "api-design-principles",
    reason: "REST / GraphQL standards and integration design patterns"
  },
  bugfix: {
    skillId: "systematic-debugging",
    skillName: "systematic-debugging",
    reason: "structured root-cause analysis for bugs and test failures"
  },
  refactor: {
    skillId: "systematic-debugging",
    skillName: "systematic-debugging",
    reason: "structured approach to verifying refactor behavior preservation"
  },
  "new-impl": {
    skillId: "brainstorming",
    skillName: "brainstorming",
    reason: "exploring requirements and design space before committing to code"
  }
};

/** Returns a suggestion only if the matching marketplace skill isn't already
 *  installed for the workspace. Returns null otherwise. */
export async function getSkillSuggestion(
  taskType: TaskType,
  workspaceRoot: string
): Promise<SkillSuggestion | null> {
  const rec = RECOMMENDATIONS[taskType];
  if (!rec) return null;

  const installed = await discoverClaudeSkills(workspaceRoot);
  const isInstalled = installed.some(
    (s) => s.id === rec.skillId || s.name === rec.skillName
  );
  if (isInstalled) return null;

  return {
    taskType,
    skillId: rec.skillId,
    skillName: rec.skillName,
    reason: rec.reason
  };
}
