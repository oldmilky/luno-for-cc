// Loads bundled mode + task-type MD prompts. esbuild's text loader inlines the
// MD content into dist/extension.js at build time so runtime cost is zero.
//
// In dev, set LUNO_PROMPTS_DIR to a path on disk and the loader will read
// from there instead — useful for iterating on prompts without rebuilding.

import * as fs from "node:fs";
import * as path from "node:path";

import commonMd from "../prompts/common.md";
import planModeMd from "../prompts/plan-mode.md";
import defaultModeMd from "../prompts/default-mode.md";
import autoModeMd from "../prompts/auto-mode.md";
import acceptEditsModeMd from "../prompts/accept-edits-mode.md";
import bypassModeMd from "../prompts/bypass-mode.md";
import backendMd from "../prompts/task-types/backend.md";
import frontendMd from "../prompts/task-types/frontend.md";
import fullstackMd from "../prompts/task-types/fullstack.md";
import devopsMd from "../prompts/task-types/devops.md";
import integrationMd from "../prompts/task-types/integration.md";
import docsDrivenMd from "../prompts/task-types/docs-driven.md";
import refactorMd from "../prompts/task-types/refactor.md";
import bugfixMd from "../prompts/task-types/bugfix.md";
import migrationMd from "../prompts/task-types/migration.md";
import newImplMd from "../prompts/task-types/new-impl.md";

import { PermissionMode, TaskType } from "../core/types.js";

const BUNDLED_MODE: Record<PermissionMode, string> = {
  plan: planModeMd,
  default: defaultModeMd,
  acceptEdits: acceptEditsModeMd,
  auto: autoModeMd,
  bypass: bypassModeMd
};

/** Mode id → file on disk. Only `acceptEdits` differs, and deriving the name
 *  from the id instead cost the dev override for exactly that mode: it looked
 *  for `acceptEdits-mode.md` and the file is kebab-case like every other. */
const MODE_FILE: Record<PermissionMode, string> = {
  plan: "plan-mode.md",
  default: "default-mode.md",
  acceptEdits: "accept-edits-mode.md",
  auto: "auto-mode.md",
  bypass: "bypass-mode.md"
};

const BUNDLED_TASK: Record<Exclude<TaskType, "generic">, string> = {
  backend: backendMd,
  frontend: frontendMd,
  fullstack: fullstackMd,
  devops: devopsMd,
  integration: integrationMd,
  "docs-driven": docsDrivenMd,
  refactor: refactorMd,
  bugfix: bugfixMd,
  migration: migrationMd,
  "new-impl": newImplMd
};

function devOverride(rel: string): string | null {
  const dir = process.env.LUNO_PROMPTS_DIR;
  if (!dir) return null;
  try {
    return fs.readFileSync(path.join(dir, rel), "utf8");
  } catch {
    return null;
  }
}

/** What every mode shares: where the model is running, what the surface around
 *  it can do, and the rules that do not change with the approval posture. */
export function getCommonPrompt(): string {
  return devOverride("common.md") ?? commonMd;
}

export function getModePrompt(mode: PermissionMode): string {
  return devOverride(MODE_FILE[mode]) ?? BUNDLED_MODE[mode];
}

export function getTaskTypePrompt(type: TaskType): string | null {
  if (type === "generic") return null;
  return devOverride(`task-types/${type}.md`) ?? BUNDLED_TASK[type];
}
