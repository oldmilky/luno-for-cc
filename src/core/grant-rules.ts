// ─────────────────────────────────────────────────────────────
// Two decisions about a standing grant, and neither of them writes anything.
//
// 1. How it reads as a CLI permission rule.
// 2. Whether it may go into a settings file **at all**.
//
// The second is the load-bearing one, and it is not a formality.
//
// Today a grant is only ever consulted inside the branch the destructive and
// network gates have already declined — that is structural in
// `decidePermission`, not a check someone remembered to write. A grant copied
// into `permissions.allow` leaves that structure behind: the CLI then stops
// asking us about the call at all. Not "asks and we allow" — **does not ask**.
// Our gate is off the path, permanently and silently.
//
// So the rule is: only a grant our own gate would also allow is eligible for a
// file. Everything else stays in `globalState`, where the gate still runs.
//
// The gate is imported rather than re-stated. A second copy of "what is
// destructive" would drift from the first, and the drift would be invisible
// until it mattered. That import points outward, at `providers/`, which is the
// wrong direction for a `core/` module — the gate is pure policy and belongs in
// here, but moving it means moving the shell-command parser it shares with the
// approval card, out of the largest file in the repo. That is its own change,
// not a rider on this one; `core/orchestrator.ts` already reaches outward the
// same way.
// ─────────────────────────────────────────────────────────────

import {
  isConditionallyGatedBash,
  isDestructiveRequest,
  isNetworkRequest
} from "../providers/claude-cli.js";
import type { ToolGrant } from "./tool-grants.js";

/** Shell metacharacters a prefix must not contain. `grantFor` refuses to build
 *  such a grant, so this only catches one read back from storage written by an
 *  older build — which is exactly the case a permission check must survive. */
const SHELL_COMPOSITION = /[|&;<>`\n]|\$\(/;

/** A tool name that cannot be written as a rule without changing its meaning:
 *  the rule syntax is `Tool` or `Tool(argument)`, so a name carrying either
 *  bracket or whitespace has no faithful spelling. */
const UNEXPRESSIBLE_TOOL = /[()\s]/;

export interface GrantEligibility {
  /** True when this grant may be written into a settings file. */
  eligible: boolean;
  /** Why not, phrased for the approval card to show. Present only when
   *  `eligible` is false — the card says which case it is in words rather than
   *  by leaving an option quietly absent. */
  reason?: string;
}

/**
 * The grant as a CLI permission rule, or `null` when it has no faithful
 * spelling.
 *
 * | Grant                             | Rule              |
 * | --------------------------------- | ----------------- |
 * | `{tool:"Bash", prefix:"bun run"}` | `Bash(bun run:*)` |
 * | `{tool:"Write"}`                  | `Write`           |
 * | `{tool:"mcp__x__y"}`              | `mcp__x__y`       |
 *
 * `:*` is **Bash-prefix syntax only** — READ from the reference. Every grant
 * carrying a prefix is a shell grant, because `grantFor` gives a prefix to
 * nothing else, so there is no second argument shape to express here. A grant
 * that somehow arrives with a prefix on a non-shell tool gets `null` rather
 * than a rule in a syntax that means something else.
 */
export function grantToCliRule(grant: ToolGrant): string | null {
  const tool = grant.tool?.trim();
  if (!tool || UNEXPRESSIBLE_TOOL.test(tool)) return null;
  if (grant.prefix === undefined) return tool;

  const prefix = grant.prefix.trim();
  if (!prefix) return null;
  if (SHELL_COMPOSITION.test(prefix) || prefix.includes(")")) return null;
  return `${tool}(${prefix}:*)`;
}

/**
 * May this grant be written into a settings file?
 *
 * Answered by running the real destructive and network gates over the grant —
 * the same two predicates `decidePermission` consults, imported rather than
 * restated. A grant that either gate would stop is refused here, because once
 * the rule is in a file the gate no longer runs at all.
 *
 * A shell grant is judged on its **prefix**, which is the whole of what the
 * rule would cover from our side: `{tool:"Bash", prefix:"git push"}` is refused
 * because `git push` reaches the network, not because the call that produced it
 * did.
 */
export function grantFileEligibility(grant: ToolGrant): GrantEligibility {
  if (grantToCliRule(grant) === null) {
    return {
      eligible: false,
      reason: "This grant has no faithful spelling as a settings rule."
    };
  }

  // A shell grant's prefix is presented to the gate as the command, because
  // the prefix is what the written rule would cover.
  const input =
    grant.prefix === undefined ? undefined : { command: grant.prefix };

  if (isDestructiveRequest(grant.tool, input)) {
    return {
      eligible: false,
      reason:
        "Destructive calls are never written to a settings file — the CLI would stop asking, and LUNO's own check would stop running. This grant stays in LUNO, where it still meets that check."
    };
  }
  if (isNetworkRequest(grant.tool, input)) {
    return {
      eligible: false,
      reason:
        "Calls that reach the network are never written to a settings file — the CLI would stop asking, and LUNO's own check would stop running. This grant stays in LUNO, where it still meets that check."
    };
  }
  // The gates above judge the prefix as written. A rule does not stop there:
  // `Bash(git reset:*)` covers `git reset --hard`, and `git reset` alone passes
  // both. So a prefix whose own arguments could carry it into a gated form is
  // refused as well — the check the two gates cannot make on their own.
  if (grant.prefix !== undefined && isConditionallyGatedBash(grant.prefix)) {
    return {
      eligible: false,
      reason:
        "A settings rule covers this command with any arguments, and some of them would be destructive or reach the network. This grant stays in LUNO, where each call is judged on what it actually runs."
    };
  }
  return { eligible: true };
}
