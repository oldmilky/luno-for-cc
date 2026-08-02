import { describe, it, expect } from "vitest";
import {
  parsePermissionRules,
  sortRules,
  type PermissionRule,
  type SourceFile
} from "../../src/core/permission-rules.js";

/** A settings file, written the way a person would write it, so the line
 *  numbers under test are the ones they would see. */
function file(
  source: SourceFile["source"],
  permissions: unknown,
  name = `/w/${source}.json`
): SourceFile {
  return {
    source,
    file: name,
    text: JSON.stringify({ permissions }, null, 2)
  };
}

const ruleNames = (rules: PermissionRule[]) => rules.map((r) => r.rule);

describe("parsePermissionRules — what it finds", () => {
  it("reads allow, deny and ask out of one file", () => {
    const { rules } = parsePermissionRules([
      file("user", {
        allow: ["Read", "mcp__x__y"],
        deny: ["Bash(curl:*)"],
        ask: ["Bash(git push:*)"]
      })
    ]);
    expect(ruleNames(rules).sort()).toEqual([
      "Bash(curl:*)",
      "Bash(git push:*)",
      "Read",
      "mcp__x__y"
    ]);
    expect(rules.every((r) => r.source === "user")).toBe(true);
  });

  it("keeps every source apart, so the badge can say who set it", () => {
    const { rules } = parsePermissionRules([
      file("managed", { deny: ["Bash(rm:*)"] }),
      file("project", { ask: ["Write"] }),
      file("local", { allow: ["Read"] }),
      file("user", { allow: ["Glob"] })
    ]);
    expect(rules.map((r) => [r.source, r.rule])).toEqual([
      ["managed", "Bash(rm:*)"],
      ["project", "Write"],
      ["local", "Read"],
      ["user", "Glob"]
    ]);
  });

  it("carries the file each rule came from, so it can be opened", () => {
    const { rules } = parsePermissionRules([
      file("project", { allow: ["Read"] }, "/work/app/.claude/settings.json")
    ]);
    expect(rules[0].file).toBe("/work/app/.claude/settings.json");
  });

  it("finds the line a rule sits on", () => {
    const text = [
      "{",
      '  "permissions": {',
      '    "allow": [',
      '      "Read",',
      '      "Write"',
      "    ]",
      "  }",
      "}"
    ].join("\n");
    const { rules } = parsePermissionRules([
      { source: "user", file: "/w/s.json", text }
    ]);
    expect(rules.find((r) => r.rule === "Read")!.line).toBe(4);
    expect(rules.find((r) => r.rule === "Write")!.line).toBe(5);
  });

  it("finds the right line when the same pattern is under two kinds", () => {
    // The textual search starts at the key the rule belongs to, which is the
    // only reason these two do not both report the first occurrence.
    const text = [
      "{",
      '  "permissions": {',
      '    "deny": [',
      '      "Write"',
      "    ],",
      '    "allow": [',
      '      "Write"',
      "    ]",
      "  }",
      "}"
    ].join("\n");
    const { rules } = parsePermissionRules([
      { source: "user", file: "/w/s.json", text }
    ]);
    expect(rules.find((r) => r.kind === "deny")!.line).toBe(4);
    expect(rules.find((r) => r.kind === "allow")!.line).toBe(7);
  });

  it("still lists a rule whose line cannot be located", () => {
    // The rule comes from the parse; the line is a jump-to convenience. Losing
    // the second must never lose the first.
    const { rules } = parsePermissionRules([
      {
        source: "user",
        file: "/w/s.json",
        // Escaped differently from how `JSON.stringify` would write it, so the
        // textual search misses while the parse succeeds.
        text: '{"permissions":{"allow":["\\u0052ead"]}}'
      }
    ]);
    expect(rules).toHaveLength(1);
    expect(rules[0].rule).toBe("Read");
    expect(rules[0].line).toBeUndefined();
  });
});

describe("parsePermissionRules — what it refuses to guess", () => {
  it("says nothing at all about a file that is not there", () => {
    const { rules, unreadable } = parsePermissionRules([
      { source: "managed", file: "/nope.json", text: null }
    ]);
    expect(rules).toEqual([]);
    expect(unreadable).toEqual([]);
  });

  it("reports a policy file that failed to parse, rather than reading as no policy", () => {
    // The distinction this whole module turns on: a broken managed policy is
    // not an absent one, and only the second is safe to act on.
    const { rules, unreadable } = parsePermissionRules([
      { source: "managed", file: "/m.json", text: "{ oops" }
    ]);
    expect(rules).toEqual([]);
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]).toMatchObject({ source: "managed", file: "/m.json" });
    expect(unreadable[0].reason.length).toBeGreaterThan(0);
  });

  it("reports a file that could not be read at all, with the real cause", () => {
    const { unreadable } = parsePermissionRules([
      {
        source: "managed",
        file: "/m.json",
        text: null,
        error: "could not be read (EACCES)"
      }
    ]);
    expect(unreadable[0].reason).toBe("could not be read (EACCES)");
  });

  it("reports a `permissions` key that is not an object", () => {
    const { unreadable } = parsePermissionRules([
      { source: "user", file: "/u.json", text: '{"permissions": "all"}' }
    ]);
    expect(unreadable[0].reason).toContain("not an object");
  });

  it("reports one malformed list without losing the others in the same file", () => {
    const { rules, unreadable } = parsePermissionRules([
      {
        source: "user",
        file: "/u.json",
        text: '{"permissions":{"allow":["Read"],"deny":"Bash"}}'
      }
    ]);
    expect(ruleNames(rules)).toEqual(["Read"]);
    expect(unreadable[0].reason).toContain(
      "`permissions.deny` is not an array"
    );
  });

  it("stays quiet about a settings file with no permissions block", () => {
    const { rules, unreadable } = parsePermissionRules([
      { source: "user", file: "/u.json", text: '{"model": "sonnet"}' }
    ]);
    expect(rules).toEqual([]);
    expect(unreadable).toEqual([]);
  });

  it("drops entries that are not non-empty strings", () => {
    const { rules } = parsePermissionRules([
      {
        source: "user",
        file: "/u.json",
        text: '{"permissions":{"allow":["Read", "", 42, null, {"tool":"x"}]}}'
      }
    ]);
    expect(ruleNames(rules)).toEqual(["Read"]);
  });

  it("survives a top-level array where an object was expected", () => {
    const { unreadable } = parsePermissionRules([
      { source: "user", file: "/u.json", text: "[]" }
    ]);
    expect(unreadable[0].reason).toContain("not a JSON object");
  });
});

describe("sortRules — a list that reads the same every time", () => {
  const rule = (
    source: PermissionRule["source"],
    kind: PermissionRule["kind"],
    name: string
  ): PermissionRule => ({ source, kind, rule: name, file: "/f" });

  it("puts the tier the user cannot change at the top", () => {
    const sorted = sortRules([
      rule("user", "allow", "a"),
      rule("local", "allow", "a"),
      rule("managed", "allow", "a"),
      rule("project", "allow", "a")
    ]);
    expect(sorted.map((r) => r.source)).toEqual([
      "managed",
      "project",
      "local",
      "user"
    ]);
  });

  it("puts deny before ask before allow within a source", () => {
    const sorted = sortRules([
      rule("user", "allow", "a"),
      rule("user", "deny", "a"),
      rule("user", "ask", "a")
    ]);
    expect(sorted.map((r) => r.kind)).toEqual(["deny", "ask", "allow"]);
  });

  it("orders the rest alphabetically, so two runs never differ", () => {
    const sorted = sortRules([
      rule("user", "allow", "Write"),
      rule("user", "allow", "Read"),
      rule("user", "allow", "Glob")
    ]);
    expect(ruleNames(sorted)).toEqual(["Glob", "Read", "Write"]);
  });

  it("does not mutate what it was given", () => {
    const input = [rule("user", "allow", "b"), rule("managed", "deny", "a")];
    const before = [...input];
    sortRules(input);
    expect(input).toEqual(before);
  });
});
