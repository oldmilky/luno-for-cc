// ─────────────────────────────────────────────────────────────
// The permission rules already in force, read out of the settings files the
// CLI itself reads.
//
// **This module displays; it does not enforce.** The CLI already applies these
// rules — MEASURED in `.claude/plans/carried-forward.md`: a matched `ask` rule
// makes it skip its own classifier and prompt us, and a matched `allow` means
// it never asks at all. Re-implementing that here would be a second, divergent
// policy engine. What LUNO adds is that the user can *see* them, which today
// they cannot at all.
//
// Pure — reading the files is `services/permission-sources.ts`, which is the
// half that needs a filesystem and a workspace root.
// ─────────────────────────────────────────────────────────────

/** Where a rule came from, in the CLI's own vocabulary. */
export type RuleSource = "managed" | "project" | "local" | "user";

/** What the rule does. `deny` wins over `allow` wherever they meet, which is
 *  the CLI's rule and not ours to change. */
export type RuleKind = "allow" | "deny" | "ask";

export interface PermissionRule {
  source: RuleSource;
  kind: RuleKind;
  /** The pattern as written — `Bash(git push:*)`, `Write`, `mcp__x__y`. */
  rule: string;
  /** Absolute path of the file it was read from, so the user can open it. */
  file: string;
  /** 1-based, best effort. Absent when the rule could not be located in the
   *  raw text — a jump-to affordance, never a correctness claim. */
  line?: number;
}

/** A source that exists but could not be used. Rendered rather than swallowed:
 *  "no managed settings" and "managed settings we failed to parse" are very
 *  different facts, and only one of them is safe to act on. */
export interface UnreadableSource {
  source: RuleSource;
  file: string;
  reason: string;
}

export interface PermissionRuleSet {
  rules: PermissionRule[];
  unreadable: UnreadableSource[];
}

/** One settings file, already read off disk. */
export interface SourceFile {
  source: RuleSource;
  file: string;
  /** Raw text. `null` means the file is not there, which is not a problem and
   *  is not reported. */
  text: string | null;
  /** Set when the file exists but could not be read — a permissions error on a
   *  policy file, say. Carried as its own field rather than smuggled through
   *  `text`, which would report a JSON syntax error instead of the real cause. */
  error?: string;
}

const KINDS: readonly RuleKind[] = ["deny", "ask", "allow"];

/**
 * Authority order, highest first — the order the list is shown in.
 *
 * It is **not** a claim about which rule wins: that is the CLI's resolution and
 * this module deliberately does not reproduce it. It is the order a reader
 * scans for "who did this to me", which puts the tier they cannot change at the
 * top.
 */
const SOURCE_ORDER: readonly RuleSource[] = [
  "managed",
  "project",
  "local",
  "user"
];

/**
 * Pull every `permissions.{allow,deny,ask}` entry out of the given files.
 *
 * A file that is missing contributes nothing and says nothing. A file that is
 * present but broken contributes an `unreadable` entry, because an admin policy
 * that failed to parse must never read as "there is no policy".
 */
export function parsePermissionRules(
  files: ReadonlyArray<SourceFile>
): PermissionRuleSet {
  const rules: PermissionRule[] = [];
  const unreadable: UnreadableSource[] = [];

  for (const f of files) {
    if (f.error) {
      unreadable.push({ source: f.source, file: f.file, reason: f.error });
      continue;
    }
    if (f.text === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(f.text);
    } catch (err) {
      unreadable.push({
        source: f.source,
        file: f.file,
        reason: err instanceof Error ? err.message : "not valid JSON"
      });
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      unreadable.push({
        source: f.source,
        file: f.file,
        reason: "the file is not a JSON object"
      });
      continue;
    }
    const permissions = (parsed as Record<string, unknown>).permissions;
    if (permissions === undefined) continue;
    if (
      !permissions ||
      typeof permissions !== "object" ||
      Array.isArray(permissions)
    ) {
      unreadable.push({
        source: f.source,
        file: f.file,
        reason: "`permissions` is not an object"
      });
      continue;
    }
    for (const kind of KINDS) {
      const list = (permissions as Record<string, unknown>)[kind];
      if (list === undefined) continue;
      if (!Array.isArray(list)) {
        unreadable.push({
          source: f.source,
          file: f.file,
          reason: `\`permissions.${kind}\` is not an array`
        });
        continue;
      }
      for (const entry of list) {
        if (typeof entry !== "string" || entry.length === 0) continue;
        rules.push({
          source: f.source,
          kind,
          rule: entry,
          file: f.file,
          line: lineOf(f.text, kind, entry)
        });
      }
    }
  }

  return { rules: sortRules(rules), unreadable };
}

/**
 * Add one `allow` rule to a settings file's text, leaving everything else
 * exactly as it was.
 *
 * Pure, and deliberately so: this is the only function in the wave that decides
 * what a user's own settings file will contain, and it is the one place a bug
 * would be invisible until it had already overwritten something.
 *
 * @param text the file as it is now, or `null` when it does not exist yet.
 * @returns the new text, and whether anything changed. `added: false` means the
 *   rule was already there — the caller writes nothing rather than rewriting a
 *   file to the same content.
 * @throws when the file exists but is not a JSON object, or its `permissions`
 *   is not one. Refusing is the point: merging into something we do not
 *   understand is how a settings file gets destroyed.
 */
export function mergeAllowRule(
  text: string | null,
  rule: string
): { text: string; added: boolean } {
  const raw = text?.trim();
  let root: Record<string, unknown>;
  if (!raw) {
    root = {};
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("the file is not valid JSON — it was left untouched");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("the file is not a JSON object — it was left untouched");
    }
    root = { ...(parsed as Record<string, unknown>) };
  }

  const existing = root.permissions;
  if (
    existing !== undefined &&
    (!existing || typeof existing !== "object" || Array.isArray(existing))
  ) {
    throw new Error("`permissions` is not an object — the file was left alone");
  }
  const permissions: Record<string, unknown> = {
    ...((existing as Record<string, unknown> | undefined) ?? {})
  };

  const allow = permissions.allow;
  if (allow !== undefined && !Array.isArray(allow)) {
    throw new Error(
      "`permissions.allow` is not an array — the file was left alone"
    );
  }
  const list = [...((allow as unknown[] | undefined) ?? [])];
  if (list.includes(rule)) return { text: raw ? text! : "", added: false };

  list.push(rule);
  permissions.allow = list;
  root.permissions = permissions;
  // Two-space indent and a trailing newline: what every `.claude/settings.json`
  // in the wild already looks like, and what an editor will not re-diff.
  return { text: `${JSON.stringify(root, null, 2)}\n`, added: true };
}

/** Highest authority first, then deny before ask before allow, then
 *  alphabetically — so the same files always render in the same order. */
export function sortRules(rules: PermissionRule[]): PermissionRule[] {
  const bySource = (r: PermissionRule) => SOURCE_ORDER.indexOf(r.source);
  const byKind = (r: PermissionRule) => KINDS.indexOf(r.kind);
  return [...rules].sort(
    (a, b) =>
      bySource(a) - bySource(b) ||
      byKind(a) - byKind(b) ||
      a.rule.localeCompare(b.rule)
  );
}

/**
 * Which line a rule sits on, for the "open the file there" jump.
 *
 * Deliberately textual rather than a real JSON parse with positions: the same
 * pattern can appear under two kinds, so the search starts at the key it
 * belongs to. Best effort by construction — a wrong line opens the right file
 * in the wrong place, which is a nuisance; a wrong *rule* would be a lie, and
 * the rule itself comes from the parse, not from here.
 */
function lineOf(
  text: string,
  kind: RuleKind,
  rule: string
): number | undefined {
  const keyAt = text.indexOf(`"${kind}"`);
  const from = keyAt === -1 ? 0 : keyAt;
  const at = text.indexOf(JSON.stringify(rule), from);
  if (at === -1) return undefined;
  return text.slice(0, at).split("\n").length;
}
