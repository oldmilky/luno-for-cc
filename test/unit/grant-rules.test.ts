import { describe, it, expect } from "vitest";
import {
  grantFileEligibility,
  grantToCliRule
} from "../../src/core/grant-rules.js";
import { grantFor } from "../../src/core/tool-grants.js";
import type { ToolGrant } from "../../src/core/tool-grants.js";

const bash = (prefix: string): ToolGrant => ({ tool: "Bash", prefix });

describe("grantToCliRule — the three shapes the plan names", () => {
  it("writes a shell grant with the CLI's prefix wildcard", () => {
    expect(grantToCliRule(bash("bun run"))).toBe("Bash(bun run:*)");
  });

  it("writes a plain tool grant as the bare tool name", () => {
    expect(grantToCliRule({ tool: "Write" })).toBe("Write");
  });

  it("writes an MCP tool under its own full id", () => {
    expect(grantToCliRule({ tool: "mcp__x__y" })).toBe("mcp__x__y");
  });
});

describe("grantToCliRule — what it refuses to spell", () => {
  it("refuses a grant with no tool at all", () => {
    expect(grantToCliRule({ tool: "" })).toBeNull();
    expect(grantToCliRule({ tool: "   " })).toBeNull();
  });

  it("refuses a tool name that would break the rule syntax", () => {
    // `Tool(argument)` is the syntax; a name carrying a bracket or a space has
    // no spelling that still means the same thing.
    expect(grantToCliRule({ tool: "Bash(rm)" })).toBeNull();
    expect(grantToCliRule({ tool: "My Tool" })).toBeNull();
  });

  it("refuses a prefix carrying shell composition", () => {
    // `grantFor` will not build one; storage written by an older build might.
    for (const prefix of ["bun run && rm -rf /", "a | b", "a; b", "$(evil)"]) {
      expect(grantToCliRule(bash(prefix))).toBeNull();
    }
  });

  it("refuses a prefix that would close the rule's own bracket", () => {
    expect(grantToCliRule(bash("x) Write(y"))).toBeNull();
  });

  it("refuses an empty prefix rather than writing a bare tool rule", () => {
    // `Bash` and `Bash(:*)` are different permissions; silently widening one
    // into the other is the whole class of mistake this module exists to avoid.
    expect(grantToCliRule(bash(""))).toBeNull();
    expect(grantToCliRule(bash("   "))).toBeNull();
  });
});

describe("grantFileEligibility — only what our own gate would allow", () => {
  it("lets an ordinary build command through", () => {
    expect(grantFileEligibility(bash("bun run"))).toEqual({ eligible: true });
    expect(grantFileEligibility(bash("npm test"))).toEqual({ eligible: true });
  });

  it("lets an ordinary tool grant through", () => {
    expect(grantFileEligibility({ tool: "Write" })).toEqual({ eligible: true });
    expect(grantFileEligibility({ tool: "mcp__linear__list_issues" })).toEqual({
      eligible: true
    });
  });

  // ── The mutation the Done-when names ────────────────────────────────────
  //
  // Delete the `isDestructiveRequest` call in `grantFileEligibility` and every
  // test in this block goes red. That is the point of them: the rule is pinned
  // by what it refuses, not by a reader agreeing that it looks right.
  it("refuses a destructive shell prefix", () => {
    for (const prefix of ["rm -rf", "dd if=/dev/zero", "shred -u"]) {
      const verdict = grantFileEligibility(bash(prefix));
      expect(verdict.eligible).toBe(false);
      expect(verdict.reason).toContain("Destructive");
    }
  });

  it("refuses a tool whose name reads like a deletion", () => {
    const verdict = grantFileEligibility({ tool: "mcp__store__delete_record" });
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toContain("Destructive");
  });

  it("refuses a destructive git prefix", () => {
    expect(grantFileEligibility(bash("git reset --hard")).eligible).toBe(false);
  });
});

describe("grantFileEligibility — a safe prefix with an unsafe extension", () => {
  // The hole a written rule opens and the two gates cannot see: `Bash(x:*)`
  // covers `x` plus anything, and for several commands the "anything" is what
  // was being guarded against.
  it("refuses `git reset`, whose --hard the rule would carry along", () => {
    // `git reset` passes both gates as written — only `--hard` is destructive.
    const verdict = grantFileEligibility(bash("git reset"));
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toContain("any arguments");
  });

  it("refuses `git` alone, which reaches every gated subcommand", () => {
    expect(grantFileEligibility(bash("git")).eligible).toBe(false);
  });

  it("refuses a command gated only by its arguments", () => {
    // `chmod` is destructive recursively; `find` is, with -delete. Both pass
    // the gates bare, and a rule would hand them their own dangerous flag.
    expect(grantFileEligibility(bash("chmod")).eligible).toBe(false);
    expect(grantFileEligibility(bash("find")).eligible).toBe(false);
  });

  it("still allows a git subcommand that no argument makes dangerous", () => {
    // The rule has to keep something worth granting, or it is not a boundary
    // but a refusal. `git status --short` is not a different kind of thing.
    expect(grantFileEligibility(bash("git status")).eligible).toBe(true);
    expect(grantFileEligibility(bash("git log")).eligible).toBe(true);
  });

  it("still allows the build commands this feature exists for", () => {
    for (const prefix of ["bun run", "npm test", "pnpm build", "cargo check"]) {
      expect(grantFileEligibility(bash(prefix)).eligible).toBe(true);
    }
  });

  // ── The same, for the network half ──────────────────────────────────────
  it("refuses a shell prefix that reaches the network", () => {
    for (const prefix of ["curl", "wget", "ssh", "git push"]) {
      const verdict = grantFileEligibility(bash(prefix));
      expect(verdict.eligible).toBe(false);
      expect(verdict.reason).toContain("network");
    }
  });

  it("refuses a tool whose name reads like a fetch", () => {
    const verdict = grantFileEligibility({ tool: "WebFetch" });
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toContain("network");
    // And that is also why the reference's `WebFetch(domain:…)` syntax never
    // has to be expressed here: no WebFetch grant is ever file-eligible.
    expect(grantToCliRule({ tool: "WebFetch" })).toBe("WebFetch");
  });

  it("refuses anything it could not spell as a rule", () => {
    const verdict = grantFileEligibility(bash("a && b"));
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toContain("faithful spelling");
  });

  it("gives a reason for every refusal, and none for a pass", () => {
    // The card says which case it is in words. A refusal with no reason would
    // show as an option quietly missing, which is the failure this prevents.
    const refused = [bash("rm -rf"), bash("curl"), bash("a | b")];
    for (const g of refused) {
      const v = grantFileEligibility(g);
      expect(v.eligible).toBe(false);
      expect(v.reason && v.reason.length > 20).toBe(true);
    }
    expect(grantFileEligibility(bash("bun run")).reason).toBeUndefined();
  });
});

describe("grantFileEligibility — against grants the card actually offers", () => {
  // `grantFor` is what builds a grant from a real call, so these are the
  // shapes that can genuinely reach the writer rather than ones invented here.
  const from = (tool: string, command?: string) =>
    grantFor(tool, command === undefined ? undefined : { command });

  it("passes the grant a safe build command produces", () => {
    const grant = from("Bash", "bun run lint --fix");
    expect(grant).toEqual({ tool: "Bash", prefix: "bun run" });
    expect(grantFileEligibility(grant!).eligible).toBe(true);
  });

  it("refuses the grant a network command produces", () => {
    const grant = from("Bash", "curl https://example.com");
    expect(grant).not.toBeNull();
    expect(grantFileEligibility(grant!).eligible).toBe(false);
  });

  it("has nothing to judge for a composed command, which is offered no grant", () => {
    // The first line of defence is that no grant is created at all; this is
    // the second, and neither is load-bearing alone.
    expect(from("Bash", "bun run x && rm -rf /")).toBeNull();
  });

  it("passes a plain edit-tool grant", () => {
    const grant = from("Write", undefined);
    expect(grant).toEqual({ tool: "Write" });
    expect(grantFileEligibility(grant!).eligible).toBe(true);
  });
});
