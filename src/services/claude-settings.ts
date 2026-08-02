// ─────────────────────────────────────────────────────────────
// The user's own Claude Code settings, for the handful of keys that
// change how a shared surface behaves.
//
// LUNO has its own `luno.*` settings in VS Code. This file is not
// those: it reads `~/.claude/settings.json`, the file the CLI itself
// reads, so a preference the user already set for Claude Code is
// honoured here rather than needing setting twice.
// ─────────────────────────────────────────────────────────────

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PermissionMode } from "../core/types.js";
import type { EffortLevel } from "../providers/claude-cli.js";

/**
 * "Question auto-continue timeout" — how long an `AskUserQuestion` waits
 * before answering itself with whatever is selected. Milliseconds, or `null`
 * for no deadline.
 *
 * The values and their mapping are the CLI's own (claude 2.1.219): `"60s"`,
 * `"5m"`, `"10m"`, `"never"`, with **unset meaning `never`**. That default
 * matters — it is why a question in Claude Code waits indefinitely, and why
 * this is not a countdown LUNO may invent on its own.
 *
 * The countdown itself is a client feature, not a CLI one: the CLI blocks on
 * the permission response and has no timer behind it, so whoever renders the
 * question owns the deadline.
 */
export function askUserQuestionTimeoutMs(): number | null {
  switch (readSetting("askUserQuestionTimeout")) {
    case "60s":
      return 60_000;
    case "5m":
      return 300_000;
    case "10m":
      return 600_000;
    default:
      return null;
  }
}

/**
 * Permission modes the user's settings forbid, and which LUNO must therefore
 * not offer.
 *
 * `permissions.disableBypassPermissionsMode` is the CLI's own key for "this
 * machine may not turn the approval gate off", and the official client drops
 * the entry from its picker when it is set. A mode that is refused the moment
 * it is chosen is worse than one that was never on the menu.
 *
 * Deliberately one key, not two. `allowDangerouslySkipPermissions` is the
 * reference's *enabling* condition — it hides Bypass unless the setting is
 * present — and adopting that would take the mode away from users who never
 * asked for a policy at all. A prohibition is honoured; a permission LUNO never
 * required is not newly demanded.
 *
 * `disableAutoMode` is absent for a different reason: nothing here has to read
 * it. Measured against 2.1.219 — a CLI asked for `--permission-mode auto` while
 * the key forbids it downgrades in silence and reports `default` on
 * `system/init`, which is exactly the signal `nativeAutoLive()` already reads.
 * The mode stops being used without anyone here deciding that it should.
 */
export function disabledPermissionModes(): string[] {
  const permissions = readSetting("permissions");
  if (!permissions || typeof permissions !== "object") return [];
  const disabled = (permissions as Record<string, unknown>)
    .disableBypassPermissionsMode;
  return disabled === "disable" ? ["bypass"] : [];
}

export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
}

/**
 * The directory an administrator's policy file lives in.
 *
 * READ from the reference bundle, which switches on the platform exactly like
 * this. Not inferred, and not to be "tidied" into one cross-platform path.
 */
export function managedSettingsDir(): string {
  switch (process.platform) {
    case "darwin":
      return "/Library/Application Support/ClaudeCode";
    case "win32":
      return "C:\\Program Files\\ClaudeCode";
    default:
      return "/etc/claude-code";
  }
}

/**
 * The tiers a setting can come from, **highest authority first**.
 *
 * This order is a corporate contract, not a preference: an administrator who
 * pins a value in managed settings has to win over anything the user or the
 * project says. Inventing an order here would be a bug at the client rather
 * than a freedom.
 *
 * `project` and `local` need a workspace folder; absent one they contribute
 * nothing rather than falling back to somewhere else.
 */
function settingsTiers(root?: string, ownedOnly = false): string[] {
  const files = [path.join(managedSettingsDir(), "managed-settings.json")];
  if (root && !ownedOnly) {
    files.push(path.join(root, ".claude", "settings.local.json"));
    files.push(path.join(root, ".claude", "settings.json"));
  }
  files.push(path.join(claudeConfigDir(), "settings.json"));
  return files;
}

function readJsonObject(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    // No file, unreadable, or not JSON. A missing preference is not an error
    // and must never take a permission prompt down with it.
    return null;
  }
}

/**
 * One key, from the highest tier that sets it.
 *
 * Was the user tier alone, which was honest while nothing here acted on a
 * restriction — the CLI would enforce an admin policy regardless of what LUNO
 * rendered. It stopped being honest once the panel began *filtering* on these
 * values: a picker that ignores `availableModels` does not merely fail to
 * help, it overrules the policy on the user's behalf.
 */
export function readSetting(key: string, root?: string): unknown {
  for (const file of settingsTiers(root)) {
    const value = readJsonObject(file)?.[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * The same, but only from the tiers the person or their administrator owns.
 *
 * The project pair is committed and travels with a clone. For most keys that
 * is exactly right — a repository saying which model suits it is useful. For
 * anything that can **loosen a permission** it is not: a cloned repository
 * must not be able to start LUNO in a mode that turns its own gate off, and
 * `permissions.defaultMode` in a shared `.claude/settings.json` would do
 * precisely that.
 */
function readOwnedSetting(key: string, root?: string): unknown {
  for (const file of settingsTiers(root, true)) {
    const value = readJsonObject(file)?.[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * The restrictions an administrator has placed on this machine.
 *
 * Read together rather than one at a time, because they are read on every
 * model list and every spawn, and because `enforceAvailableModels` means
 * nothing without the list it enforces.
 */
export function modelPolicy(root?: string): {
  availableModels?: string[];
  enforceAvailableModels?: boolean;
} {
  const list = readSetting("availableModels", root);
  return {
    availableModels: Array.isArray(list)
      ? list.filter((m): m is string => typeof m === "string")
      : undefined,
    enforceAvailableModels: readSetting("enforceAvailableModels", root) === true
  };
}

/**
 * Claude's own preferences, for the keys a LUNO conversation is born with.
 *
 * **Preferences, not restrictions.** Each is a default the user's own `luno.*`
 * value overrides and the per-conversation pickers override again. The
 * restrictions — `availableModels`, `disableBypassPermissionsMode` — are
 * enforced elsewhere and cannot be overridden by either.
 *
 * Every value is validated against the schema's own enum rather than trusted,
 * because these files are hand-edited and a typo must not become a mode.
 */
export function claudePreferences(root?: string): {
  model?: string;
  defaultMode?: PermissionMode;
  effort?: EffortLevel;
  thinking?: boolean;
} {
  const model = readSetting("model", root);
  // Owned tiers only — a cloned repo must not be able to pick the mode.
  const permissions = readOwnedSetting("permissions", root);
  const rawMode =
    permissions &&
    typeof permissions === "object" &&
    !Array.isArray(permissions)
      ? (permissions as Record<string, unknown>).defaultMode
      : undefined;
  const thinking = readSetting("alwaysThinkingEnabled", root);
  return {
    model: typeof model === "string" && model.trim() ? model.trim() : undefined,
    defaultMode: lunoPermissionMode(rawMode),
    effort: claudeEffortLevel(readSetting("effortLevel", root)),
    thinking: typeof thinking === "boolean" ? thinking : undefined
  };
}

/**
 * Claude's `permissions.defaultMode` in LUNO's own vocabulary, or undefined
 * when it names a mode this panel has no surface for.
 *
 * `manual` is the CLI's documented alias for `default` — READ from the schema.
 * `dontAsk` has no LUNO equivalent and is deliberately dropped rather than
 * guessed at: mapping it to `bypass` would turn a mode the admin chose into a
 * stronger one they did not.
 */
function lunoPermissionMode(raw: unknown): PermissionMode | undefined {
  switch (raw) {
    case "default":
    case "manual":
      return "default";
    case "acceptEdits":
      return "acceptEdits";
    case "auto":
      return "auto";
    case "plan":
      return "plan";
    case "bypassPermissions":
      return "bypass";
    default:
      return undefined;
  }
}

/**
 * Claude's `effortLevel`, which has **no `max`**.
 *
 * The schema's enum is `low | medium | high | xhigh` while LUNO's picker and
 * `--effort` both accept `max`. Reading someone else's value must never widen
 * it: a settings file that says `xhigh` is not permission to run `max`, and a
 * panel that quietly raised the level would be spending on an intensity the
 * person never chose.
 */
function claudeEffortLevel(raw: unknown): EffortLevel | undefined {
  switch (raw) {
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return raw;
    default:
      return undefined;
  }
}
