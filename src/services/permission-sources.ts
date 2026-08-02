// ─────────────────────────────────────────────────────────────
// Where the CLI's permission rules live on disk, and reading them.
//
// The paths are the load-bearing part. A wrong one reads as "there are no
// managed settings", which fails **open** on the one tier a user must not be
// able to override — so none of them is a guess. Every path below is READ out
// of `anthropic.claude-code` 2.1.220's own bundle; see `managedSettingsDir`.
//
// Reading only. Nothing in this file writes, and that is the design rather
// than a gap: the boundary deciding which grants may *ever* reach a settings
// file is its own module with its own tests, and showing the rules has to be
// possible without it.
// ─────────────────────────────────────────────────────────────

import * as fs from "node:fs";
import * as path from "node:path";
import {
  parsePermissionRules,
  type PermissionRuleSet,
  type SourceFile
} from "../core/permission-rules.js";
import { claudeConfigDir, managedSettingsDir } from "./claude-settings.js";

/**
 * Managed policy files: the single file, then every `.json` in the drop-in
 * directory beside it.
 *
 * The `managed-settings.d` directory is the reference's own — it joins it off
 * the same base — and exists so several policies can be deployed independently.
 * Reading only the single file would miss a whole deployment style.
 */
function managedFiles(): string[] {
  const dir = managedSettingsDir();
  const files = [path.join(dir, "managed-settings.json")];
  const dropIn = path.join(dir, "managed-settings.d");
  try {
    for (const name of fs.readdirSync(dropIn).sort()) {
      if (name.endsWith(".json")) files.push(path.join(dropIn, name));
    }
  } catch {
    // No drop-in directory is the normal case, not a failure.
  }
  return files;
}

/**
 * Every settings file that can carry a permission rule, in authority order.
 *
 * @param root the workspace folder the conversation is running in. Absent means
 *   no folder is open, and only the machine-wide tiers apply.
 */
export function permissionSourceFiles(
  root: string | undefined
): Array<{ source: SourceFile["source"]; file: string }> {
  const files: Array<{ source: SourceFile["source"]; file: string }> = [
    ...managedFiles().map((file) => ({ source: "managed" as const, file }))
  ];
  if (root) {
    files.push({
      source: "project",
      file: path.join(root, ".claude", "settings.json")
    });
    files.push({
      source: "local",
      file: path.join(root, ".claude", "settings.local.json")
    });
  }
  files.push({
    source: "user",
    file: path.join(claudeConfigDir(), "settings.json")
  });
  return files;
}

/**
 * Read and parse every source.
 *
 * A file that is not there contributes nothing and is not reported — that is
 * the overwhelmingly common case. A file that is there and unreadable *is*
 * reported, because silence about a broken policy is indistinguishable from
 * silence about no policy.
 */
export function readPermissionRules(
  root: string | undefined
): PermissionRuleSet {
  const files: SourceFile[] = permissionSourceFiles(root).map(
    ({ source, file }) => {
      let text: string | null = null;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch (err) {
        // ENOENT is the normal case and says nothing. Anything else — most
        // likely a permissions error on a policy file the user cannot read —
        // is reported, because it is not the same fact as "no policy".
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code && code !== "ENOENT" && code !== "ENOTDIR") {
          return {
            source,
            file,
            text: null,
            error: `could not be read (${code})`
          };
        }
      }
      return { source, file, text };
    }
  );
  return parsePermissionRules(files);
}

/**
 * Sources the CLI honours that this cannot read, so the panel can say so
 * rather than imply the list is complete.
 *
 * On Windows the CLI also reads Group Policy — `HKLM\SOFTWARE\Policies\
 * ClaudeCode` and the matching `HKCU` key — READ from the settings schema's own
 * description of `wslInheritsWindowsSettings`. Reaching those needs a registry
 * read this extension does not do, and the honest handling of a gap in a
 * *policy* display is to name it.
 */
export function unreadableRuleSources(): string[] {
  return process.platform === "win32"
    ? ["Windows Group Policy (HKLM and HKCU \\SOFTWARE\\Policies\\ClaudeCode)"]
    : [];
}
