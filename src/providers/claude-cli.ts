import { log as logInfo } from "../services/logger.js";
import { spawn, ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import { randomUUID } from "node:crypto";
import { ChatProvider, ProviderRequest } from "./base.js";
import {
  coveredByGrants,
  grantFor,
  grantLabel,
  type ToolGrant
} from "../core/tool-grants.js";
import {
  ContentBlock,
  Message,
  PermissionBehavior,
  PermissionMode,
  PermissionRequestPayload,
  PermissionSuggestion,
  RemoteControlStatus,
  isTerminalTaskStatus,
  StreamDelta,
  SubagentPhase,
  SubagentUpdate,
  TaskType,
  WorkflowProgressEntry
} from "../core/types.js";
import { getModePrompt, getTaskTypePrompt } from "../services/prompt-loader.js";
import { ConventionsFile } from "../services/conventions.js";

/**
 * How long the CLI may produce nothing at all — not one stdout line, not one
 * stderr byte — before it is treated as wedged and SIGKILLed.
 *
 * Measured from the last sign of life, never from spawn. As a deadline from
 * spawn this killed turns that were working perfectly: a `/audit` driving a
 * fleet of background agents died at exactly 10 minutes, mid-message, with no
 * error, no partial result and nothing in the transcript to say why. A long
 * build, a long test run and a subagent fleet are all silent-looking to a
 * wall clock and none of them are wedged. Real wedging is silence, so that is
 * what is measured.
 */
const SILENCE_TIMEOUT_MS = 10 * 60 * 1000;

/** Latency-bounded tools that should return a result in seconds, not minutes.
 *  If the CLI wedges inside one of these and never emits a `tool_result`
 *  (e.g. WebFetch hanging on a slow/streaming endpoint), the per-tool stall
 *  watchdog ends the turn cleanly rather than letting the UI spinner run until
 *  the SILENCE_TIMEOUT_MS SIGKILL. Bash and other potentially
 *  long-running tools are deliberately NOT watched here. */
const STALL_WATCHDOG_TOOLS: ReadonlySet<string> = new Set([
  "WebFetch",
  "WebSearch"
]);

/** Default budget for a watched tool to produce its result before it's treated
 *  as stalled. Generous enough for a slow-but-real fetch; far short of the
 *  10-minute hard kill. Override per-session via ClaudeCliOpts.toolStallMs. */
const WEB_TOOL_STALL_MS = 60 * 1000;

/**
 * How often the turn re-checks whether background work is still outstanding.
 *
 * A `run_in_background` agent keeps working past the end of the turn: timed
 * against 2.1.220, one reported `completed` with its full answer 5.6s after
 * `result` arrived. Ending the turn there — which is what closing stdin does —
 * exits the child and kills the agent mid-step, so its card could only ever
 * read "interrupted".
 *
 * This used to be a deadline: quiet for 90s and the turn ended. That reading of
 * quiet was wrong. `task_progress` fires *around* a nested tool call, never
 * during one — measured, the parent's stdout said nothing for the full 47.1s a
 * workflow agent spent inside a single `sleep 50`, and 33.2s was the worst gap
 * in a second run. So the deadline was really a cap on how long any one nested
 * tool call a workflow makes may take, which is not a thing this file can know.
 * `armGrace` now holds the turn while the CLI reports work outstanding, and
 * this is only how long it waits between looks.
 */
const BACKGROUND_TASK_GRACE_MS = 90 * 1000;

/**
 * How long the turn waits for the model to report on a task that just finished.
 *
 * A background task does not simply end. The CLI queues a synthetic
 * `<task-notification>` prompt naming it and opens a **fresh turn** to answer
 * it — that turn is where "Workflow completed. Result: …" comes from, and it is
 * the only sentence saying what the run produced. Measured on 2.1.219 across
 * two runs: the follow-up `system/init` landed ~1s after the launching turn's
 * `result`, and its own `result` 6s after that.
 *
 * Ending at the launching turn's `result` — which is what happens when the task
 * finished before it, as a short workflow always does — throws that turn away
 * unread. Every line the follow-up produces re-arms this budget, so it is paid
 * in full only when the CLI never follows up at all.
 */
const TASK_REPORT_GRACE_MS = 15 * 1000;

/** Tools that are surfaced through their own dedicated UI by the orchestrator's
 *  PlanInterceptor (plan cards, question cards). When the CLI routes a
 *  permission prompt for one of these to us, auto-allow it so we don't also pop
 *  a generic file-permission card on top of the purpose-built surface. */
const PERMISSION_AUTO_ALLOW = new Set([
  "ExitPlanMode",
  "TodoWrite",
  "AskUserQuestion"
]);

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
const ROUTE_TO_CLASSIFIER_BASH: ReadonlyArray<string> = ["git:*"];

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

/** The CLI only services interactive per-tool approval over the stream-json
 *  control channel; that's `default` and `auto`. `plan` stays read-only and
 *  keeps the simpler text-input invocation (the plan flow handles its own
 *  approval via ExitPlanMode). `bypass` needs no channel either — the CLI
 *  approves everything itself and never asks, so keeping stdin open for
 *  control responses that can never arrive would be dead weight. */
function usesPermissionProtocol(mode: PermissionMode): boolean {
  return mode === "default" || mode === "auto";
}

export interface ClaudeCliOpts {
  binary: string;
  cwd: string;
  permissionMode?: PermissionMode;
  allowedBashPatterns?: string[];
  /** Standing grants, read fresh on every decision rather than captured at
   *  construction: granting one from a card has to take effect on the very
   *  next call of that turn, and the provider outlives no reload but does
   *  outlive the decision. */
  getToolGrants?: () => ReadonlyArray<ToolGrant>;
  /** Skill ids the user toggled OFF in the picker. Enforced via
   *  --disallowedTools "Skill(<id>)" plus a system-prompt append. */
  disabledSkills?: string[];
  /** Heuristic task classification — drives task-type playbook injection
   *  in plan mode only. */
  taskType?: TaskType;
  /** Project conventions file (CLAUDE.md / AGENTS.md / etc.). Injected via
   *  --append-system-prompt unless `alreadyLoadedByCli` is true. */
  conventions?: ConventionsFile | null;
  /** The editor's Problems, already formatted. Injected per turn because they
   *  describe the tree as it is right now, not as it was when the session
   *  started. */
  diagnostics?: string | null;
  /** The active file and selection, already formatted. Per turn for the same
   *  reason: it describes where the user's attention is as they hit send. */
  editorContext?: string | null;
  getResumeSessionId?: () => string | undefined;
  setResumeSessionId?: (id: string) => void;
  /** Told the CLI's slash-command list when a turn reports one. */
  onSlashCommands?: (names: string[]) => void;
  /** Anthropic auth token (OAuth `sk-ant-oat...` or API `sk-ant-api...`)
   *  injected as `ANTHROPIC_API_KEY` when spawning the CLI. Optional —
   *  if absent the CLI falls back to its own `~/.claude/` credentials. */
  token?: string;
  /** Path to a temporary JSON file describing connected MCP servers, in
   *  the CLI's `--mcp-config` format. Caller is responsible for deleting
   *  the file after the turn completes. */
  mcpConfigPath?: string;
  /** Names of the MCP servers in `mcpConfigPath`. Used to pre-allow their
   *  tools in auto mode so the agent can call them without per-tool
   *  approval prompts. */
  mcpServerNames?: string[];
  /** Reasoning effort for the session. Maps directly to the CLI's
   *  `--effort <level>` flag (low | medium | high | xhigh | max). */
  effort?: EffortLevel;
  /** Extended-thinking toggle. When defined, passed through as
   *  `--settings '{"alwaysThinkingEnabled": <bool>}'` so the session
   *  setting is authoritative regardless of the user's settings.json. */
  thinking?: boolean;
  /**
   * The CLI's `ultracode` setting: xhigh effort plus standing dynamic-workflow
   * orchestration, delivered the same way `--settings` delivers everything
   * else. Not an effort level — the flag has five and this is not a sixth —
   * so it pins `--effort xhigh` rather than replacing it.
   */
  ultracode?: boolean;
  /** Stall budget (ms) for latency-bounded tools (WebFetch/WebSearch). If one
   *  doesn't return a result within this window the turn is stopped cleanly.
   *  Defaults to WEB_TOOL_STALL_MS. */
  toolStallMs?: number;
  /** How long the turn waits on a quiet backgrounded subagent before ending
   *  anyway. Defaults to BACKGROUND_TASK_GRACE_MS; tests shorten it. */
  backgroundGraceMs?: number;
  /** How long the turn waits for the model to report on a task that finished.
   *  Defaults to TASK_REPORT_GRACE_MS; tests shorten it. */
  taskReportGraceMs?: number;
  /** How long the CLI may emit nothing before it's killed as wedged. Reset by
   *  every stdout line and stderr byte. Defaults to SILENCE_TIMEOUT_MS; tests
   *  shorten it. */
  silenceTimeoutMs?: number;
  /**
   * Keep one CLI process alive across turns instead of spawning per turn.
   * Required by Remote Control, which lives exactly as long as its process.
   *
   * What this costs: options baked into argv can no longer be rebuilt each
   * turn. `model`, `permissionMode` and the working directory are changed live
   * over the control channel; **`effort` has no control-protocol equivalent**
   * (there is no `set_effort`), so changing it respawns the session — which
   * drops the Remote Control bridge and needs it re-established.
   */
  sessionMode?: boolean;
  /** Text the CLI was holding and never read, handed back on Stop so nothing
   *  typed is lost. See `interruptReturningQueued`. */
  onStillQueued?: (text: string) => void;
  /** Called with events that arrive while no turn is streaming — the phone
   *  talking to a session the panel is not currently driving. Session mode
   *  only; without it those deltas would be read off the pipe and dropped. */
  onOutOfTurn?: (delta: StreamDelta) => void;
}

/** Effort levels accepted by `claude --effort`. */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * What each pinned version accepts from `--effort`, in order.
 *
 * `xhigh` arrived with Opus 4.7 and `max` with the 4.6 family, so a pinned
 * model predates part of the ladder — Sonnet 4.5 predates the flag entirely.
 * Aliases are deliberately absent: they always resolve to something current,
 * and a model missing from this map is assumed to take every level.
 *
 * Read by the spawn below *and* by the picker's catalogue, so the two cannot
 * disagree about what a version will accept.
 */
export const EFFORT_LADDERS: Readonly<
  Record<string, ReadonlyArray<EffortLevel>>
> = {
  "claude-opus-4-8": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-7": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-6": ["low", "medium", "high", "max"],
  "claude-opus-4-5": ["low", "medium", "high"],
  "claude-sonnet-4-6": ["low", "medium", "high", "max"],
  "claude-sonnet-4-5": []
};

const EFFORT_LEVELS: ReadonlyArray<EffortLevel> = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
];

/** A CLI process that outlives the turn, plus the state needed to decide
 *  whether the next turn can reuse it or has to replace it. */
interface CliSession {
  child: ChildProcess;
  /** argv it was spawned with, compared through respawnFingerprint(). */
  args: string[];
  stderr: string;
  /** Where deltas go right now: the streaming turn, or nothing (out-of-turn). */
  sink: ((d: StreamDelta) => void) | null;
  processor: (ev: CliEvent) => StreamDelta[];
  exited: boolean;
  /** Last values pushed over the control channel, so a turn that changes
   *  neither sends nothing. */
  model: string | undefined;
  permissionMode: PermissionMode;
  /** True from the moment a turn is written until its `result` lands. An
   *  interrupted turn still emits one, later — writing the next turn before it
   *  arrives makes that stale `result` end the new turn instead. */
  busy: boolean;
  /** Resolvers waiting for `busy` to clear. */
  idleWaiters: Array<() => void>;
  /** Message ids we put on our own prompts, still waiting for the CLI to play
   *  them back. It echoes ours alongside the phone's, and this is what tells
   *  them apart — see takeEcho(). */
  pendingEchoes: Set<string>;
  /** The task-type playbook this process was spawned with. Held for the life of
   *  the session: it rides on `--append-system-prompt`, which cannot be changed
   *  on a running CLI, and reclassifying per turn replaced the process. */
  taskType?: TaskType;
}

/** How long the next turn waits for an interrupted one to report its `result`
 *  before going ahead anyway. Long enough for an interrupt to land, short
 *  enough that a wedged CLI doesn't look like a frozen panel. */
const TURN_DRAIN_TIMEOUT_MS = 10_000;

/** An outbound control request waiting for its answer. */
interface PendingControl {
  resolve: (response: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** How long a control request waits for its response. Enabling Remote Control
 *  is a round-trip to the Anthropic API, so this is generous — but bounded, or
 *  a lost response leaves the caller awaiting forever. */
const CONTROL_TIMEOUT_MS = 30_000;

export class ClaudeCliProvider implements ChatProvider {
  readonly id = "claude-cli";
  private child: ChildProcess | null = null;
  /** The long-lived process in session mode; null in the per-turn path. */
  private session: CliSession | null = null;
  /** Control requests *we* sent, awaiting their response. */
  private pendingControls = new Map<string, PendingControl>();
  /** What the user asked for. Deliberately outlives any one process: replacing
   *  the CLI drops the bridge (measured), so the next one has to re-establish
   *  it rather than come up silently disconnected. */
  private remoteControl: RemoteControlStatus = { state: "off" };
  private remoteControlName: string | undefined;
  /** What the user asked for, as opposed to what the bridge is currently
   *  doing. A dropped connection is still "wanted", which is what makes a
   *  replaced process bring the bridge back instead of coming up silent. */
  private remoteControlWanted = false;
  /** The enable request currently in flight. Shared rather than duplicated:
   *  spawning a session with the bridge already wanted fires one, and a caller
   *  asking to enable at the same moment must join it instead of sending a
   *  second — two requests mean two remote sessions for one conversation. */
  private remoteControlInFlight: Promise<RemoteControlStatus> | null = null;
  /** In-flight `can_use_tool` prompts keyed by control-request id. Holds the
   *  proposed input + suggestions so respondToPermission() can echo the input
   *  back on "allow" and honor the CLI's "accept this session" suggestion. */
  private pendingPermissions = new Map<string, PermissionRequestPayload>();
  /** Set while a turn is streaming: ends the stream immediately (so cancel
   *  doesn't have to wait for the child's exit event, which can lag when the
   *  turn is paused on a permission prompt or the CLI has MCP subprocesses). */
  private abortCurrent: (() => void) | null = null;
  /** Set true when the user picks "Allow this turn" on an edit. We then
   *  auto-approve reversible edit tools for the rest of THIS turn ourselves —
   *  WITHOUT switching the CLI to acceptEdits, which would also auto-run every
   *  Bash command (incl. `rm`) and silently disable the destructive gate. */
  private autoAllowEdits = false;

  constructor(private opts: ClaudeCliOpts) {}

  cancel() {
    // End the async stream *now* — don't wait for the SIGTERM→exit round-trip.
    // While a turn is paused on a permission prompt no deltas are flowing, so
    // the consumer's cancel check only re-runs once we push something.
    this.abortCurrent?.();
    // A turn this panel did not start has no `abortCurrent` to do it, and the
    // interrupt below is not documented to withdraw a `can_use_tool` the CLI is
    // already blocked on. Left unanswered it blocks forever with no card left
    // on screen to answer it.
    this.denyPendingPermissions("Cancelled by the user.");
    // In session mode the process is the session: killing it would end the
    // conversation and drop any Remote Control bridge, when all the user asked
    // for was to stop this turn. Interrupt over the control channel instead.
    if (this.session && !this.session.exited) {
      void this.interruptReturningQueued();
      return;
    }
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
      setTimeout(() => this.child?.kill("SIGKILL"), 2000);
    }
  }

  /**
   * Deny every approval still outstanding, so the CLI stops waiting on a
   * question nobody can answer any more.
   *
   * Called from all three cancel paths. A prompt left hanging blocks the tool
   * call it guards for as long as the process lives, and the card carrying it
   * is gone from the panel the moment the turn ends.
   */
  private denyPendingPermissions(message: string): void {
    for (const id of this.pendingPermissions.keys()) {
      this.writeControl({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: id,
          response: { behavior: "deny", message }
        }
      });
    }
    this.pendingPermissions.clear();
  }

  /**
   * Answer a pending permission prompt. Writes the matching `control_response`
   * back to the CLI over stdin so the blocked tool call can proceed (allow) or
   * be rejected (deny). No-op if the turn already ended.
   */
  respondToPermission(
    requestId: string,
    behavior: PermissionBehavior,
    opts?: { restOfTurn?: boolean }
  ): void {
    const pending = this.pendingPermissions.get(requestId);
    // No matching pending prompt → this is a duplicate or stale answer (the
    // turn moved on, or the user double-clicked). Ignore it: responding again
    // is at best a no-op and at worst sends an empty `updatedInput`, which
    // would make an "allow" silently run the tool with no arguments.
    if (!pending) {
      logInfo(
        `[luno] permission response for unknown id ${requestId} — ignored`
      );
      return;
    }
    this.pendingPermissions.delete(requestId);
    logInfo(
      `[luno] permission ${behavior} for ${pending.toolName} (${requestId})`
    );
    if (behavior === "allow") {
      this.writeControl({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: requestId,
          // The CLI requires the (possibly edited) input echoed back; we pass
          // the original proposal through unchanged.
          response: { behavior: "allow", updatedInput: pending?.input ?? {} }
        }
      });
      // "Allow for the rest of this turn" — auto-approve further EDITS ourselves
      // (see handleControlRequest). We deliberately do NOT send the CLI's
      // suggested `set_permission_mode acceptEdits`: that mode also auto-runs
      // every Bash command (including `rm`/`curl`) with no prompt, which would
      // silently disable the destructive/network gate for the rest of the turn.
      if (opts?.restOfTurn) {
        this.autoAllowEdits = true;
      }
    } else {
      this.writeControl({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: requestId,
          response: {
            behavior: "deny",
            // Tell the model to stop rather than retry the same call — without
            // this it often re-proposes the action and the user gets prompted
            // again and again.
            message:
              "The user denied permission for this action and does not want it performed. Do not retry it or attempt an alternative way to achieve the same thing. Stop and briefly explain, or ask the user how they would like to proceed."
          }
        }
      });
    }
  }

  private writeControl(obj: unknown): void {
    try {
      this.child?.stdin?.write(JSON.stringify(obj) + "\n");
    } catch {
      /* stdin already closed — the child has exited; nothing to do. */
    }
  }

  /** Route a CLI control request. `can_use_tool` becomes a permission prompt;
   *  anything else is acknowledged so the CLI never blocks on us. */
  private handleControlRequest(
    ev: CliEvent,
    push: (d: StreamDelta) => void
  ): void {
    const requestId = ev.request_id;
    const req = ev.request;
    if (!requestId || !req || req.subtype !== "can_use_tool") {
      if (requestId) {
        this.writeControl({
          type: "control_response",
          response: { subtype: "success", request_id: requestId, response: {} }
        });
      }
      return;
    }
    const toolName = req.tool_name ?? "tool";
    const { action, destructive, network } = decidePermission(
      toolName,
      req.input,
      {
        autoAllowEdits: this.autoAllowEdits,
        agentMode: (this.opts.permissionMode ?? "default") === "auto",
        grants: this.opts.getToolGrants?.()
      }
    );
    if (action === "allow") {
      this.writeControl({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: requestId,
          response: { behavior: "allow", updatedInput: req.input ?? {} }
        }
      });
      return;
    }
    const payload: PermissionRequestPayload = {
      requestId,
      toolName,
      toolUseId: req.tool_use_id,
      input: req.input ?? {},
      description: req.description,
      destructive,
      network,
      suggestions: (req.permission_suggestions ?? []) as PermissionSuggestion[],
      grantLabel: offeredGrantLabel(toolName, req.input, destructive, network)
    };
    this.pendingPermissions.set(requestId, payload);
    logInfo(
      `[luno] permission needed: ${toolName}${destructive ? " (destructive)" : network ? " (network)" : ""} — awaiting user`
    );
    push({ type: "permission_request", permission: payload });
  }

  async *stream(req: ProviderRequest): AsyncIterable<StreamDelta> {
    const userText = lastUserText(req.messages);
    if (!userText) {
      yield { type: "error", error: "No user message to send." };
      return;
    }

    // Fresh per turn: a prior "allow edits this turn" must not leak into the next.
    this.autoAllowEdits = false;

    if (this.opts.sessionMode) {
      yield* this.streamInSession(req, userText);
      return;
    }

    const args = buildArgs(userText, req.model, this.opts);

    const child = spawn(this.opts.binary, args, {
      cwd: this.opts.cwd,
      env: this.childEnv(req.maxTokens),
      // stdin is a pipe in every mode. It carries the prompt, it carries
      // control responses where the protocol is live, and — the reason it is
      // no longer conditional — an open stdin is what keeps the CLI out of the
      // print wind-down that terminates background work. See buildArgs.
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;

    // Deliver the user turn as a stream-json message. stdin is intentionally
    // left OPEN — it is closed by endTurn(), which is what ends the turn.
    if (child.stdin) {
      const userMsg = JSON.stringify({
        type: "user",
        message: { role: "user", content: userText }
      });
      try {
        child.stdin.write(userMsg + "\n");
      } catch {
        /* spawn race — the exit/error handlers below surface it. */
      }
    }

    // Subagents launched with `run_in_background` that have not reported a
    // terminal status. Declared here because the silence watchdog below reads
    // it: a turn running background work is not wedged just because it is
    // quiet.
    const openTasks = new Set<string>();
    /**
     * How many background tasks the CLI itself says are registered, from its
     * `background_tasks_changed` roster.
     *
     * A second, independent answer to "is anything still running", and the
     * authoritative one — `openTasks` is our own bookkeeping off `task_*`
     * events, and twice now it has read empty while a workflow was demonstrably
     * alive, letting the grace timer end the turn and kill it at ten minutes.
     * Either source saying "busy" is enough to hold the turn.
     */
    let rosterSize = 0;
    /** Whether anything is still running, by either account. */
    const busyWithTasks = () => openTasks.size > 0 || rosterSize > 0;

    let silenceTimer: ReturnType<typeof setTimeout> | undefined;
    const clearSilence = () => {
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = undefined;
    };
    /** (Re)start the countdown from this moment — the child just showed a sign
     *  of life, so the budget it gets is measured from here. */
    const armSilence = () => {
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        // A workflow is silent by construction. Its agents report on state
        // change, not on a clock, so a phase whose agents are each grinding
        // through one long tool call produces nothing on stdout for as long as
        // that takes. Measured: a 4-agent phase reading a 265 MB binary went
        // quiet for ten minutes and was SIGKILLed here — all four sidechains
        // recorded `[Request interrupted by user]` within 10ms of each other,
        // ten minutes of work lost, and nothing anywhere said why.
        //
        // Nothing outside the CLI can tell that apart from a wedge, so while
        // the CLI says work is outstanding it gets the benefit of the doubt.
        // Stop is the user's lever, and it always was.
        if (busyWithTasks()) {
          armSilence();
          return;
        }
        // Never silently. This kill used to leave no log line, no error and no
        // trace in the transcript, which is the only reason it took three
        // sessions to find.
        logInfo(
          "[luno] claude produced nothing for the silence budget; killing it"
        );
        push({
          type: "error",
          error:
            "The Claude CLI stopped responding and was ended. Nothing it had " +
            "not already sent was recovered."
        });
        child.kill("SIGKILL");
        // Not waiting on `exit`: the thing being killed is by definition not
        // responding, and a turn that hangs on its death rattle is the bug
        // over again. Same reason the tool-stall watchdog ends the turn itself.
        push({ type: "done" });
      }, this.opts.silenceTimeoutMs ?? SILENCE_TIMEOUT_MS);
    };

    const rl = readline.createInterface({
      input: child.stdout!,
      crlfDelay: Infinity
    });
    let stderrBuf = "";
    child.stderr!.on("data", (b: Buffer) => {
      armSilence();
      stderrBuf += b.toString("utf8");
    });
    armSilence();

    const queue: StreamDelta[] = [];
    let resolver: (() => void) | null = null;
    let done = false;
    // Declared before push so push can route deltas through it; assigned just
    // below (its onStall handler calls push, so the two reference each other).
    let stallWatch: ToolStallWatchdog | null = null;
    const push = (d: StreamDelta) => {
      stallWatch?.observe(d);
      queue.push(d);
      resolver?.();
      resolver = null;
    };

    // Per-tool stall watchdog: if a latency-bounded tool (WebFetch/WebSearch)
    // never returns a result, surface a timeout result so the UI spinner clears
    // and stop the wedged CLI — instead of spinning until SILENCE_TIMEOUT_MS. The
    // CLI can't be told to abandon a single hung tool, so killing it (ending
    // the turn) is the only recovery.
    stallWatch = createToolStallWatchdog({
      timeoutMs: this.opts.toolStallMs ?? WEB_TOOL_STALL_MS,
      onStall: (toolId, toolName, ms) => {
        const secs = Math.round(ms / 1000);
        push({
          type: "tool_result",
          toolUseId: toolId,
          resultContent: `${toolName} did not respond within ${secs}s and was stopped. Try again, or use a more specific URL.`,
          resultIsError: true
        });
        if (this.child && !this.child.killed) {
          this.child.kill("SIGTERM");
          const c = this.child;
          setTimeout(() => {
            if (c && !c.killed) c.kill("SIGKILL");
          }, 2000);
        }
        push({ type: "done" });
      }
    });

    // Cancellation hook (see cancel()). Deny any outstanding prompt so the CLI
    // unblocks gracefully, then push `done` so the generator returns on its
    // next tick regardless of when the child actually exits.
    this.abortCurrent = () => {
      this.denyPendingPermissions("Cancelled by the user.");
      stallWatch?.clearAll();
      // Routed through endTurn so a pending background-agent grace timer is
      // cleared too — Stop must not leave one armed to fire a minute later.
      endTurn();
    };

    const processor = makeProcessor(
      this.opts.setResumeSessionId,
      this.opts.onSlashCommands
    );

    // While any task is open the turn is deliberately held past `result` — see
    // BACKGROUND_TASK_GRACE_MS for what that buys. `openTasks` itself is
    // declared above, with the silence watchdog that also reads it.
    /** A task has finished and the model has not said anything since — so the
     *  turn the CLI opens to report it has not run yet. See
     *  TASK_REPORT_GRACE_MS. */
    let pendingTaskReport = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let turnEnded = false;

    const endTurn = () => {
      if (turnEnded) return;
      turnEnded = true;
      if (graceTimer) clearTimeout(graceTimer);
      graceTimer = undefined;
      try {
        child.stdin?.end();
      } catch {
        /* already closed */
      }
      push({ type: "done" });
    };

    /** (Re)start the countdown from this moment — something just showed a sign
     *  of life, so the budget it gets is measured from here. */
    const armGrace = (ms: number) => {
      if (turnEnded) return;
      if (graceTimer) clearTimeout(graceTimer);
      graceTimer = setTimeout(() => {
        // Quiet is not evidence, and this is where believing it cost ten
        // minutes of work. Measured: the parent's stdout is silent for the
        // *whole* of a nested tool call — 47.1s across one `sleep 50` inside a
        // workflow agent — so a run doing anything slow looks exactly like a
        // run doing nothing. While the CLI still says work is outstanding the
        // turn is held rather than ended, the same benefit of the doubt the
        // silence watchdog gives, and for the same reason: ending here closes
        // stdin and the `finally` SIGTERMs the process, taking the work with
        // it. Stop is the user's lever.
        if (busyWithTasks()) {
          logInfo(
            `[luno] quiet, but ${openTasks.size} task(s) tracked and ${rosterSize} on the CLI roster; holding the turn`
          );
          armGrace(ms);
          return;
        }
        logInfo("[luno] quiet with nothing outstanding; ending the turn");
        endTurn();
      }, ms);
    };

    /** How long to wait before looking again. While work is outstanding this is
     *  only a re-check interval — see armGrace, which holds rather than ends —
     *  and otherwise it is the whole budget the model's report on a finished
     *  task gets. */
    const graceBudget = () =>
      busyWithTasks()
        ? (this.opts.backgroundGraceMs ?? BACKGROUND_TASK_GRACE_MS)
        : (this.opts.taskReportGraceMs ?? TASK_REPORT_GRACE_MS);

    let sawResult = false;

    rl.on("line", (line) => {
      armSilence();
      const trimmed = line.trim();
      if (!trimmed) return;
      let ev: CliEvent;
      try {
        ev = JSON.parse(trimmed) as CliEvent;
      } catch {
        return;
      }
      // Bidirectional control protocol (only live with --permission-prompt-tool
      // stdio). Handled here rather than in the pure event processor because
      // answering a request means writing back to the child's stdin.
      if (ev.type === "control_request") {
        this.handleControlRequest(ev, push);
        return;
      }
      // Acks to control requests *we* sent (e.g. set_permission_mode) — ignore.
      if (ev.type === "control_response") return;
      // The CLI's own roster of registered background work. Read here rather
      // than through the processor because nothing downstream needs it — it
      // exists so the turn-end timers have a source of truth that is not our
      // own `task_*` bookkeeping.
      if (ev.type === "system" && ev.subtype === "background_tasks_changed") {
        rosterSize = ev.tasks?.length ?? 0;
        logInfo(`[luno] CLI roster: ${rosterSize} background task(s)`);
      }
      for (const d of processor(ev)) {
        push(d);
        // Anything the model says settles the report a finished task is owed.
        // Read before the task branch so a notification arriving in the same
        // line cannot be cleared by output that preceded it.
        if (d.type === "text" || d.type === "tool_use_start") {
          pendingTaskReport = false;
        }
        if (d.type !== "task" || !d.task) continue;
        const { phase, taskId, status } = d.task;
        if (phase === "started") {
          openTasks.add(taskId);
          logInfo(`[luno] task opened: ${taskId} (${openTasks.size} open)`);
        } else if (phase === "notification" || isTerminalTaskStatus(status)) {
          openTasks.delete(taskId);
          pendingTaskReport = true;
          logInfo(`[luno] task closed: ${taskId} (${openTasks.size} open)`);
        }
      }
      // Under stream-json input the CLI keeps the session open for more input
      // after the turn, so closing stdin is what actually ends it. Held while a
      // backgrounded agent is still running: closing here kills it mid-step and
      // throws away work the user is watching a card for.
      //
      // The CLI emits a `result` per stretch of work, not one per turn. When an
      // agent answers, the model picks the conversation back up and reports what
      // came back — measured on 2.1.220, a second `result` followed the first by
      // ten seconds with a whole paragraph in between. Ending on the last agent
      // rather than on that second `result` cut the model off mid-sentence.
      // Recorded separately from the branch below because `onExit` reads it to
      // tell a turn that failed from a process that exited after answering.
      if (ev.type === "result") {
        sawResult = true;
        // A task that finished *before* this `result` leaves the turn owed one
        // more: the CLI answers its own `<task-notification>` in a fresh turn,
        // and that turn holds the only account of what the task produced.
        // Short workflows always land this way — ending here discarded it.
        if (!busyWithTasks() && !pendingTaskReport) endTurn();
        else armGrace(graceBudget());
        return;
      }
      // Past the first `result` the turn stays alive for the agents and for
      // whatever the model says once they answer. Any sign of either resets the
      // budget, so only real silence ends it.
      if (sawResult) armGrace(graceBudget());
    });

    const onExit = () => {
      clearSilence();
      stallWatch?.clearAll();
      const said = usefulStderr(stderrBuf);
      if (child.exitCode !== 0 && child.signalCode !== "SIGTERM") {
        const msg = exitFailure(stderrBuf, child.exitCode, sawResult);
        if (msg) push({ type: "error", error: msg });
      } else if (said.length) {
        // Never drop what the CLI said just because it left politely.
        logInfo(
          `[luno] claude exited ${child.exitCode ?? "?"} saying: ${said.join(" ")}`
        );
      }
      // A clean exit is still bad news when it takes running work with it, and
      // the CLI does explain itself: `Background tasks still running after
      // 600s; terminating.` was on stderr every time, and reading stderr only
      // on a bad exit code is why finding that cost four sessions. Not for our
      // own SIGTERM — that one is Stop, and the user knows.
      if (child.signalCode !== "SIGTERM" && busyWithTasks() && said.length) {
        push({ type: "error", error: said.join("\n") });
      }
      push({ type: "done" });
      done = true;
      resolver?.();
      resolver = null;
    };
    child.once("exit", onExit);
    child.once("error", (err) => {
      push({ type: "error", error: err.message });
    });

    try {
      while (true) {
        while (queue.length > 0) {
          const d = queue.shift()!;
          yield d;
          if (d.type === "done") return;
        }
        if (done) return;
        await new Promise<void>((res) => {
          resolver = res;
        });
      }
    } finally {
      clearSilence();
      stallWatch?.clearAll();
      this.abortCurrent = null;
      this.pendingPermissions.clear();
      // Wait for the process to fully exit before the turn ends — otherwise the
      // next turn's `--resume` races a still-alive CLI for the same session.
      await terminateChild(child);
      this.child = null;
    }
  }

  /**
   * One turn inside a process that outlives it.
   *
   * The reader is attached to the session rather than to the turn, so anything
   * the CLI emits between turns — a phone driving the same session — is still
   * read off the pipe and handed to `onOutOfTurn` instead of being dropped on
   * the floor or, worse, left to fill the pipe buffer.
   */
  private async *streamInSession(
    req: ProviderRequest,
    userText: string
  ): AsyncIterable<StreamDelta> {
    // The task-type playbook is classified from the prompt, so it changes the
    // moment the conversation shifts subject — and it reaches the CLI as
    // `--append-system-prompt`, which a live process cannot be told about. Left
    // to vary it replaced the process mid-conversation, which under Remote
    // Control means a new session URL and a phone that goes quiet. A running
    // session keeps the playbook it was spawned with; the next process picks up
    // whatever is current.
    const taskType = this.session?.exited
      ? this.opts.taskType
      : (this.session?.taskType ?? this.opts.taskType);
    const args = buildArgs(userText, req.model, { ...this.opts, taskType });
    let session: CliSession;
    try {
      session = this.ensureSession(args, req, taskType);
    } catch (err) {
      yield {
        type: "error",
        error: err instanceof Error ? err.message : String(err)
      };
      return;
    }

    const queue: StreamDelta[] = [];
    let resolver: (() => void) | null = null;
    let ended = false;
    let stallWatch: ToolStallWatchdog | null = null;
    const push = (d: StreamDelta) => {
      stallWatch?.observe(d);
      if (d.type === "done") ended = true;
      queue.push(d);
      resolver?.();
      resolver = null;
    };

    // Same contract as the per-turn watchdog, one difference: a wedged tool
    // must not take the process with it. Killing the child here would end the
    // session and drop any Remote Control bridge, so the turn is interrupted
    // over the control channel instead.
    stallWatch = createToolStallWatchdog({
      timeoutMs: this.opts.toolStallMs ?? WEB_TOOL_STALL_MS,
      onStall: (toolId, toolName, ms) => {
        const secs = Math.round(ms / 1000);
        push({
          type: "tool_result",
          toolUseId: toolId,
          resultContent: `${toolName} did not respond within ${secs}s and was stopped. Try again, or use a more specific URL.`,
          resultIsError: true
        });
        this.interrupt();
        push({ type: "done" });
      }
    });

    this.abortCurrent = () => {
      this.denyPendingPermissions("Cancelled by the user.");
      stallWatch?.clearAll();
      push({ type: "done" });
    };

    // A turn the user cancelled is over for us but not yet for the CLI: its
    // `result` is still on the way. Writing now would let that stale result
    // end this turn before it has said anything.
    await waitUntilIdle(session);

    session.sink = push;
    session.busy = true;
    const uuid = this.writeUserMessage(session, userText);
    if (!uuid) {
      session.sink = null;
      this.abortCurrent = null;
      yield {
        type: "error",
        error: "The Claude session is no longer accepting input."
      };
      return;
    }

    try {
      while (true) {
        while (queue.length > 0) {
          const d = queue.shift()!;
          yield d;
          if (d.type === "done") return;
        }
        if (ended) return;
        await new Promise<void>((res) => {
          resolver = res;
        });
      }
    } finally {
      stallWatch?.clearAll();
      this.abortCurrent = null;
      this.pendingPermissions.clear();
      // Hand the reader back to the out-of-turn sink. Guarded because a turn
      // that overlapped a replacement session must not detach the new one.
      if (session.sink === push) session.sink = null;
    }
  }

  /**
   * The live session, spawning or replacing it as needed.
   *
   * A process is replaced when argv changes in a way the control protocol
   * cannot express — `--effort` above all, which has no `set_effort`. The
   * conversation survives that (`--resume` carries it), but a Remote Control
   * bridge does not: it has to be re-established afterwards.
   */
  /**
   * @param taskType the playbook `args` were built with, recorded on the
   *   session so the next turn can keep using it rather than reclassifying and
   *   replacing the process underneath a connected device.
   */
  private ensureSession(
    args: string[],
    req: ProviderRequest | undefined,
    taskType?: TaskType
  ): CliSession {
    const live = this.session;
    if (live && !live.exited) {
      if (respawnFingerprint(live.args) === respawnFingerprint(args)) {
        if (req) this.applyLiveOptions(live, req);
        return live;
      }
      // Names the flag rather than just the fact. A replacement is invisible
      // from the panel and expensive under Remote Control — it hands the phone
      // a session URL it is not holding — so when one happens the log has to
      // say which option did it, or the next report is another round of
      // guessing.
      logInfo(
        `[luno] session options changed — replacing the CLI process: ${argvDiff(live.args, args)}`
      );
      this.disposeSession();
    }

    const child = spawn(this.opts.binary, args, {
      cwd: this.opts.cwd,
      env: this.childEnv(req?.maxTokens),
      stdio: ["pipe", "pipe", "pipe"]
    });
    const session: CliSession = {
      child,
      args,
      stderr: "",
      sink: null,
      processor: makeProcessor(
        this.opts.setResumeSessionId,
        this.opts.onSlashCommands
      ),
      exited: false,
      model: req?.model,
      permissionMode: this.opts.permissionMode ?? "default",
      taskType,
      busy: false,
      idleWaiters: [],
      pendingEchoes: new Set()
    };
    this.session = session;
    this.child = child;

    child.stderr?.on("data", (b: Buffer) => {
      session.stderr += b.toString("utf8");
    });

    const route = (d: StreamDelta) => {
      if (session.sink) session.sink(d);
      else this.opts.onOutOfTurn?.(d);
    };

    const rl = readline.createInterface({
      input: child.stdout!,
      crlfDelay: Infinity
    });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let ev: CliEvent;
      try {
        ev = JSON.parse(trimmed) as CliEvent;
      } catch {
        return;
      }
      if (ev.type === "control_request") {
        this.handleControlRequest(ev, route);
        return;
      }
      // A prompt answered on the phone cancels the request we are still
      // holding. Drop it, or the panel keeps showing a card whose answer would
      // be written against a request id the CLI has already forgotten.
      //
      // The withdrawn request rides along: the CLI says only which id is gone,
      // and by the time the panel hears about it the payload naming the tool
      // has been dropped here.
      if (ev.type === "control_cancel_request") {
        const withdrawn = ev.request_id
          ? this.pendingPermissions.get(ev.request_id)
          : undefined;
        if (ev.request_id && this.pendingPermissions.delete(ev.request_id)) {
          route({
            type: "permission_resolved",
            requestId: ev.request_id,
            permission: withdrawn
          });
        }
        return;
      }
      if (ev.type === "control_response") {
        this.resolveControl(ev);
        return;
      }
      // The bridge reporting on itself: ready → connected when a device joins,
      // disconnected/error when it goes. Session-level, not turn-level, so it
      // is read here rather than in the per-turn event processor.
      if (ev.type === "system" && ev.subtype === "bridge_state") {
        const next = bridgeStatus(ev, this.remoteControl);
        if (!next) return;
        this.remoteControl = next;
        // While our own enable request is in flight the CLI's `ready` arrives
        // first but carries no URL; the reply does, a moment later. Announcing
        // both means the banner appears twice, the second time saying the same
        // thing with a link. Let the reply speak.
        if (!this.remoteControlInFlight) {
          route({ type: "remote_control", remoteControl: this.remoteControl });
        }
        return;
      }
      // A prompt the session accepted from somewhere. Ours comes straight back
      // and is dropped; anything left was typed on a connected device, and it
      // is the only announcement that a turn nobody here started is beginning.
      // Read before the processor, which knows `user` events only as the
      // envelope a tool_result travels in.
      const prompt = replayedPrompt(ev);
      if (prompt !== null) {
        if (isCliControlMarker(prompt)) return;
        if (takeEcho(session.pendingEchoes, ev.uuid)) {
          // Ours. With a turn reading, the message was taken into that turn and
          // there is nothing to announce. With none — a steered message that
          // found no tool boundary before the turn ended — the CLI is opening a
          // turn of its own to answer it, and that answer needs a turn here to
          // arrive into.
          if (!session.sink) {
            session.busy = true;
            route({ type: "steer_turn", prompt });
          }
          return;
        }
        // The CLI is now working for the other surface. Marking the session
        // busy is what makes a prompt sent from here wait for that turn's
        // `result` instead of interleaving with it.
        session.busy = true;
        route({ type: "remote_prompt", prompt });
        return;
      }
      for (const d of session.processor(ev)) route(d);
      if (ev.type === "result") {
        // Not every `result` belongs to the turn currently holding the sink.
        // The CLI opens a turn of its own to answer a `<task-notification>`,
        // and it stamps that turn's result `origin: {kind: "task-notification"}`
        // — measured, `test/fixtures/workflow-stream.jsonl` line 24. That turn
        // sets neither of the two places `session.busy` is raised (it replays
        // no `user` message, so `replayedPrompt` cannot fire), so a panel turn
        // submitted while it runs installs its sink into a session that is
        // mid-turn, and this `result` would end it before it had said anything.
        if (ev.origin?.kind === "task-notification" && session.busy) return;
        session.busy = false;
        for (const wake of session.idleWaiters.splice(0)) wake();
        route({ type: "done" });
      }
    });

    child.once("exit", () => {
      session.exited = true;
      if (this.session === session) {
        this.session = null;
        this.child = null;
      }
      const unexpected = child.exitCode !== 0 && child.signalCode !== "SIGTERM";
      const said = usefulStderr(session.stderr);
      // Whatever it said on the way out, say it somewhere. Passing `answered:
      // true` to exitFailure — which a session process always has — makes it
      // return null every time, so this handler used to surface nothing at all,
      // however loudly the CLI explained itself. That is the same hole the
      // per-turn path had, and it is how a terminated workflow read as silence.
      if (said.length) {
        logInfo(
          `[luno] claude session exited ${child.exitCode ?? "?"} saying: ${said.join(" ")}`
        );
      }
      // A session process has answered many turns by the time it exits, so a
      // late non-zero code is never the current turn failing — but an
      // unexplained death mid-conversation is worth a line on screen.
      if (unexpected && said.length) {
        route({ type: "error", error: said.join("\n") });
      }
      route({ type: "done", sessionEnded: true });
    });
    child.once("error", (err) => {
      session.exited = true;
      route({ type: "error", error: err.message });
    });

    // A replaced process comes up with no bridge — measured: `--resume` brings
    // the conversation back and leaves Remote Control off. Re-establish it, or
    // changing the effort level would quietly disconnect the user's phone.
    if (this.remoteControlWanted) {
      void this.establishRemoteControl(session, route).catch(() => {
        /* state and delta already carry the failure */
      });
    }

    return session;
  }

  /** Push the options the control protocol *can* change onto a live session. */
  private applyLiveOptions(session: CliSession, req: ProviderRequest): void {
    const mode = this.opts.permissionMode ?? "default";
    if (req.model && req.model !== session.model) {
      this.writeControl({
        request_id: nextControlId(),
        type: "control_request",
        request: { subtype: "set_model", model: req.model }
      });
      session.model = req.model;
    }
    if (mode !== session.permissionMode) {
      this.writeControl({
        request_id: nextControlId(),
        type: "control_request",
        request: {
          subtype: "set_permission_mode",
          mode: mapPermissionMode(mode)
        }
      });
      session.permissionMode = mode;
    }
  }

  /**
   * Hand this conversation to claude.ai/code and the Claude mobile app.
   *
   * Session mode only, and not by accident: the bridge lives exactly as long
   * as the process behind it, so the per-turn path could offer a URL that
   * stops working the moment the answer finishes.
   *
   * Returns the session URL the other device connects to. Rejects with the
   * CLI's own message when it refuses — no claude.ai login, an API key in the
   * environment, a non-Anthropic base URL, or an organisation policy.
   */
  async enableRemoteControl(name?: string): Promise<RemoteControlStatus> {
    if (!this.opts.sessionMode) {
      throw new Error(
        "Remote Control needs a session-mode conversation: the bridge ends when the process does."
      );
    }
    this.remoteControlName = name;
    // Set before the process is spawned, not after the CLI confirms: childEnv
    // reads it to decide whether to stand aside on ANTHROPIC_API_KEY, and a
    // respawn racing this request re-establishes on the strength of it.
    this.remoteControlWanted = true;
    // Spawning with the bridge already wanted starts the request itself, so
    // this joins whatever is in flight rather than sending a second one.
    const session = this.ensureSession(
      buildArgs("", undefined, this.opts),
      undefined
    );
    try {
      return await this.establishRemoteControl(session);
    } catch (err) {
      this.remoteControlName = undefined;
      this.remoteControlWanted = false;
      throw err;
    }
  }

  /** Ask the CLI for a bridge, or join the request already asking. */
  private establishRemoteControl(
    session: CliSession,
    route?: (d: StreamDelta) => void
  ): Promise<RemoteControlStatus> {
    const existing = this.remoteControlInFlight;
    if (existing) return existing;
    const name = this.remoteControlName;
    const attempt = this.sendControl(session, {
      subtype: "remote_control",
      enabled: true,
      ...(name !== undefined && { name })
    })
      .then((response) => {
        this.remoteControl = {
          state: "ready",
          sessionUrl: asString(response.session_url),
          connectUrl: asString(response.connect_url)
        };
        logInfo(`[luno] remote control on: ${this.remoteControl.sessionUrl}`);
        route?.({ type: "remote_control", remoteControl: this.remoteControl });
        return this.remoteControl;
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.remoteControl = { state: "error", error: message };
        route?.({ type: "remote_control", remoteControl: this.remoteControl });
        throw err instanceof Error ? err : new Error(message);
      })
      .finally(() => {
        if (this.remoteControlInFlight === attempt) {
          this.remoteControlInFlight = null;
        }
      });
    this.remoteControlInFlight = attempt;
    return attempt;
  }

  /** Stop accepting input from other devices. The conversation itself carries
   *  on locally. */
  async disableRemoteControl(): Promise<void> {
    this.remoteControlName = undefined;
    const wanted = this.remoteControlWanted;
    this.remoteControlWanted = false;
    this.remoteControl = { state: "off" };
    const session = this.session;
    if (!wanted || !session || session.exited) return;
    try {
      await this.sendControl(session, {
        subtype: "remote_control",
        enabled: false
      });
    } catch (err) {
      // The bridge is off either way as far as this panel is concerned; a
      // failure here means the CLI never heard us, and the process is about to
      // be replaced or is already gone.
      logInfo(
        `[luno] remote control off (CLI did not confirm): ${String(err)}`
      );
    }
  }

  /** What the panel should be showing right now. */
  remoteControlStatus(): RemoteControlStatus {
    return this.remoteControl;
  }

  /**
   * Refresh the options a turn depends on, without discarding the process.
   *
   * The per-turn path rebuilds the whole provider every turn and needs none
   * of this. A session-mode provider outlives its turns, so the caller has to
   * hand it what changed — the editor's diagnostics and selection above all,
   * which describe the moment the message was sent and are worthless stale.
   *
   * Whether the change can be applied to the running process or needs a new
   * one is not decided here: the next turn's argv is compared through
   * `respawnFingerprint()`, so an option that only exists in argv replaces the
   * process by itself.
   */
  updateOptions(patch: Partial<ClaudeCliOpts>): void {
    this.opts = { ...this.opts, ...patch };
  }

  /** Send a control request and wait for the CLI's answer. */
  private sendControl(
    session: CliSession,
    request: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const requestId = nextControlId();
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingControls.delete(requestId);
        reject(
          new Error(
            `The Claude CLI did not answer '${String(request.subtype)}' within ${CONTROL_TIMEOUT_MS / 1000}s.`
          )
        );
      }, CONTROL_TIMEOUT_MS);
      this.pendingControls.set(requestId, { resolve, reject, timer });
      const wrote = this.writeToChild(session, {
        request_id: requestId,
        type: "control_request",
        request
      });
      if (!wrote) {
        clearTimeout(timer);
        this.pendingControls.delete(requestId);
        reject(new Error("The Claude session is no longer accepting input."));
      }
    });
  }

  /** Settle the promise for a control request we sent. */
  private resolveControl(ev: CliEvent): void {
    const response = ev.response;
    const requestId = response?.request_id;
    if (!requestId) return;
    const pending = this.pendingControls.get(requestId);
    if (!pending) return;
    this.pendingControls.delete(requestId);
    clearTimeout(pending.timer);
    if (response?.subtype === "success") {
      pending.resolve(
        (response.response as Record<string, unknown> | undefined) ?? {}
      );
    } else {
      pending.reject(new Error(response?.error ?? "The Claude CLI refused."));
    }
  }

  /** Stop the current turn without ending the session.
   *
   *  Takes every background agent with it — measured against 2.1.219, a running
   *  agent reported `status: "stopped"` 10ms after the request. So this is for
   *  Stop and nothing else: no path that merely *sends* may come through here.
   */
  private interrupt(): void {
    this.writeControl({
      request_id: nextControlId(),
      type: "control_request",
      request: { subtype: "interrupt" }
    });
  }

  /**
   * Interrupt, and hand back whatever the CLI had not read yet.
   *
   * The queue lives inside the CLI, and its answer to `interrupt` carries
   * `still_queued`. Measured against 2.1.219: a message the turn had already
   * accepted comes back as `[]`, so this returns what was written and never
   * looked at, not everything typed.
   *
   * Failure is not reported anywhere — the interrupt is the point, and a CLI
   * that will not answer a control request has already left the user with a
   * stopped turn and nothing to hand back.
   */
  private async interruptReturningQueued(): Promise<void> {
    const session = this.session;
    if (!session || session.exited) return;
    try {
      const res = await this.sendControl(session, { subtype: "interrupt" });
      const queued = Array.isArray(res.still_queued)
        ? res.still_queued.filter((t): t is string => typeof t === "string")
        : [];
      if (queued.length) this.opts.onStillQueued?.(queued.join("\n\n"));
    } catch {
      /* the turn is stopped either way */
    }
  }

  /**
   * Write one user message to the live session, and register its echo.
   *
   * Shared by the turn that opens a stream and by `steer`, because the message
   * on the wire is identical either way — only the reader's state differs.
   *
   * @returns the uuid it was written under, or null if stdin would not take it.
   */
  private writeUserMessage(
    session: CliSession,
    userText: string
  ): string | null {
    const preamble = turnPreamble(this.opts);
    const sent = preamble ? preamble + userText : userText;
    // Our own id on our own message. The CLI keeps it and returns it on the
    // replay, which is how the echo is recognised without guessing from the
    // text. Registered before the write, not after: the replay can be back
    // before the next tick, and an unregistered echo would land on the timeline
    // as a prompt the user never typed on the phone.
    const uuid = randomUUID();
    session.pendingEchoes.add(uuid);
    const wrote = this.writeToChild(session, {
      type: "user",
      uuid,
      session_id: "",
      parent_tool_use_id: null,
      // Says a person typed this, here. The official extension stamps the same
      // field on every message it sends — `send(…, {kind:"human"})` in its
      // webview — and a session shared with another device is the one place
      // where "who sent this" is not obvious from the fact that it arrived.
      origin: { kind: "human" },
      message: { role: "user", content: sent }
    });
    if (!wrote) {
      takeEcho(session.pendingEchoes, uuid);
      return null;
    }
    return uuid;
  }

  /**
   * Add to the turn already in flight instead of waiting for it.
   *
   * The CLI picks a second `user` message off stdin at the next tool boundary
   * and continues the *same* turn — measured on 2.1.219: written at 7.78s,
   * echoed at 8.24s, no second `system/init`, one `result`. Pure text
   * generation has no boundary, so a message sent into it waits and the CLI
   * opens the next turn for it itself; that is physics, not a defect.
   *
   * Deliberately does **not** install a sink, raise `busy` or wait for idle.
   * The message belongs to the turn already reading, and interrupting to make
   * room would kill every background agent (see `interrupt`).
   *
   * @returns false when there is no live session to write to, which is the
   *   caller's signal to open an ordinary turn instead.
   */
  steer(userText: string): boolean {
    const session = this.session;
    if (!session || session.exited) return false;
    return this.writeUserMessage(session, userText) !== null;
  }

  private writeToChild(session: CliSession, obj: unknown): boolean {
    const stdin = session.child.stdin;
    // Deliberately not the return value of write(): `false` there means the
    // buffer is above its high-water mark, not that the write failed. Right
    // after spawn it is routinely false while the pipe is still connecting,
    // and the data is queued and delivered regardless.
    if (session.exited || !stdin || stdin.destroyed || stdin.writableEnded) {
      return false;
    }
    try {
      stdin.write(JSON.stringify(obj) + "\n");
      return true;
    } catch {
      return false;
    }
  }

  private childEnv(maxTokens?: number): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    // Remote Control requires a claude.ai OAuth login and refuses to start
    // under an API key — and the CLI prefers an env-supplied key over its own
    // credentials, so injecting ours is exactly what would break it. When the
    // bridge is wanted, stand aside and let the CLI use `/login`.
    const wantsBridge = this.remoteControlWanted;
    if (wantsBridge && env.ANTHROPIC_API_KEY) delete env.ANTHROPIC_API_KEY;
    if (this.opts.token && !wantsBridge)
      env.ANTHROPIC_API_KEY = this.opts.token;
    if (Number.isFinite(maxTokens) && (maxTokens ?? 0) > 0) {
      env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(Math.floor(maxTokens!));
    }
    // Belt to buildArgs' braces. Stream-json input already keeps the CLI out of
    // its print wind-down, but if any configuration ever falls back to the argv
    // path this stops the CLI terminating background work behind our back: `0`
    // is its own documented value for "wait indefinitely", and the bounds that
    // remain are ours — the silence watchdog, and Stop.
    env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS ??= "0";
    return env;
  }

  /** End the long-lived process. Safe to call when there is none. */
  disposeSession(): void {
    const session = this.session;
    if (!session) return;
    this.session = null;
    if (this.child === session.child) this.child = null;
    session.exited = true;
    session.sink = null;
    void terminateChild(session.child);
  }
}

/** Diagnostics and editor context as a block that rides with the turn text.
 *  Session mode only: there the system prompt is fixed at spawn, and these two
 *  describe the moment the message was sent. */
export function turnPreamble(opts: ClaudeCliOpts): string {
  const parts = [opts.diagnostics, opts.editorContext].filter(
    (p): p is string => Boolean(p && p.trim())
  );
  return parts.length ? parts.join("\n\n") + "\n\n" : "";
}

/** argv reduced to what forces a respawn. `--resume` is dropped: it only
 *  matters at spawn, and it changes as soon as the first turn reports a
 *  session id, which would otherwise replace the process every turn. */
/**
 * What changed between two argv lists, short enough for one log line.
 *
 * Values are truncated: a `--append-system-prompt` payload is a whole document,
 * and the useful part is which flag moved, not what it now says.
 */
export function argvDiff(
  before: ReadonlyArray<string>,
  after: ReadonlyArray<string>
): string {
  const clip = (s: string) => (s.length > 60 ? `${s.slice(0, 57)}…` : s);
  const gone = before.filter((a) => !after.includes(a));
  const added = after.filter((a) => !before.includes(a));
  const parts: string[] = [];
  if (gone.length) parts.push(`-${gone.map(clip).join(" -")}`);
  if (added.length) parts.push(`+${added.map(clip).join(" +")}`);
  return parts.join(" ") || "argument order";
}

/** `--allowedTools` patterns for connected MCP servers, in a fixed order — see
 *  the note at the call site for why the order is load-bearing. */
export function mcpToolPatterns(names: ReadonlyArray<string> = []): string[] {
  return [...new Set(names)].sort().map((n) => `mcp__${n}`);
}

export function respawnFingerprint(args: ReadonlyArray<string>): string {
  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--resume") {
      i++;
      continue;
    }
    // The MCP config is written to a fresh `mkdtemp` directory every turn, so
    // its path differs even when nothing about the servers did. Left in, it
    // replaced the process on *every* turn — and with Remote Control on, each
    // replacement hands out a new session URL and silently strands the phone on
    // the old one. The server set still counts: it reaches argv separately, as
    // `--allowedTools mcp__<name>`.
    if (args[i] === "--mcp-config") {
      i++;
      continue;
    }
    kept.push(args[i]);
  }
  return JSON.stringify(kept);
}

/** Read a string out of a CLI response without trusting its shape. */
function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

let controlSeq = 0;
function nextControlId(): string {
  controlSeq += 1;
  return `luno-${controlSeq}`;
}

/** Resolve once the CLI has finished the turn it is on, or after
 *  TURN_DRAIN_TIMEOUT_MS — a wedged CLI must not leave the panel unable to
 *  send anything ever again. */
function waitUntilIdle(session: CliSession): Promise<void> {
  if (!session.busy || session.exited) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      logInfo("[luno] previous turn never reported a result — sending anyway");
      session.busy = false;
      finish();
    }, TURN_DRAIN_TIMEOUT_MS);
    session.idleWaiters.push(finish);
  });
}

/** Resolve once the child has exited; SIGTERM, then SIGKILL after a grace period. */
function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    let kill: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (kill) clearTimeout(kill);
      resolve();
    };
    child.once("exit", finish);
    try {
      child.kill("SIGTERM");
    } catch {
      finish();
      return;
    }
    kill = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      setTimeout(finish, 200);
    }, 2000);
  });
}

/**
 * @param _userText kept so every caller still reads as "the args for this
 *   prompt", but no configuration puts the prompt in argv any more — it is
 *   written to stdin by the caller.
 */
export function buildArgs(
  _userText: string,
  model: string | undefined,
  opts: ClaudeCliOpts
): string[] {
  const mode = opts.permissionMode ?? "default";
  const permissionProtocol = usesPermissionProtocol(mode);

  // Session mode drops `--print`, matching how the official extension spawns
  // the CLI: the process outlives the turn and keeps taking input. `-p` would
  // also stay alive under stream-json input, but Remote Control is only ever
  // exercised upstream in the no-print configuration, so we run the one that
  // is known to work rather than the one that merely should.
  const args = opts.sessionMode ? [] : ["-p"];
  args.push(
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose"
  );
  // The prompt always travels on stdin (see stream()), never as a positional
  // argument. Measured on 2.1.219: with the prompt in argv the CLI reports
  // `no stdin data received in 3s, proceeding without it` and opens its print
  // wind-down window, which terminates every background task still running
  // CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS later — a workflow was stopped at
  // 10m07s with `status: "stopped"`. The same workflow under stream-json input,
  // where stdin never closes and the window never opens, ran 13m14s to its own
  // completion. Bypass and Plan were the two modes still on the argv path.
  args.push("--input-format", "stream-json");
  if (permissionProtocol || opts.sessionMode) {
    // Route per-tool approval back to us over the control channel instead of
    // the CLI's own interactive prompt (which a headless run can't service).
    args.push("--permission-prompt-tool", "stdio");
  }
  if (opts.sessionMode) {
    // Without this a prompt typed on a connected phone or browser reaches
    // stdout nowhere — measured — and the panel would render an answer to a
    // question it never saw. It echoes our own stdin messages back too, so the
    // reader drops anything carrying `isReplay` that it just sent itself.
    args.push("--replay-user-messages");
  }
  if (model) args.push("--model", model);

  // Reasoning effort — the CLI validates the level itself, but we guard
  // against a stale/unknown config value reaching argv. Ultracode outranks
  // whatever level came with it: the setting is defined as xhigh + workflows,
  // and a stored posture pairing it with `max` would ask for a combination the
  // CLI does not offer.
  const effort = opts.ultracode ? "xhigh" : opts.effort;
  // A pinned version that predates this level would reject the flag, and the
  // failure would arrive as a CLI error with nothing pointing back at the
  // picker. Dropping it runs the turn at the model's own default instead.
  const ladder = model ? EFFORT_LADDERS[model] : undefined;
  const takesEffort = !ladder || ladder.includes(effort as EffortLevel);
  if (effort && EFFORT_LEVELS.includes(effort) && takesEffort) {
    args.push("--effort", effort);
  }

  // `--settings` layers a JSON blob on top of the resolved settings sources
  // (user/project/local) for this run only, so anything we set here leaves
  // every other setting intact.
  //   • alwaysThinkingEnabled — extended-thinking toggle (when defined).
  //   • permissions.ask — route git to our classifier even when a project
  //     allowlist pre-approves it. `ask` outranks `allow` in the CLI's
  //     deny → ask → allow resolution, so it can't be silently overridden.
  const settings: Record<string, unknown> = {};
  if (typeof opts.thinking === "boolean") {
    settings.alwaysThinkingEnabled = opts.thinking;
  }
  //   • ultracode — session-scoped by the CLI's own definition, which is why it
  //     travels here per run rather than being written to a settings file. Sent
  //     only when on: the key's absence is its off state, and writing `false`
  //     would override a settings file that deliberately turned it on.
  if (opts.ultracode) settings.ultracode = true;
  // Only inject the `ask` routing in modes that actually service the approval
  // channel (default/auto, where `--permission-prompt-tool stdio` is wired up).
  // Plan and bypass have no prompt tool, so an `ask` rule there would have
  // nothing to answer it: in plan it could block even read-only git, and in
  // bypass it would reintroduce the very prompt the mode exists to remove.
  if (permissionProtocol) {
    settings.permissions = {
      ask: ROUTE_TO_CLASSIFIER_BASH.map((p) => `Bash(${p})`)
    };
  }
  if (Object.keys(settings).length > 0) {
    args.push("--settings", JSON.stringify(settings));
  }

  const cliMode = mapPermissionMode(opts.permissionMode ?? "default");
  args.push("--permission-mode", cliMode);

  if (opts.permissionMode === "auto") {
    // Auto mode = auto-accept the SAFE, reversible tools, then route
    // everything else (destructive shell, deletes, unknown tools) through the
    // approval card. We pre-allow them explicitly here rather than via the
    // CLI's `acceptEdits` mode, because acceptEdits *also* auto-runs `rm` and
    // other destructive Bash with no prompt. Edits stay reversible via the
    // checkpoint system, so auto-applying them is safe. Bash is deliberately
    // NOT pre-allowed except for the user's own allow-listed patterns.
    const tools = [
      "Read",
      "Glob",
      "Grep",
      "Edit",
      "Write",
      "MultiEdit",
      "NotebookEdit",
      ...(opts.allowedBashPatterns ?? []).flatMap((p) =>
        regexToCliPatterns(p)
          // Never pre-allow a destructive or network/external command, even if
          // the user allow-listed it — those must always surface the approval
          // card. Dropping them here means the CLI re-asks (routing them to us)
          // instead of auto-running.
          .filter((cli) => !isDestructiveBash(cli) && !isNetworkBash(cli))
          .map((cli) => `Bash(${cli})`)
      ),
      // Pre-allow every tool from each connected MCP server. Pattern is
      // `mcp__<server>` per Claude Code's MCP tool naming convention.
      //
      // Sorted, because argv decides whether a session-mode process survives
      // the turn: these names arrive from three sources merged through a Set,
      // one of them a cache a probe rewrites, so the same servers can come back
      // in a different order. A reordered argv replaced the CLI process — and
      // with Remote Control on, that hands the phone a session URL it is not
      // holding.
      ...mcpToolPatterns(opts.mcpServerNames)
    ];
    args.push("--allowedTools", ...tools);
  } else if (opts.permissionMode === "default" && opts.mcpServerNames?.length) {
    // Default mode otherwise gates every tool call behind an interactive
    // prompt the `-p` flow can't service — the agent ends up verbalizing
    // "I need permission" instead of actually invoking the tool. Connecting
    // an MCP server via the Connectors page is an explicit consent grant
    // (OAuth + click-through), so pre-allow that server's tools here.
    // Plan mode is intentionally not covered — it's read-only by design.
    args.push("--allowedTools", ...mcpToolPatterns(opts.mcpServerNames));
  }

  // Skills the user has toggled off in the picker need to be *actually*
  // blocked. Belt-and-suspenders:
  //   1. --disallowedTools "Skill(<name>)" — if Claude Code's permission
  //      system honors per-skill patterns, this is hard enforcement.
  //   2. --append-system-prompt — even if the flag pattern is ignored, the
  //      agent reads the appended instruction and refuses. Together they
  //      cover both the gate path and the model-decides path.
  const disabled = (opts.disabledSkills ?? []).filter((s) => s.length > 0);
  if (disabled.length > 0) {
    args.push("--disallowedTools", ...disabled.map((id) => `Skill(${id})`));
    const list = disabled.map((id) => `\`${id}\``).join(", ");
    args.push(
      "--append-system-prompt",
      `The user has disabled the following Claude Code skills via Luno's Skills picker: ${list}. Do not invoke any of them, even if a task would benefit. If you would normally use a disabled skill, tell the user which skill is disabled and ask them to re-enable it from the Skills picker before retrying. All other skills remain available.`
    );
  }

  // Per-mode prompt: bundled MD that tunes the model's stance for plan/default/auto.
  const modeAppend = getModePrompt(mode);
  if (modeAppend) args.push("--append-system-prompt", modeAppend);

  // Plan-mode only: the matching task-type playbook (backend / frontend / etc.).
  // Skipped for default/auto to keep their token budgets lean.
  if (mode === "plan" && opts.taskType) {
    const taskAppend = getTaskTypePrompt(opts.taskType);
    if (taskAppend) args.push("--append-system-prompt", taskAppend);
  }

  // What the language servers already know. Sent as its own append so it can
  // be dropped without disturbing the mode or conventions prompts.
  //
  // Both of these describe the tree and the cursor *as of this message*, so
  // they change every turn. A session-mode process is spawned once and cannot
  // have its system prompt rewritten, so there they travel with the turn text
  // instead (see turnPreamble) rather than being frozen at spawn — stale
  // diagnostics are worse than none.
  if (opts.diagnostics && !opts.sessionMode) {
    args.push("--append-system-prompt", opts.diagnostics);
  }

  // What the user has open and highlighted as they send the message.
  if (opts.editorContext && !opts.sessionMode) {
    args.push("--append-system-prompt", opts.editorContext);
  }

  // Project conventions. CLAUDE.md at root is auto-loaded by the CLI itself —
  // re-injecting would double the token cost — so skip in that case.
  if (opts.conventions && !opts.conventions.alreadyLoadedByCli) {
    args.push(
      "--append-system-prompt",
      `Project conventions from \`${opts.conventions.workspaceRelativePath}\`:\n\n${opts.conventions.content}`
    );
  }

  // Hand the CLI a list of remote MCP servers it should connect to for
  // this turn. The file is generated per-turn from Luno's connector
  // state, and the bearer tokens it contains live in OS temp with
  // mode 0600 — see writeCliMcpConfig() in services/mcp/index.ts.
  if (opts.mcpConfigPath) {
    args.push("--mcp-config", opts.mcpConfigPath);
  }

  const resumeId = opts.getResumeSessionId?.();
  if (resumeId) args.push("--resume", resumeId);

  return args;
}

function mapPermissionMode(m: PermissionMode): string {
  switch (m) {
    case "plan":
      return "plan";
    // The CLI approves every tool itself and never emits a `can_use_tool`
    // request, so our permission policy is not consulted at all — not for
    // edits, not for `rm`, not for the destructive/network gate. That is the
    // mode's entire purpose; the guard against reaching it lives in the UI and
    // in `setPermissionMode`, not here.
    case "bypass":
      return "bypassPermissions";
    // `auto` deliberately runs in the CLI's `default` mode rather than
    // `acceptEdits`. acceptEdits silently auto-runs *every* tool — including
    // destructive `Bash` like `rm` — without ever consulting our permission
    // tool, so a delete could happen with no prompt. Instead we pre-allow the
    // safe, reversible tools (Read/Edit/Write + allow-listed Bash) via
    // --allowedTools so edits still apply automatically, and let everything
    // else (deletes, arbitrary shell, unknown tools) route through the
    // approval card.
    case "auto":
      return "default";
    default:
      return "default";
  }
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

const DESTRUCTIVE_BASH: ReadonlyArray<RegExp> = [
  /\brm\b/,
  /\brmdir\b/,
  /\bunlink\b/,
  /\bshred\b/,
  /\btrash\b/,
  /\bgit\s+(rm|clean)\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+checkout\s+--\s/,
  /\bgit\s+push\b[^\n]*(--force|\s-f\b)/,
  /\bfind\b[^\n]*-delete\b/,
  /\bfind\b[^\n]*-exec\s+rm\b/,
  /\b(dd|mkfs|fdisk)\b/,
  /\bsudo\b/,
  /\bchmod\s+-R\b/,
  /\bchown\s+-R\b/,
  /:\s*\(\s*\)\s*\{/, // fork bomb :(){ ... }
  /\bkill\s+-9\b/,
  />\s*\/dev\/(sd|nvme|disk|null\/)/,
  REMOTE_PIPE_TO_SHELL
];

/** Commands that reach the network or outside the workspace. Always prompt and
 *  never auto-allowed (even if the user allow-listed them), but not flagged as
 *  irreversibly destructive. */
const NETWORK_BASH: ReadonlyArray<RegExp> = [
  /\bcurl\b/,
  /\bwget\b/,
  /\bssh\b/,
  /\bscp\b/,
  /\bsftp\b/,
  /\brsync\b/,
  /\b(nc|ncat|netcat)\b/,
  /\btelnet\b/,
  /\bftp\b/,
  /\bgit\s+(push|pull|fetch|clone|remote)\b/
];

export function isDestructiveBash(command: string): boolean {
  return DESTRUCTIVE_BASH.some((re) => re.test(command));
}

export function isNetworkBash(command: string): boolean {
  return NETWORK_BASH.some((re) => re.test(command));
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
 * The wording for an "always allow" button, or `undefined` when the card must
 * not offer one.
 *
 * Destructive and network calls are refused here as well as in
 * `decidePermission`. Two checks for one rule is deliberate: this one keeps the
 * button off the screen, and that one would refuse the grant even if a message
 * arrived claiming otherwise.
 */
function offeredGrantLabel(
  toolName: string,
  input: Record<string, unknown> | undefined,
  destructive: boolean,
  network: boolean
): string | undefined {
  if (destructive || network) return undefined;
  const grant = grantFor(toolName, input);
  return grant ? grantLabel(grant) : undefined;
}

export type PermissionAction = "allow" | "prompt";

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
 * **Agent (`auto`)** — everything that is neither destructive nor network runs
 * without asking. Reading a file and editing one are the work; a tool that
 * stops to ask permission for them is not an agent, it is a prompt with extra
 * steps. This is a deliberate loosening, made by the user for their own tool,
 * and it is exactly what the mode's own description in package.json has always
 * claimed it did.
 *
 * **Ask (`default`)** — the conservative list, unchanged:
 *  - A standing grant the user made from an approval card auto-allows. It is
 *    checked here, below the gate, so "always allow `Bash(bun run …)`" can
 *    never become "always allow `rm`".
 *  - Plan/answer helper tools auto-allow (they have their own UI).
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
  }
): PermissionDecision {
  const destructive = isDestructiveRequest(toolName, input);
  const network = isNetworkRequest(toolName, input);
  if (!destructive && !network) {
    if (ctx.agentMode) return { action: "allow", destructive, network };
    if (ctx.grants?.length && coveredByGrants(ctx.grants, toolName, input)) {
      return { action: "allow", destructive, network };
    }
    if (PERMISSION_AUTO_ALLOW.has(toolName))
      return { action: "allow", destructive, network };
    // Read-only inspection (file reads, globs, greps, read-only MCP queries)
    // never mutates state — always auto-allow so exploration never prompts.
    if (READ_ONLY_TOOLS.has(toolName) || isReadOnlyMcpTool(toolName)) {
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

interface CliUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/**
 * The `usage` block on a `system`/`task_*` event.
 *
 * Deliberately not `CliUsage`: the CLI reuses the field name for a completely
 * different measurement — how much the *subagent* spent, not the main turn's
 * token counts. The two are intersected on `CliEvent.usage` because both are
 * all-optional, so reading either shape needs no cast and neither can silently
 * pick up the other's numbers.
 */
export interface CliTaskUsage {
  total_tokens?: number;
  tool_uses?: number;
  duration_ms?: number;
}

/** `system`/`task_*` subtype → the phase the rest of the app speaks in. */
const TASK_PHASES: Record<string, SubagentPhase> = {
  task_started: "started",
  task_progress: "progress",
  task_updated: "updated",
  task_notification: "notification"
};

export interface CliEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  /**
   * Set to the dispatching `Agent` tool_use id on everything a subagent
   * produces; `null` on the main agent's own traffic.
   *
   * The one field in this protocol that changes what an event *means* rather
   * than adding to it, which is why it is read before anything else.
   */
  parent_tool_use_id?: string | null;
  /** Resolved model id on the `system`/`init` event (alias → concrete id). */
  model?: string;
  /** Every slash command the CLI knows, reported on `system`/`init`. */
  /** On a `result` — what opened the turn it ends. `task-notification` marks
   *  the turn the CLI opens by itself to report a finished background task,
   *  which is not a turn any surface here asked for. */
  origin?: { kind?: string };
  slash_commands?: string[];
  /** The same list, republished on `system`/`commands_changed` when it changes
   *  mid-session. Named differently on the wire from `slash_commands`. */
  commands?: string[];
  /** Set on a `user` event the CLI is playing back rather than receiving:
   *  either the prompt we just wrote to stdin, or one typed on a connected
   *  phone. Only present with `--replay-user-messages`. */
  isReplay?: boolean;
  /** Message id. The CLI mints one, or keeps the one the client supplied and
   *  returns it on the replay — which is how our own prompt is recognised
   *  coming back. */
  uuid?: string;
  message?: {
    /** Resolved model id on each `assistant` message — the model that
     *  actually produced this turn's output. */
    model?: string;
    /** A replayed `user` message carries the prompt as a bare string —
     *  measured on 2.1.219 — where everything else uses blocks. */
    content?:
      | string
      | Array<
          | { type: "text"; text: string }
          | {
              type: "tool_use";
              id: string;
              name: string;
              input: Record<string, unknown>;
            }
          | {
              type: "tool_result";
              tool_use_id: string;
              content: unknown;
              is_error?: boolean;
            }
        >;
    usage?: CliUsage;
  };
  event?: {
    type: string;
    content_block?: {
      type: string;
      id?: string;
      name?: string;
      text?: string;
    };
    delta?: {
      type: string;
      text?: string;
      partial_json?: string;
      /** Some CLI versions attach final usage on the message_delta event. */
      usage?: CliUsage;
    };
    index?: number;
  };
  /** End-of-turn result event — has the canonical post-turn usage + cost. On a
   *  `task_*` event this same field carries {@link CliTaskUsage} instead. */
  usage?: CliUsage & CliTaskUsage;
  total_cost_usd?: number;
  error?: string;
  result?: string;
  /**
   * Present on `system`/`compact_boundary`.
   *
   * Both spellings are read because both exist: the wire format observed on
   * 2.1.219 is snake_case, while the CLI carries its own reader for a
   * camelCase shape. Taking one on faith would silently drop the numbers —
   * the event would still arrive and the marker would still render, just with
   * nothing in it, which is the least detectable kind of wrong.
   */
  compact_metadata?: {
    trigger?: string;
    pre_tokens?: number;
    post_tokens?: number;
  };
  compactMetadata?: {
    trigger?: string;
    preTokens?: number;
    postTokens?: number;
  };
  /** Present on the end-of-turn `result` event: per-model totals, including
   *  the context window the model actually ran with. */
  modelUsage?: Record<string, { contextWindow?: number }>;
  /** Present on `rate_limit_event`. `resetsAt` is unix *seconds*, unlike
   *  every other timestamp in this protocol. */
  rate_limit_info?: {
    status?: string;
    resetsAt?: number;
    rateLimitType?: string;
    isUsingOverage?: boolean;
  };
  /**
   * `system`/`task_*` fields — one subagent's lifecycle.
   *
   * Spread flat across the event rather than nested, and unevenly: `task_id` is
   * the only one every phase carries. `task_updated` in particular has neither
   * `tool_use_id` nor a top-level `status` — its status lives in `patch`, which
   * is why reading only the top level would leave every task looking unfinished.
   */
  task_id?: string;
  tool_use_id?: string;
  subagent_type?: string;
  task_type?: string;
  /** `meta.name` from the workflow script, on a `local_workflow` task. */
  workflow_name?: string;
  /** Per-phase and per-agent state of a running workflow, on `task_progress`.
   *  The CLI has already computed everything a progress view needs. */
  workflow_progress?: WorkflowProgressEntry[];
  /** Every background task currently registered, on `background_tasks_changed`.
   *  An empty array is the CLI stating that nothing is running. */
  tasks?: Array<{
    task_id?: string;
    task_type?: string;
    description?: string;
  }>;
  description?: string;
  prompt?: string;
  status?: string;
  last_tool_name?: string;
  summary?: string;
  output_file?: string;
  patch?: { status?: string; end_time?: number };

  /** Control-protocol fields — present on `control_request` events the CLI
   *  emits when `--permission-prompt-tool stdio` is active. */
  request_id?: string;
  request?: {
    subtype?: string;
    tool_name?: string;
    display_name?: string;
    tool_use_id?: string;
    description?: string;
    input?: Record<string, unknown>;
    permission_suggestions?: Array<Record<string, unknown>>;
  };
  /** The CLI's answer to a control request we sent. */
  response?: {
    subtype?: string;
    request_id?: string;
    error?: string;
    response?: Record<string, unknown>;
  };
  /** Carried on `system`/`bridge_state` — the Remote Control bridge reporting
   *  on itself. */
  state?: string;
  /** Why the bridge failed, on `bridge_state` with `state: "error"`. */
  detail?: string;
}

type Processor = (ev: CliEvent) => StreamDelta[];

/**
 * The prompt inside a replayed `user` event, or null if the event is not one.
 *
 * `--replay-user-messages` plays back every user message the session accepts,
 * from whichever surface sent it — which is the only way a prompt typed on a
 * phone reaches us at all. Two things it must not match: the `user` events that
 * carry a `tool_result` back to the model (the same event type, every turn), and
 * anything a subagent produced, which is stamped with its dispatching tool id
 * and is not the conversation talking.
 *
 * The prompt arrives as a bare string rather than a block list — measured on
 * 2.1.219 — but the block form is accepted too, since an attachment sent from
 * the phone has nowhere else to go.
 */
export function replayedPrompt(ev: CliEvent): string | null {
  if (ev.type !== "user" || ev.parent_tool_use_id) return null;
  // `--replay-user-messages` is what this reads, and the CLI marks what it
  // replays. Without the check any `user` record the CLI injects for its own
  // bookkeeping was taken for a prompt someone typed. Measured: real prompts
  // carry the flag in both recordings under `test/fixtures/`.
  if (ev.isReplay !== true) return null;
  const content = ev.message?.content;
  if (typeof content === "string") return content || null;
  if (!Array.isArray(content)) return null;
  if (content.some((b) => b.type === "tool_result")) return null;
  const text = content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
  return text || null;
}

/**
 * Markers the CLI writes into the conversation as `user` records that no one
 * typed. They are its own bookkeeping and must never open a turn.
 *
 * Observed rather than designed: with Remote Control on, a Stop put
 * `[Request interrupted by user]` on the timeline **as the user's own message**
 * three times in one session, each stamped to the same second as an
 * `aborting turn` log line — and each opened a turn against the CLI, so the
 * model answered a control marker as if it were a prompt. The string is the
 * CLI's (it occurs in `claude.exe`, nowhere in this repo).
 *
 * A string match, and deliberately so: the wire shape of that record was not
 * captured — an interrupt sent after generation ends does not produce it — so
 * there is no field here worth gating on yet. Widen this to the field once
 * someone catches one mid-generation.
 */
const CLI_CONTROL_MARKERS = new Set(["[Request interrupted by user]"]);

/** Whether this replayed prompt is the CLI talking to itself. */
export function isCliControlMarker(prompt: string): boolean {
  return CLI_CONTROL_MARKERS.has(prompt.trim());
}

/**
 * Whether this replayed prompt is the echo of one we wrote ourselves.
 *
 * The replay flag does not distinguish the two surfaces — our own stdin writes
 * come back exactly like a phone's do. The discriminator is the id we put on
 * the message before sending it: the CLI preserves a client-supplied `uuid` and
 * returns it on the replay (measured against 2.1.219), which is how the
 * official extension tells its own messages apart. Matching on the text instead
 * would swallow a phone sending the same words we just did.
 *
 * Consumed rather than merely tested, so nothing accumulates for a session that
 * runs all day.
 */
export function takeEcho(
  pending: Set<string>,
  uuid: string | undefined
): boolean {
  if (!uuid) return false;
  return pending.delete(uuid);
}

/**
 * What a `bridge_state` event makes of the status we hold, or null when it
 * changes nothing.
 *
 * `detail` carries why the bridge failed and is the only account of it — a pill
 * reading "error" with no reason is what the user would otherwise get. The
 * official extension reads the same field.
 */
export function bridgeStatus(
  ev: CliEvent,
  current: RemoteControlStatus
): RemoteControlStatus | null {
  const state = ev.state;
  const known =
    state === "ready" ||
    state === "connected" ||
    state === "disconnected" ||
    state === "error";
  if (!known || state === current.state) return null;
  if (state === "error") {
    return { ...current, state, error: ev.detail ?? "Bridge error" };
  }
  // A recovered bridge must not keep describing the failure it recovered from.
  const { error: _gone, ...rest } = current;
  return { ...rest, state };
}

export function makeProcessor(
  setResume?: (id: string) => void,
  onSlashCommands?: (names: string[]) => void
): Processor {
  let sawPartialText = false;
  /** Whether this turn has already put text on the wire. Guards the paragraph
   *  break below so the first message does not open with blank lines. */
  let emittedText = false;
  const startedToolIds = new Set<string>();
  let currentBlockType: "text" | "tool_use" | "other" | null = null;
  // The CLI reports the *resolved* model (aliases like `opus` expand to a
  // concrete id). Emit it once per change so the UI can show what's actually
  // running rather than the alias the user picked.
  let reportedModel: string | null = null;
  /**
   * How much context the most recent *request* occupied, and the window it ran
   * in.
   *
   * Kept per stream because the `result` event cannot answer the first
   * question: its `usage` is the turn's running total, summed over every
   * request in it. Measured on a two-request turn — 33,453 then 34,372 — the
   * result reported 67,825, which is neither request and grows without bound
   * as a turn goes on. A twenty-request turn read 173% of a 1M window.
   */
  let lastRequestContext: number | undefined;
  let lastContextWindow: number | undefined;
  const emitModel = (model: string | undefined, out: StreamDelta[]) => {
    if (model && model !== reportedModel) {
      reportedModel = model;
      out.push({ type: "model", model });
    }
  };

  return (ev) => {
    const out: StreamDelta[] = [];

    // Everything a subagent produces is stamped with the `Agent` tool_use id
    // that dispatched it, and none of it is the conversation talking. Verified
    // on 2.1.220: a subagent's `assistant` event carries a real `tool_use`
    // block, so without this its nested Grep is emitted as a `tool_use_start`
    // and renders on the main timeline as a tool the top-level model ran. Its
    // `tool_result` would likewise be fed back into the main message history.
    // The subagent is reported through `task_*` instead — the only channel
    // that says which agent the work belongs to.
    if (ev.parent_tool_use_id) return out;

    if (ev.type === "system" && ev.subtype && ev.subtype in TASK_PHASES) {
      const update = taskUpdate(ev, TASK_PHASES[ev.subtype]);
      if (update) out.push({ type: "task", task: update });
      return out;
    }

    // The CLI folded earlier messages into a summary to make room. Silent
    // until now: a long chat simply stopped remembering its own beginning,
    // which reads as the product losing the user's work.
    if (ev.type === "system" && ev.subtype === "compact_boundary") {
      const meta = ev.compact_metadata ?? ev.compactMetadata;
      const postTokens =
        (meta as { post_tokens?: number } | undefined)?.post_tokens ??
        (meta as { postTokens?: number } | undefined)?.postTokens;
      out.push({
        type: "compact",
        compaction: {
          trigger: meta?.trigger,
          preTokens:
            (meta as { pre_tokens?: number } | undefined)?.pre_tokens ??
            (meta as { preTokens?: number } | undefined)?.preTokens,
          postTokens
        }
      });
      // The context just shrank, and the next request is what would otherwise
      // report it — until then the row would keep showing a window that is no
      // longer full, at exactly the moment the user is watching it. The CLI
      // says how much survived; Anthropic's extension zeroes the count here,
      // which is the same move with less information.
      lastRequestContext = typeof postTokens === "number" ? postTokens : 0;
      if (lastContextWindow !== undefined) {
        out.push({
          type: "usage",
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            contextTokens: lastRequestContext,
            contextWindow: lastContextWindow
          }
        });
      }
      return out;
    }

    if (ev.type === "system" && ev.subtype === "init") {
      if (ev.session_id) setResume?.(ev.session_id);
      // The CLI's own answer to "what can be typed after a slash" — built-ins,
      // plugins and the user's `.claude/commands` alike. It arrives only on a
      // turn, so the composer caches it rather than asking.
      if (ev.slash_commands?.length) onSlashCommands?.(ev.slash_commands);
      emitModel(ev.model, out);
      return out;
    }

    // The command list is not fixed for the life of a session: installing a
    // plugin or writing a new `.claude/commands` file makes the CLI republish
    // it here rather than on a fresh `init`. Cached from `init` alone, a
    // command added mid-session never appeared in the popover.
    if (ev.type === "system" && ev.subtype === "commands_changed") {
      if (ev.commands?.length) onSlashCommands?.(ev.commands);
      return out;
    }

    if (ev.type === "stream_event" && ev.event) {
      const inner = ev.event;
      // A second assistant message in the same turn — the model picking the
      // conversation back up after a backgrounded agent answered. Its text is
      // appended to the same buffer, and with no tool call in between to flush
      // it the two run together: "…I'll summarise." + "The first one is back —"
      // rendered as one sentence with no break. Nothing downstream can tell
      // where a message ended, so the break is made here, where it is visible.
      if (inner.type === "message_start" && emittedText) {
        out.push({ type: "text", text: "\n\n" });
        return out;
      }
      if (inner.type === "content_block_start" && inner.content_block) {
        if (inner.content_block.type === "text") {
          currentBlockType = "text";
        } else if (inner.content_block.type === "tool_use") {
          currentBlockType = "tool_use";
          const id = inner.content_block.id ?? "";
          const name = inner.content_block.name ?? "tool";
          if (id) startedToolIds.add(id);
          out.push({ type: "tool_use_start", tool: { id, name } });
        } else {
          currentBlockType = "other";
        }
        return out;
      }
      if (inner.type === "content_block_delta" && inner.delta) {
        if (
          currentBlockType === "text" &&
          inner.delta.type === "text_delta" &&
          typeof inner.delta.text === "string"
        ) {
          sawPartialText = true;
          emittedText = true;
          out.push({ type: "text", text: inner.delta.text });
        } else if (
          currentBlockType === "tool_use" &&
          inner.delta.type === "input_json_delta" &&
          typeof inner.delta.partial_json === "string"
        ) {
          out.push({
            type: "tool_use_input",
            partialInput: inner.delta.partial_json
          });
        }
        return out;
      }
      if (inner.type === "content_block_stop") {
        if (currentBlockType === "tool_use") {
          out.push({ type: "tool_use_end" });
        }
        currentBlockType = null;
        return out;
      }
      return out;
    }

    if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
      emitModel(ev.message.model, out);
      for (const block of ev.message.content) {
        if (block.type === "text") {
          if (!sawPartialText) {
            // Same boundary as `message_start` above, for the build that sends
            // whole messages rather than partials.
            if (emittedText) out.push({ type: "text", text: "\n\n" });
            emittedText = true;
            out.push({ type: "text", text: block.text });
          }
        } else if (block.type === "tool_use") {
          if (!startedToolIds.has(block.id)) {
            startedToolIds.add(block.id);
            out.push({
              type: "tool_use_start",
              tool: { id: block.id, name: block.name }
            });
            out.push({
              type: "tool_use_input",
              partialInput: JSON.stringify(block.input ?? {})
            });
            out.push({ type: "tool_use_end" });
          }
        }
      }
      sawPartialText = false;
      // Some CLI versions ship per-assistant-message usage. Forward it so the
      // meter shows live counts as the turn streams (the final result event
      // sends a corrected total later).
      //
      // This is also the only place the context occupancy can be read: one
      // assistant message is one request, so its own input + cache figures are
      // what that request put in front of the model. The window is not on this
      // event, so a live update only happens once a `result` in this stream has
      // named it.
      const u = ev.message.usage;
      if (u) {
        lastRequestContext = contextSize(u);
        const delta = makeUsageDelta(u, ev.session_id);
        if (delta.usage && lastContextWindow !== undefined) {
          delta.usage.contextTokens = lastRequestContext;
          delta.usage.contextWindow = lastContextWindow;
        }
        out.push(delta);
      }
      return out;
    }

    // Only the block form: a `user` event whose content is a bare string is a
    // replayed prompt, and the session reader has already taken it.
    if (ev.type === "user" && Array.isArray(ev.message?.content)) {
      for (const block of ev.message.content) {
        if (block.type === "tool_result") {
          const content =
            typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
                ? block.content
                    .map((c: unknown) => {
                      const cc = c as { type?: string; text?: string };
                      return cc.type === "text" && cc.text ? cc.text : "";
                    })
                    .join("\n")
                : JSON.stringify(block.content);
          out.push({
            type: "tool_result",
            toolUseId: block.tool_use_id,
            resultContent: content,
            resultIsError: !!block.is_error
          });
        }
      }
      return out;
    }

    if (ev.type === "result") {
      // The end-of-turn `result` event carries the canonical totals — emit a
      // usage delta with cost if reported so the meter can switch from
      // estimate to authoritative.
      if (ev.usage) {
        const u = makeUsageDelta(ev.usage, ev.session_id);
        if (u.usage && typeof ev.total_cost_usd === "number") {
          u.usage.costUsd = ev.total_cost_usd;
        }
        if (u.usage) {
          // Not `contextSize(ev.usage)`: this event's usage is the turn's sum
          // across every request, so a long turn reports several times the
          // window it ran in. The last request's own figure is the answer, and
          // when the CLI shipped no per-message usage there is none — the row
          // then holds its previous value rather than showing a total as an
          // occupancy.
          lastContextWindow =
            contextWindowOf(ev.modelUsage, reportedModel) ?? lastContextWindow;
          u.usage.contextTokens = lastRequestContext;
          u.usage.contextWindow = lastContextWindow;
        }
        out.push(u);
      }
      if (ev.subtype === "error" || ev.subtype === "error_max_turns") {
        out.push({
          type: "error",
          error:
            ev.result ||
            (ev.subtype === "error_max_turns"
              ? "Claude CLI hit max turns. Try a simpler prompt or increase turns."
              : ev.subtype)
        });
      }
      return out;
    }

    // The only authoritative quota signal on this path. The CLI holds the HTTP
    // exchange and never passes the `anthropic-ratelimit-*` headers through,
    // so without this event the reset time can only be guessed from message
    // timestamps on disk — and that guess is wrong by hours whenever a window
    // boundary falls inside the range being scanned.
    if (ev.type === "rate_limit_event" && ev.rate_limit_info) {
      const info = ev.rate_limit_info;
      if (typeof info.resetsAt === "number" && info.rateLimitType) {
        out.push({
          type: "rate_limit",
          rateLimit: {
            bucket: info.rateLimitType,
            resetsAt: info.resetsAt * 1000,
            status: info.status ?? "allowed",
            usingOverage: info.isUsingOverage,
            observedAt: Date.now()
          }
        });
      }
      return out;
    }

    if (ev.type === "error") {
      out.push({
        type: "error",
        error: ev.error || "Claude CLI reported an error."
      });
    }

    return out;
  };
}

export function mapEvent(
  ev: CliEvent,
  setResume?: (id: string) => void
): StreamDelta[] {
  return makeProcessor(setResume)(ev);
}

export interface ToolStallWatchdog {
  /** Feed every outbound delta through this; arms a timer when a watched tool
   *  starts executing and clears it when the tool's result lands. */
  observe(delta: StreamDelta): void;
  /** Cancel all pending timers (call when the turn ends for any reason). */
  clearAll(): void;
}

/**
 * Watches latency-bounded tools (WebFetch/WebSearch) for a missing result.
 *
 * The CLI emits `tool_use_start` → `tool_use_end` when it dispatches a tool,
 * then a `tool_result` when it returns. If the tool wedges (no result), no
 * further deltas flow and the only backstop is the 10-minute process kill —
 * leaving the UI spinning the whole time. This arms a per-tool timer on
 * `tool_use_end` and fires `onStall` if the matching `tool_result` hasn't
 * arrived in `timeoutMs`. The pure logic lives here so it's unit-testable
 * without spawning the CLI.
 */
export function createToolStallWatchdog(opts: {
  timeoutMs: number;
  onStall: (toolId: string, toolName: string, timeoutMs: number) => void;
  tools?: ReadonlySet<string>;
}): ToolStallWatchdog {
  const watched = opts.tools ?? STALL_WATCHDOG_TOOLS;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const names = new Map<string, string>();
  // tool_use_end carries no id, so correlate it with the most recent start —
  // the CLI streams tool-use content blocks sequentially (start → … → stop).
  let lastStartedId: string | null = null;

  const clear = (id: string) => {
    const t = timers.get(id);
    if (t) {
      clearTimeout(t);
      timers.delete(id);
    }
  };

  return {
    observe(d) {
      if (d.type === "tool_use_start" && d.tool) {
        lastStartedId = d.tool.id;
        names.set(d.tool.id, d.tool.name);
      } else if (d.type === "tool_use_end" && lastStartedId) {
        const id = lastStartedId;
        const name = names.get(id) ?? "";
        if (watched.has(name)) {
          clear(id);
          timers.set(
            id,
            setTimeout(() => {
              timers.delete(id);
              opts.onStall(id, name, opts.timeoutMs);
            }, opts.timeoutMs)
          );
        }
      } else if (d.type === "tool_result" && d.toolUseId) {
        clear(d.toolUseId);
      }
    },
    clearAll() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    }
  };
}

/**
 * One `system`/`task_*` event, flattened into the shape the rest of the app
 * reads. Pure translation — which of these reach the timeline and which stay
 * live is the host's decision, not this function's.
 *
 * Returns null for an event with no `task_id`: without it there is nothing to
 * correlate the update with, and a card that can never be closed is worse than
 * one that never opened.
 */
/**
 * Notices the CLI writes to stderr and then carries on from.
 *
 * The workspace-trust one is printed at startup, so it sits in the buffer for
 * the whole run and became the stated cause of every later failure it had
 * nothing to do with — including a turn that had already answered in full.
 */
const STDERR_ADVISORIES: ReadonlyArray<RegExp> = [
  /permissions\.allow entries/i,
  /has not been trusted/i,
  /hasTrustDialogAccepted/i
];

/**
 * What to tell the user when the CLI exits non-zero — often nothing.
 *
 * An exit that lands after the turn's own `result` is not that turn failing:
 * the answer is on screen, and marking the chat red contradicts what the user
 * is reading. Those go to the log instead, where a real diagnosis can find
 * them.
 */
/** The lines of stderr worth reading back. The advisories the CLI prints on
 *  runs that went fine are not among them. */
function usefulStderr(stderr: string): string[] {
  return stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) => line && !STDERR_ADVISORIES.some((advice) => advice.test(line))
    );
}

export function exitFailure(
  stderr: string,
  code: number | null,
  answered: boolean
): string | null {
  const lines = usefulStderr(stderr);
  if (answered) {
    logInfo(
      `[luno] claude exited ${code ?? "?"} after answering` +
        (lines.length ? `: ${lines.join(" ")}` : "")
    );
    return null;
  }
  return lines.join("\n") || `claude exited with code ${code ?? "?"}`;
}

function taskUpdate(ev: CliEvent, phase: SubagentPhase): SubagentUpdate | null {
  if (!ev.task_id) return null;
  const u = ev.usage;
  return {
    phase,
    taskId: ev.task_id,
    toolUseId: ev.tool_use_id,
    taskType: ev.task_type,
    workflowName: ev.workflow_name,
    subagentType: ev.subagent_type,
    // Same wire field, two different meanings — see `SubagentTask.activity`.
    description: phase === "progress" ? undefined : ev.description,
    activity: phase === "progress" ? ev.description : undefined,
    prompt: ev.prompt,
    // `task_updated` hides its status one level down; the others report it flat.
    status: ev.patch?.status ?? ev.status,
    durationMs: u?.duration_ms,
    toolUses: u?.tool_uses,
    totalTokens: u?.total_tokens,
    lastToolName: ev.last_tool_name,
    // Phase-gated for the same reason `description` is, and the contract says
    // so: `notification` is the only phase whose `summary` is an answer. On
    // `task_progress` the CLI echoes the *task's own description* there —
    // measured in `test/fixtures/workflow-stream.jsonl`, where four progress
    // records repeat "probe run for a stream audit" and the first is stamped
    // `duration_ms: 22`. Copied through, that string reached the card as a
    // finished answer 22ms after launch, under the heading "Answered".
    summary: phase === "notification" ? ev.summary : undefined,
    outputFile: ev.output_file,
    // Passed through on its own merit, never gated on `task_type`: measured on
    // 2.1.219, the CLI sends `task_type` on `task_started` and on no other
    // phase, so a gate here discards `workflow_progress` on every event that
    // actually carries it. Which kind of task this is belongs to the host,
    // which has the dispatch merged in — see `onSubagentUpdate`.
    workflowProgress: ev.workflow_progress
  };
}

function makeUsageDelta(u: CliUsage, sessionId?: string): StreamDelta {
  return {
    type: "usage",
    usage: {
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheReadTokens:
        u.cache_read_input_tokens !== undefined
          ? u.cache_read_input_tokens
          : undefined,
      cacheCreatedTokens:
        u.cache_creation_input_tokens !== undefined
          ? u.cache_creation_input_tokens
          : undefined,
      sessionId
    }
  };
}

/**
 * How much context the request that just ran occupied.
 *
 * Cached tokens count: they are part of the prompt the model read, and leaving
 * them out reports a nearly-full window as nearly empty — cache reads are most
 * of a long conversation. This is the same sum the CLI uses internally to
 * decide when to compact.
 */
export function contextSize(u: CliUsage): number {
  return (
    (u.input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    // The reply counts too: it is already written, and the next request carries
    // it as history. Anthropic's own extension sums the same four fields —
    // `updateUsage` in its webview bundle, 2.1.220.
    (u.output_tokens ?? 0)
  );
}

/**
 * The window the model actually ran with.
 *
 * Read from the CLI's per-model totals rather than assumed from the model name:
 * the same alias resolves to a different window depending on the `[1m]` variant
 * and the account, and guessing 200k for a million-token run would put the
 * meter at 5× the truth.
 */
export function contextWindowOf(
  modelUsage: Record<string, { contextWindow?: number }> | undefined,
  mainLoopModel?: string | null
): number | undefined {
  if (!modelUsage) return undefined;
  // The model that ran the main loop, when the CLI named it — that is the
  // conversation's own window, and it is what Anthropic's extension reads
  // (`modelUsage[currentMainLoopModel]`).
  const named = mainLoopModel
    ? modelUsage[mainLoopModel]?.contextWindow
    : undefined;
  if (typeof named === "number" && named > 0) return named;

  // Otherwise the largest of them. Several models can appear in one turn (a
  // haiku side-call alongside the main model), and a side-call's smaller
  // window would understate the room left.
  let largest: number | undefined;
  for (const entry of Object.values(modelUsage)) {
    const w = entry?.contextWindow;
    if (
      typeof w === "number" &&
      w > 0 &&
      (largest === undefined || w > largest)
    ) {
      largest = w;
    }
  }
  return largest;
}

function lastUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    const text = (m.content as ContentBlock[])
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}
