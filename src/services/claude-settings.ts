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
 * One key out of the user settings tier.
 *
 * The CLI resolves this key across three tiers — policy, flag, user — and
 * takes the highest that set it. Only the last is a plain file on disk; the
 * other two are managed/enterprise layers whose resolution is a good deal of
 * the CLI's settings module. Reading the user tier alone covers every case a
 * person sets for themselves, and an admin policy that overrides it will be
 * honoured by the CLI regardless of what we render.
 */
function readSetting(key: string): unknown {
  try {
    const raw = fs.readFileSync(
      path.join(claudeConfigDir(), "settings.json"),
      "utf8"
    );
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return (parsed as Record<string, unknown>)[key];
  } catch {
    // No file, unreadable, or not JSON. A missing preference is not an error
    // and must never take a permission prompt down with it.
    return undefined;
  }
}
