// ─────────────────────────────────────────────────────────────
// Putting one permission rule into one settings file.
//
// This is the first thing in the wave that writes, and it writes into files the
// user owns and may have edited by hand a minute ago. Three rules follow from
// that and none of them is optional:
//
// - **merge, never replace.** The file is read, one entry is added, everything
//   else is carried across untouched. The deciding is `mergeAllowRule`, which
//   is pure and refuses anything it does not understand rather than guessing.
// - **atomic.** Written to a sibling temp file and renamed over the original,
//   so a crash mid-write leaves the old file rather than half of a new one.
// - **managed is never a target.** It is an administrator's policy, and an
//   extension that edits it is a client that has decided policy does not
//   apply to it.
// ─────────────────────────────────────────────────────────────

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { mergeAllowRule } from "../core/permission-rules.js";
import type { GrantScope } from "../core/types.js";
import { claudeConfigDir } from "./claude-settings.js";

/** The scopes that mean "a settings file", in the order a picker shows them.
 *  `managed` is not among them and is not a `GrantScope` at all — refusing an
 *  administrator's policy file at runtime only would leave the possibility
 *  open in every call site's head. */
export const FILE_SCOPES: readonly GrantScope[] = ["project", "local", "user"];

/**
 * The file a scope writes to, or `null` when it has none here — the two
 * project scopes need a folder to be open.
 */
export function settingsPathFor(
  scope: GrantScope,
  root: string | undefined
): string | null {
  switch (scope) {
    case "project":
      return root ? path.join(root, ".claude", "settings.json") : null;
    case "local":
      return root ? path.join(root, ".claude", "settings.local.json") : null;
    case "user":
      return path.join(claudeConfigDir(), "settings.json");
    default:
      return null;
  }
}

/** Which scopes can be offered right now. `luno` always can; the rest need
 *  somewhere to write. */
export function availableFileScopes(root: string | undefined): GrantScope[] {
  return FILE_SCOPES.filter((s) => settingsPathFor(s, root) !== null);
}

export interface WriteResult {
  /** The file it went into. */
  file: string;
  /** False when the rule was already there and nothing was written. */
  added: boolean;
  /** Set when the rule was written correctly and the CLI will ignore it
   *  anyway. See {@link workspaceTrustWarning}. */
  warning?: string;
}

/**
 * Whether the CLI will actually honour a project-tier rule in this folder.
 *
 * MEASURED, and it cost the end-to-end proof its first run: a `permissions`
 * entry in `.claude/settings.json` is **ignored** until the workspace has been
 * trusted, with only a line on stderr to say so —
 * `"Ignoring 1 permissions.allow entry from .claude/settings.json: this
 * workspace has not been trusted."` Trust is recorded by the CLI itself in
 * `~/.claude.json` under `projects[<root>].hasTrustDialogAccepted`.
 *
 * So a grant can be written perfectly and do nothing. Without this the user
 * would be told a permission was stored and then be asked for it again forever.
 *
 * @returns the warning to show, or `undefined` when the folder is trusted —
 *   and also when the answer cannot be read, because inventing a warning about
 *   a file we failed to parse would be its own kind of lie.
 */
export async function workspaceTrustWarning(
  root: string | undefined
): Promise<string | undefined> {
  if (!root) return undefined;
  try {
    const raw = await fs.readFile(
      path.join(os.homedir(), ".claude.json"),
      "utf8"
    );
    const parsed: unknown = JSON.parse(raw);
    const projects = (parsed as { projects?: Record<string, unknown> })
      ?.projects;
    if (!projects || typeof projects !== "object") return undefined;
    // The CLI's own key for this folder. Compared with separators normalised:
    // it stores forward slashes even on Windows.
    const wanted = root.replace(/\\/g, "/").toLowerCase();
    const entry = Object.entries(projects).find(
      ([key]) => key.replace(/\\/g, "/").toLowerCase() === wanted
    )?.[1] as { hasTrustDialogAccepted?: unknown } | undefined;
    if (entry?.hasTrustDialogAccepted === true) return undefined;
    return "The Claude CLI ignores permission rules in a folder it has not been told to trust. Run `claude` here once and accept the trust prompt, or this rule will have no effect.";
  } catch {
    return undefined;
  }
}

/**
 * Add `rule` to a scope's `permissions.allow`.
 *
 * @throws with a message meant to be shown, when the target file exists but
 *   cannot be merged into. Nothing is written in that case — the existing file
 *   is left exactly as it was.
 */
export async function writeAllowRule(
  scope: GrantScope,
  root: string | undefined,
  rule: string
): Promise<WriteResult> {
  const file = settingsPathFor(scope, root);
  if (!file) {
    throw new Error(`There is nowhere to write a ${scope} rule here.`);
  }

  let existing: string | null = null;
  try {
    existing = await fs.readFile(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // Anything but "not there yet" is a file we must not paper over.
    if (code && code !== "ENOENT") {
      throw new Error(`${file} could not be read (${code}).`, { cause: err });
    }
  }

  const { text, added } = mergeAllowRule(existing, rule);
  // Only the two project tiers are gated on trust; the user tier is the user's
  // own machine and needs no folder's permission.
  const warning =
    scope === "user" ? undefined : await workspaceTrustWarning(root);
  if (!added) return { file, added: false, warning };

  await fs.mkdir(path.dirname(file), { recursive: true });
  // Same directory as the target: `rename` is only atomic within a filesystem,
  // and the OS temp dir is frequently a different one.
  const temp = `${file}.luno-${process.pid}.tmp`;
  try {
    await fs.writeFile(temp, text, { mode: 0o600 });
    await fs.rename(temp, file);
  } catch (err) {
    await fs.unlink(temp).catch(() => undefined);
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(`${file} could not be written (${why}).`, { cause: err });
  }
  return { file, added: true, warning };
}
