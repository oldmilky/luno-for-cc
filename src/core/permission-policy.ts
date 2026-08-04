// ─────────────────────────────────────────────────────────────
// The permission classifier: what a tool call is, and what should happen to it.
//
// **This module decides; it does not ask, spawn or render.** No process, no
// filesystem, no VS Code — `decidePermission` takes a tool name, its input and
// an injected context, and returns allow / prompt / deny. That is what puts it
// in `core/` rather than beside the CLI provider that consumes it, and it is
// what lets the whole policy be unit-tested without a `claude` binary.
//
// It also settles a layering inversion: `core/grant-rules.ts` used to reach up
// into `providers/claude-cli.ts` for the two gate predicates, because that is
// where they happened to live.
//
// The gate that matters is first and cannot be reached past: destructive and
// network calls prompt in every mode. Everything below only decides how much
// of the harmless remainder still interrupts.
//
// What deliberately stayed with the provider: `afkTimeout` (reads settings off
// disk) and `offeredGrantLabel` (shapes an approval card's payload). Both are
// about presenting a decision, not making one.
// ─────────────────────────────────────────────────────────────

import { coveredByGrants, type ToolGrant } from "./tool-grants.js";
import type { PermissionBehavior } from "./types.js";

/** Tools that are surfaced through their own dedicated UI by the orchestrator's
 *  PlanInterceptor (plan cards, question cards). When the CLI routes a
 *  permission prompt for one of these to us, auto-allow it so we don't also pop
 *  a generic file-permission card on top of the purpose-built surface. */
const PERMISSION_AUTO_ALLOW = new Set(["ExitPlanMode", "TodoWrite"]);

/** Tools whose permission request IS the question, not a gate in front of one.
 *
 *  `AskUserQuestion` computes nothing: the CLI echoes back whatever input it
 *  was handed, so the user's choices reach the model only by being written into
 *  the `updatedInput` of our "allow". Approving it unchanged is a well-formed,
 *  semantically empty answer, and the CLI's own wording for that is the sentence
 *  this list exists to stop producing — "The user did not answer the questions."
 *
 *  Checked ahead of every mode, including agent/bypass. The tool reports itself
 *  read-only and touches neither disk nor network, so every auto-allow branch
 *  below would otherwise answer it on the user's behalf. A question is not a
 *  permission: no mode may supply input the person was asked for. */
export const INTERACTIVE_TOOLS = new Set(["AskUserQuestion"]);

/**
 * The choices an approval carries back, when it is answering a question.
 *
 * The far side of the round-trip `INTERACTIVE_TOOLS` describes: the answers
 * reach the model as the tool's own input, so an approved request is the only
 * place they exist. Nothing on the timeline has them, and once the card closes
 * there is no trace of the question having been asked — which is what the
 * caller uses this to repair.
 *
 * Every condition has to hold, because each failing one means a different shape
 * entirely: a denial carries no answers at all, a non-interactive tool's
 * `updatedInput` is unrelated tool data, and `answers` arriving as an array is
 * a schema we would be misreading rather than one we can use.
 *
 * Keyed off `INTERACTIVE_TOOLS` rather than the tool's name, so a second
 * interactive tool cannot be added to that set and silently have its answers
 * dropped here.
 */
export function answersFromApproval(
  behavior: PermissionBehavior,
  toolName: string | undefined,
  updatedInput: Record<string, unknown> | undefined
): Record<string, string> | undefined {
  if (behavior !== "allow" || !updatedInput) return undefined;
  if (!toolName || !INTERACTIVE_TOOLS.has(toolName)) return undefined;
  const answers = updatedInput.answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    return undefined;
  }
  return answers as Record<string, string>;
}

/** Reversible file-mutation tools. "Allow edits for this turn" auto-approves
 *  ONLY these — never Bash, deletes, or network — so the destructive/network
 *  gate stays fully intact even after the user opts into auto-accepting edits. */
const SAFE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Read-only inspection tools. These never mutate the workspace, never reach
 *  the network, and never destroy data — they only observe. We always
 *  auto-allow them so the agent can freely explore the codebase without
 *  interrupting the user for an approval on every file read or search. The
 *  destructive/network gate below still runs first, so the (defensive) case of
 *  a same-named tool that somehow looks destructive/network still prompts. */
const READ_ONLY_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);

/** Bash prefixes routed to OUR classifier (decidePermission) instead of being
 *  auto-run by a project/user allowlist. Injected as `permissions.ask` rules
 *  through the highest-priority `--settings` layer; Claude Code resolves
 *  permissions as deny → ask → allow, so an `ask` rule wins over any matching
 *  `allow` rule and hands the call to our approval logic.
 *
 *  We route ALL `git` here (rather than enumerating add/checkout/commit/…) so
 *  the read-vs-mutate decision is made automatically: read-only git
 *  (status/log/diff/…) auto-allows silently, while anything that touches the
 *  index, working tree, refs, or history surfaces an approval card. New or rare
 *  mutating subcommands are gated by default without us ever listing them.
 *  Patterns use the CLI's `Bash(<prefix>:*)` prefix-match syntax. */
export const ROUTE_TO_CLASSIFIER_BASH: ReadonlyArray<string> = ["git:*"];

/** git subcommands that only READ repository state — they never modify the
 *  index, working tree, refs, config, or history. Anything not in this set is
 *  treated as mutating-by-default and surfaces an approval card. (Network git —
 *  push/pull/fetch/clone/remote/ls-remote — is caught earlier by the network
 *  gate, so it still prompts even though some are read-ish.) */
const GIT_READONLY_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "status",
  "log",
  "diff",
  "show",
  "blame",
  "reflog",
  "shortlog",
  "describe",
  "rev-parse",
  "rev-list",
  "ls-files",
  "ls-tree",
  "cat-file",
  "name-rev",
  "merge-base",
  "whatchanged",
  "grep",
  "show-ref",
  "for-each-ref",
  "verify-commit",
  "count-objects",
  "version"
]);

/** True for tool names that run a shell command (`Bash`, and defensively any
 *  shell/exec/run/terminal-flavored tool an MCP server might expose). */
function isBashLike(toolName: string): boolean {
  return /(bash|shell|exec|run|terminal)/i.test(toolName);
}

/** Extract the git subcommand from a shell command, skipping the leading `git`
 *  (or an absolute path to it) and any global flags before it — `-C <dir>`,
 *  `-c <k=v>`, `--no-pager`, `--git-dir=…`, etc. Returns null when the command
 *  isn't a git invocation. Heuristic (whitespace tokenizer), but robust for the
 *  shapes the agent actually emits. */
export function gitSubcommand(command: string): string | null {
  const tokens = command.trim().split(/\s+/);
  const gi = tokens.findIndex((t) => t === "git" || t.endsWith("/git"));
  if (gi === -1) return null;
  // Global flags that consume the following token as their value.
  const valued = new Set([
    "-C",
    "-c",
    "--git-dir",
    "--work-tree",
    "--namespace"
  ]);
  let i = gi + 1;
  while (i < tokens.length) {
    const t = tokens[i];
    if (valued.has(t)) {
      i += 2;
      continue;
    }
    if (t.startsWith("-")) {
      i += 1; // flag with no separate arg (e.g. --no-pager, --paginate)
      continue;
    }
    return t;
  }
  return null;
}

/** True when a shell command is a read-only git invocation (`git status`,
 *  `git log`, …). Used to keep repo inspection silent even after all git is
 *  routed to our classifier. */
export function isReadOnlyGitCommand(command: string): boolean {
  const sub = gitSubcommand(command);
  return sub !== null && GIT_READONLY_SUBCOMMANDS.has(sub);
}

/**
 * Shell commands that only look at the workspace.
 *
 * Every one of these reads and prints; none writes a file, changes state, or
 * reaches the network. Deliberately excludes tools that *can* write with a
 * flag — `sed -i`, `awk`'s redirects, anything that evaluates a string
 * (`node -e`, `python -c`, `xargs`) — because the head token alone cannot tell
 * those apart from the harmless spelling.
 */
const SHELL_READONLY_HEADS: ReadonlySet<string> = new Set([
  // Reaches nothing and changes nothing, but almost every command the agent
  // writes opens with `cd <somewhere> && …`. Leaving it out meant the segment
  // check failed on the first token and practically nothing was ever allowed —
  // which is what "it asks about every little thing" was.
  "cd",
  "pushd",
  "popd",
  "ls",
  "dir",
  "cat",
  "head",
  "tail",
  "wc",
  "nl",
  "find",
  "tree",
  "grep",
  "rg",
  "ag",
  "ack",
  "file",
  "stat",
  "du",
  "df",
  "pwd",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "which",
  "whereis",
  "type",
  "sort",
  "uniq",
  "cut",
  "tr",
  "tac",
  "rev",
  "paste",
  "join",
  "comm",
  "jq",
  "column",
  "diff",
  "cmp",
  "md5sum",
  "sha1sum",
  "sha256sum",
  "date",
  "whoami",
  "hostname",
  "echo",
  "printf",
  "true",
  "false"
]);

/** Shell syntax that can smuggle a write or a network call past a head-token
 *  check: redirects, command substitution, subshells, and a background `&`.
 *  The background case is bounded on both sides — without the lookbehind the
 *  second `&` of a perfectly ordinary `&&` chain matches. */
const SHELL_ESCAPE_HATCHES = /[>`]|\$\(|<\(|(?<!&)&(?!&)/;

/**
 * True when every segment of a shell command only reads.
 *
 * Pipelines and `&&` chains are split and each segment checked on its own, so
 * `ls src | head -20` passes while `ls && rm -rf .` cannot: `rm` is not in the
 * set. Redirects and command substitution are refused outright rather than
 * parsed — this is a permission gate, and the honest answer to syntax we do not
 * fully model is to ask.
 *
 * Being wrong in the permissive direction here would auto-run something the
 * user never saw, so the destructive and network gates still run first and this
 * is only ever consulted when both said no.
 */
export function isReadOnlyShellCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || SHELL_ESCAPE_HATCHES.test(trimmed)) return false;

  const segments = trimmed.split(/\|\||&&|[;|]/);
  return segments.every((segment) => {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return false;
    // Leading `VAR=value` assignments change what the command sees; refuse
    // rather than reason about them.
    const head = tokens[0];
    if (head.includes("=")) return false;
    const name = head.replace(/^.*[\\/]/, "");
    if (name === "git" || name.endsWith("/git")) {
      return isReadOnlyGitCommand(segment);
    }
    return SHELL_READONLY_HEADS.has(name);
  });
}

/** True for MCP tools that only read/observe (no writes, no network mutations).
 *  MCP tool names are `mcp__<server>__<tool>`; we key off the trailing tool
 *  segment matching read-ish verbs (get/list/read/search/fetch-but-local…).
 *  Conservative: anything that isn't an obvious read still prompts. */
function isReadOnlyMcpTool(toolName: string): boolean {
  if (!toolName.startsWith("mcp__")) return false;
  const leaf = toolName.split("__").pop() ?? "";
  return /(^|[_-])(get|list|read|search|find|query|describe|show|view|fetch|lookup|inspect)(?:$|[_-]|[A-Z0-9])/i.test(
    leaf
  );
}

// ── Destructive-operation detection ──────────────────────────
//
// These never auto-run, even in `auto` mode — they always surface an approval
// card flagged as destructive. Mirrors the "always-gate" command list from the
// permissions reference (rm/sudo/dd/fork-bomb/force-push/etc.).

/** Piping a downloaded script straight into a shell — arbitrary remote code
 *  execution. Treated as destructive (red, always prompt, never auto-allow). */
const REMOTE_PIPE_TO_SHELL =
  /\b(curl|wget|fetch)\b[\s\S]*\|\s*(sudo\s+)?(sh|bash|zsh|dash|fish|ksh)\b/i;

/**
 * A command that is dangerous by being run, and the argument shape (if any)
 * that makes it so.
 *
 * `head` is matched against the **command position** of a shell segment, never
 * against the line as free text. As free text these names matched their own
 * spelling anywhere it appeared: `\bformat\b[^\n]*\/[a-z]` — written for the
 * Windows `format C: /q` — matched `--input-format` because `\b` sits happily
 * after a hyphen, and then any later path with a slash finished it. A read-only
 * `git log -S"…" -- src/…; echo "--- (input format) ---"` came back as a red
 * "Run destructive command?" card. `\b(del|erase)\b` did the same to
 * `rg "erase" src`.
 */
interface GatedCommand {
  /** Against the segment's head, lowercased and stripped of directory and
   *  `.exe`. */
  head: RegExp;
  /** Against the arguments after it, when the name alone is not enough:
   *  `chmod` is destructive recursively, `format` against a drive. */
  args?: RegExp;
}

const DESTRUCTIVE_COMMANDS: ReadonlyArray<GatedCommand> = [
  { head: /^rm$/ },
  { head: /^rmdir$/ },
  { head: /^unlink$/ },
  { head: /^shred$/ },
  { head: /^trash$/ },
  { head: /^find$/, args: /(^|\s)-delete\b|(^|\s)-exec\s+rm\b/ },
  { head: /^dd$/ },
  { head: /^mkfs(\..+)?$/ },
  { head: /^fdisk$/ },
  { head: /^sudo$/ },
  { head: /^chmod$/, args: /(^|\s)-R\b/ },
  { head: /^chown$/, args: /(^|\s)-R\b/ },
  { head: /^kill$/, args: /(^|\s)-9\b/ },
  // Windows. Everything above is POSIX, and this extension ships on Windows,
  // where the CLI reaches for PowerShell unasked — measured in a live run: the
  // model answered "delete README.md" with
  // `Remove-Item -Path … -Confirm:$false`, which matched nothing here. So the
  // card carried no warning, a standing grant was offered for the whole shell,
  // and in agent mode it would have run with no prompt at all.
  { head: /^remove-item$/ },
  { head: /^remove-itemproperty$/ },
  { head: /^clear-(content|item|disk)$/ },
  { head: /^stop-process$/, args: /-force\b/i },
  { head: /^(del|erase)$/ },
  { head: /^rd$/, args: /\/s\b/i },
  // What it was always reaching for: a drive to wipe, or the filesystem to
  // write. Never the word on its own.
  { head: /^format$/, args: /(^|\s)[a-z]:(\s|\\|$)|\/fs:/i },
  { head: /^reg$/, args: /^delete\b/i },
  { head: /^diskpart$/ }
];

/** git subcommands that destroy. `true` for the ones that need no argument to
 *  do it; a pattern where the subcommand is only destructive with one. */
const DESTRUCTIVE_GIT: ReadonlyMap<string, true | RegExp> = new Map<
  string,
  true | RegExp
>([
  ["rm", true],
  ["clean", true],
  ["reset", /--hard\b/],
  ["checkout", /\s--\s/],
  ["push", /--force\b|\s-f(\s|$)/]
]);

/**
 * Destructive shapes with no command position to anchor to: a fork bomb is a
 * function definition, a device overwrite is a redirect target, and piping a
 * download into a shell spans two segments by construction.
 */
const DESTRUCTIVE_SHAPES: ReadonlyArray<RegExp> = [
  /:\s*\(\s*\)\s*\{/, // fork bomb :(){ ... }
  />\s*\/dev\/(sd|nvme|disk|null\/)/,
  REMOTE_PIPE_TO_SHELL
];

/** Commands that reach the network or outside the workspace. Always prompt and
 *  never auto-allowed (even if the user allow-listed them), but not flagged as
 *  irreversibly destructive. */
const NETWORK_COMMANDS: ReadonlyArray<GatedCommand> = [
  { head: /^curl$/ },
  { head: /^wget$/ },
  { head: /^ssh$/ },
  { head: /^scp$/ },
  { head: /^sftp$/ },
  { head: /^rsync$/ },
  { head: /^(nc|ncat|netcat)$/ },
  { head: /^telnet$/ },
  { head: /^ftp$/ }
];

const NETWORK_GIT: ReadonlySet<string> = new Set([
  "push",
  "pull",
  "fetch",
  "clone",
  "remote"
]);

/** Where one command ends and the next begins. A single `&` backgrounds and
 *  therefore separates; `&&` is matched first so it is not read as two. */
const SEGMENT_SEPARATORS = /\|\||&&|[;|&\n]/;

/**
 * Command substitution runs its contents as a command wherever it sits, so
 * `$(rm -rf x)` is an `rm` however the line around it reads. Turning the
 * opening delimiter into a separator makes those contents a segment of their
 * own, which is cheaper and tighter than a second, looser pass over the line.
 *
 * The closing paren is deliberately left alone: `find . \( -name x \) -delete`
 * is one command, and splitting it there would put `find` and `-delete` in
 * different segments and lose it.
 */
const SUBSTITUTION_OPENERS = /\$\(|<\(|`/g;

/** A leading `VAR=value`, which modifies the command that follows rather than
 *  being one. */
const ENV_ASSIGNMENT = /^[A-Za-z_]\w*=/;

/** Commands whose argument is itself a command. `xargs rm -rf` is an `rm`, and
 *  reading only the head would call it an `xargs`. */
const COMMAND_WRAPPERS: ReadonlySet<string> = new Set([
  "env",
  "nohup",
  "time",
  "xargs",
  "command",
  "nice",
  "ionice",
  "timeout",
  "stdbuf",
  "setsid",
  "watch"
]);

/**
 * The command a segment actually runs: the head, lowercased and stripped of
 * directory and `.exe`, plus everything after it.
 *
 * Steps through leading assignments and wrappers, so the head returned is the
 * one whose name decides. Returns `null` for a segment that runs nothing.
 */
function commandOf(segment: string): { head: string; args: string } | null {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length && ENV_ASSIGNMENT.test(tokens[i])) i++;
  if (i >= tokens.length) return null;
  const head = tokens[i]
    .replace(/^.*[\\/]/, "")
    .replace(/\.exe$/i, "")
    .toLowerCase();
  const args = tokens.slice(i + 1).join(" ");
  // Terminates: `args` is strictly shorter than the segment it came from.
  if (COMMAND_WRAPPERS.has(head) && args) return commandOf(args);
  return { head, args };
}

/** Shells that take a whole command line as an argument. `bash -c "rm -rf x"`
 *  runs an `rm`, and reading only the head calls it a `bash` — the one false
 *  negative that anchoring to the command position would otherwise introduce,
 *  since the old whole-line scan caught it by accident. */
const SHELL_RUNNERS: ReadonlySet<string> = new Set([
  "bash",
  "sh",
  "zsh",
  "dash",
  "fish",
  "ksh",
  "powershell",
  "pwsh",
  "cmd"
]);

/** The command line a shell was handed, or `null` when it was handed none.
 *  Quotes are dropped rather than parsed: this reads a command, it does not
 *  run one, and `bash -c "echo 'rm'"` should come back as an `echo`. */
function innerCommandLine(args: string): string | null {
  const handed = args.match(/(?:^|\s)(?:-c(?:ommand)?|--command|\/c)\s+(.+)$/i);
  return handed ? handed[1].replace(/["']/g, " ") : null;
}

/** Every command the line runs, in the order it runs them, including the ones
 *  it hands to another shell. */
function shellCommands(
  command: string,
  depth = 0
): Array<{ head: string; args: string; segment: string }> {
  // Shells nest a handful of levels at most in anything a model writes, and a
  // bound here is cheaper than trusting every input to terminate.
  if (depth > 4) return [];
  return command
    .replace(SUBSTITUTION_OPENERS, ";")
    .split(SEGMENT_SEPARATORS)
    .flatMap((segment) => {
      const cmd = commandOf(segment);
      if (!cmd) return [];
      const here = { ...cmd, segment };
      if (!SHELL_RUNNERS.has(cmd.head)) return [here];
      const inner = innerCommandLine(cmd.args);
      return inner ? [here, ...shellCommands(inner, depth + 1)] : [here];
    });
}

function matches(
  rules: ReadonlyArray<GatedCommand>,
  cmd: { head: string; args: string }
): boolean {
  return rules.some(
    (rule) =>
      rule.head.test(cmd.head) && (!rule.args || rule.args.test(cmd.args))
  );
}

export function isDestructiveBash(command: string): boolean {
  if (DESTRUCTIVE_SHAPES.some((re) => re.test(command))) return true;
  return shellCommands(command).some((cmd) => {
    if (cmd.head === "git") {
      const sub = gitSubcommand(cmd.segment);
      const rule = sub === null ? undefined : DESTRUCTIVE_GIT.get(sub);
      return rule === true || (rule !== undefined && rule.test(cmd.segment));
    }
    return matches(DESTRUCTIVE_COMMANDS, cmd);
  });
}

export function isNetworkBash(command: string): boolean {
  return shellCommands(command).some((cmd) => {
    if (cmd.head === "git") {
      const sub = gitSubcommand(cmd.segment);
      return sub !== null && NETWORK_GIT.has(sub);
    }
    return matches(NETWORK_COMMANDS, cmd);
  });
}

/**
 * True when this command is safe **as written** but has arguments that would
 * make it unsafe — so a rule covering it plus anything is not safe.
 *
 * Only one caller needs this, and only because of what a written permission
 * rule means: `Bash(git reset:*)` matches `git reset --hard`, and `git reset`
 * alone passes both gates above. A grant judged on its prefix would sail
 * through and take the argument that undoes it along for free.
 *
 * Answered off the same tables the gates use, so a command added there is
 * covered here without anybody remembering to.
 */
export function isConditionallyGatedBash(command: string): boolean {
  return shellCommands(command).some((cmd) => {
    if (cmd.head === "git") {
      const sub = gitSubcommand(cmd.segment);
      // No subcommand yet: every gated one is still reachable by extension.
      if (sub === null) return true;
      return DESTRUCTIVE_GIT.get(sub) instanceof RegExp || NETWORK_GIT.has(sub);
    }
    return [...DESTRUCTIVE_COMMANDS, ...NETWORK_COMMANDS].some(
      (rule) => rule.args !== undefined && rule.head.test(cmd.head)
    );
  });
}

/** True when a tool call would irreversibly destroy data (delete files, wipe
 *  disks, force-push, pipe a remote script to a shell, …). Forces a red,
 *  default-to-Deny approval prompt. */
export function isDestructiveRequest(
  toolName: string,
  input: Record<string, unknown> | undefined
): boolean {
  const cmd = typeof input?.command === "string" ? input.command : "";
  if (/(bash|shell|exec|run|terminal)/i.test(toolName) && cmd) {
    return isDestructiveBash(cmd);
  }
  // Defensive: any tool whose name reads like a deletion (no such built-in
  // today, but MCP servers and future tools may add one).
  return /(^|[_-])(delete|remove|unlink|trash|destroy|rm)(?:$|[_-]|[A-Z])/i.test(
    toolName
  );
}

/** True when a tool call reaches the network or outside the workspace (curl,
 *  ssh, git push, web fetch, …). Forces an approval prompt flagged as network
 *  access; never auto-allowed. */
export function isNetworkRequest(
  toolName: string,
  input: Record<string, unknown> | undefined
): boolean {
  const cmd = typeof input?.command === "string" ? input.command : "";
  if (/(bash|shell|exec|run|terminal)/i.test(toolName) && cmd) {
    return isNetworkBash(cmd);
  }
  // Built-in / MCP tools that fetch over the network.
  return /(^|[_-])(web|fetch|http|download|url|browse)/i.test(toolName);
}

/**
 * What a denial tells the model, in two forms.
 *
 * With nothing typed the message has to stop the retry loop: without the "do
 * not retry" clause the model re-proposes the same call and the user is asked
 * again and again. With a reason, that clause has to GO — it contradicts the
 * instruction the user just gave. Telling a model both "do not attempt an
 * alternative" and "use fs.rm instead" leaves it choosing which half to obey.
 *
 * The reference client makes the same split, and its two strings differ in the
 * same place: the "STOP and wait" tail is replaced by the reason rather than
 * joined to it.
 */
export function denialMessage(reason?: string): string {
  const said = reason?.trim();
  if (!said) {
    return "The user denied permission for this action and does not want it performed. Do not retry it or attempt an alternative way to achieve the same thing. Stop and briefly explain, or ask the user how they would like to proceed.";
  }
  return `The user denied permission for this action as proposed. They said what they want instead: ${said}\n\nFollow that rather than retrying the call they refused.`;
}

export type PermissionAction = "allow" | "prompt" | "deny";

/** What the CLI's own client says when the user keeps planning. Its tool
 *  renders the refused call as "Stayed in plan mode" off the back of it. */
export const STAYED_IN_PLAN_MODE =
  "User chose to stay in plan mode and continue planning";

/**
 * The sentence the CLI opens with when its auto-mode classifier refuses a call.
 * The reason follows it.
 *
 * A classifier denial never reaches the control channel — read out of 2.1.219,
 * that path returns `{behavior:"deny"}` straight to the model — so it arrives
 * as an ordinary failed `tool_result` and this prefix is the only thing that
 * tells the mode refusing from the tool breaking.
 */
export const AUTO_MODE_DENIAL_PREFIX =
  "Permission for this action was denied by the Claude Code auto mode classifier. Reason: ";

/** The reason auto mode gave for refusing, or `null` when this failure is an
 *  ordinary one. */
export function autoModeDenialReason(resultContent: string): string | null {
  if (!resultContent.startsWith(AUTO_MODE_DENIAL_PREFIX)) return null;
  const rest = resultContent.slice(AUTO_MODE_DENIAL_PREFIX.length);
  // The CLI appends its own advice to the model after the reason — what to do
  // instead, and that a Bash rule would allow this next time. None of that is
  // the reason, and all of it is addressed to the model rather than the reader.
  return rest.split(". If you have other tasks")[0].trim();
}

export interface PermissionDecision {
  action: PermissionAction;
  destructive: boolean;
  network: boolean;
}

/**
 * Decide what to do with a `can_use_tool` request. Pure (no I/O) so the policy
 * is unit-testable in isolation.
 *
 * The gate that matters is the first one: destructive and network calls prompt
 * in every mode, and nothing below can reach past it. What the modes change is
 * only how much of the harmless remainder still interrupts.
 *
 * Ahead of even that sits `INTERACTIVE_TOOLS`, which is not a safety gate at
 * all: those calls carry no answer until the user supplies one, so allowing
 * them silently does not run something unwanted, it discards the question.
 *
 * **Agent (`auto`), with the CLI's classifier live (`cliClassified`)** — the
 * decision has already been made by something that read the whole conversation,
 * and a request reaching us is one it declined to make. So the ladder below is
 * cut down to the rungs that carry a decision the *user* made — a standing
 * grant, "allow edits this turn" — plus the tools that have their own UI.
 * Our read-only heuristics do not run: they exist to quiet a CLI that asks
 * about everything, and this one does not.
 *
 * **Agent (`auto`), fallback** — the CLI refused to run its classifier, so ours
 * is the only one there is: everything that is neither destructive nor network
 * runs without asking. Reading a file and editing one are the work; a tool that
 * stops to ask permission for them is not an agent, it is a prompt with extra
 * steps.
 *
 * **Ask (`default`)** — the conservative list, unchanged:
 *  - A standing grant the user made from an approval card auto-allows. It is
 *    checked here, below the gate, so "always allow `Bash(bun run …)`" can
 *    never become "always allow `rm`".
 *  - Plan helper tools auto-allow (they have their own UI). `AskUserQuestion`
 *    used to be one of them and is not: see `INTERACTIVE_TOOLS`.
 *  - Read-only inspection tools (Read/Glob/Grep/LS/NotebookRead and read-only
 *    MCP queries) always auto-allow — they only observe, never mutate.
 *  - Shell commands that only read (`ls`, `cat`, `rg`, read-only `git`, …)
 *    auto-allow; every segment of the command has to qualify on its own.
 *  - When the user has opted into "allow edits this turn", reversible edit
 *    tools auto-allow — but Bash, deletes, and network calls STILL prompt.
 *  - Everything else prompts, carrying the destructive/network flags.
 */
export function decidePermission(
  toolName: string,
  input: Record<string, unknown> | undefined,
  ctx: {
    autoAllowEdits: boolean;
    agentMode?: boolean;
    /** Standing "always allow" grants. Consulted only inside the branch both
     *  gates already declined, which is what makes it structurally impossible
     *  for a grant to auto-run `rm` or `curl` however it was worded. */
    grants?: ReadonlyArray<ToolGrant>;
    /** The CLI's `requires_user_interaction` on this request. Its own marker
     *  for a call that carries a question rather than an action. */
    interactive?: boolean;
    /** True when the CLI ran its own classifier before asking — i.e. the
     *  session is really in the CLI's `auto` mode. Mutually exclusive with
     *  `agentMode`: either the CLI judged the call or we do, never both. */
    cliClassified?: boolean;
    /** The mode the CLI session is actually running with. */
    planMode?: boolean;
  }
): PermissionDecision {
  const destructive = isDestructiveRequest(toolName, input);
  const network = isNetworkRequest(toolName, input);
  // Leaving plan mode is the user's call, and in LUNO they make it on the plan
  // card — which proceeds by respawning the CLI in Agent mode, not by
  // answering this tool. Auto-allowing it let the *current* session out of
  // plan mode the moment the model asked, before anyone had read the plan.
  // Nothing could be written even then (every edit still meets the gate
  // below), but plan mode's promise was being kept by a second fence rather
  // than by the mode. Refusing is what the tool is built for: the CLI renders
  // the refusal as "Stayed in plan mode" and keeps planning.
  if (toolName === "ExitPlanMode" && ctx.planMode) {
    return { action: "deny", destructive, network };
  }
  // Above every mode: the answer is the payload, and only the user has it.
  //
  // Two triggers on purpose, and the CLI does the same: `AskUserQuestion`
  // returns `ask` from its own `checkPermissions` AND is forced to `ask` a
  // second time by the resolver reading `requiresUserInteraction()`. The name
  // list is the floor — it holds if a CLI build ever omits the flag — and the
  // flag is what makes this generalise to the next tool of the same shape
  // without anybody editing a list here.
  if (INTERACTIVE_TOOLS.has(toolName) || ctx.interactive) {
    return { action: "prompt", destructive, network };
  }
  if (!destructive && !network) {
    if (ctx.agentMode) return { action: "allow", destructive, network };
    if (ctx.grants?.length && coveredByGrants(ctx.grants, toolName, input)) {
      return { action: "allow", destructive, network };
    }
    if (PERMISSION_AUTO_ALLOW.has(toolName))
      return { action: "allow", destructive, network };
    // Read-only inspection (file reads, globs, greps, read-only MCP queries)
    // never mutates state — always auto-allow so exploration never prompts.
    if (
      !ctx.cliClassified &&
      (READ_ONLY_TOOLS.has(toolName) || isReadOnlyMcpTool(toolName))
    ) {
      return { action: "allow", destructive, network };
    }
    // Read-only git (status/log/diff/…) routed to us via the git `ask` rule:
    // auto-allow so inspecting the repo stays silent. Mutating git (add,
    // checkout, commit, merge, reset, stash, restore, switch, …) is NOT in the
    // read-only set, so it falls through to the approval card below — no need
    // to enumerate every mutating subcommand.
    // Inspecting the workspace through the shell is the same act as `Read` or
    // `Grep`, and it was the one that still interrupted: `ls`, `cat`, `wc`,
    // `find` and `rg` each asked, several times a turn, for permission to look
    // at a file the agent could have read silently through a tool. Read-only
    // git is a special case of this and stays silent for the same reason.
    if (
      !ctx.cliClassified &&
      isBashLike(toolName) &&
      typeof input?.command === "string" &&
      isReadOnlyShellCommand(input.command)
    ) {
      return { action: "allow", destructive, network };
    }
    if (ctx.autoAllowEdits && SAFE_EDIT_TOOLS.has(toolName)) {
      return { action: "allow", destructive, network };
    }
  }
  return { action: "prompt", destructive, network };
}

/**
 * Translate a user `allowedBashPatterns` regex into one or more literal CLI
 * `--allowedTools` Bash patterns. The CLI matches `Bash(<literal>)` against the
 * command text (prefix/glob), NOT as a regex — so alternation like
 * `^npm (test|run test)$` must be EXPANDED into separate literals
 * (`npm test`, `npm run test`) or it never matches. (The old single-string
 * translation left the alternation intact and silently matched nothing.)
 */
export function regexToCliPatterns(p: string): string[] {
  const body = p
    .replace(/^\^/, "")
    .replace(/\$$/, "")
    .replace(/\\s\+?/g, " ")
    .replace(/\\\./g, ".")
    .replace(/\.\*/g, "*");

  // Expand `(a|b|c)` groups into the cartesian product of literal variants.
  let variants = [body];
  let guard = 0;
  while (variants.some((v) => /\([^()]*\|[^()]*\)/.test(v)) && guard++ < 24) {
    variants = variants.flatMap((v) => {
      const m = v.match(/\(([^()]*\|[^()]*)\)/);
      if (!m || m.index === undefined) return [v];
      return m[1]
        .split("|")
        .map(
          (opt) => v.slice(0, m.index) + opt + v.slice(m.index! + m[0].length)
        );
    });
  }
  return Array.from(new Set(variants.map((v) => v.trim()).filter(Boolean)));
}
