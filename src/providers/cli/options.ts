// ─────────────────────────────────────────────────────────────
// How a CLI process is configured, and which of those settings a process
// already running cannot be told about.
//
// Its own module because `args.ts` and the provider both need the shape and
// neither should import the other. Nothing here runs anything — it is the
// description of a spawn, not the spawn.
// ─────────────────────────────────────────────────────────────

import type {
  PermissionMode,
  StreamDelta,
  TaskType
} from "../../core/types.js";
import type { ToolGrant } from "../../core/tool-grants.js";
import type { IdeToolOps } from "../../core/ide-tools.js";
import type { EffortLevel } from "../../core/effort.js";
import type { ConventionsFile } from "../../services/conventions.js";

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
  /** The editor half of the `ide` MCP server. Injected rather than imported so
   *  this file keeps importing zero VS Code APIs — which is what lets the
   *  control protocol be tested without a mock editor. */
  ideOps?: IdeToolOps;
  /** Withdraw any editor work still waiting on the user — today that is an
   *  open proposed diff. Called wherever a pending dialog is cancelled, and
   *  for the same reason: an `openDiff` nobody will answer parks the turn. */
  onAbortIdeWork?: (reason: string) => void;
  /** Folders the agent may touch besides `cwd` — every other workspace folder,
   *  plus `luno.additionalDirectories`. Decided by `additionalDirectories()`. */
  additionalDirectories?: string[];
  /** Models to try when the first is overloaded, highest preference first. */
  fallbackModels?: string[];
  /** Per-session spend ceiling in dollars. Absent means none. */
  maxBudgetUsd?: number;
  /** What the CLI calls this session in its own `/resume` picker. */
  sessionName?: string;
  /** Run with every customization off — CLAUDE.md, skills, hooks, MCP. A
   *  support switch, for telling "my setup is broken" from "LUNO is broken". */
  safeMode?: boolean;
  /** Skill ids the user toggled OFF in the picker. Enforced via
   *  --disallowedTools "Skill(<id>)" plus a system-prompt append. */
  disabledSkills?: string[];
  /**
   * The model the next turn will ask for.
   *
   * Read by spawns that have **no turn behind them** — the Remote Control
   * toggle is the only one — and nowhere else: a turn carries its own model on
   * the `ProviderRequest`. It exists because argv built without a model makes a
   * different `--effort` decision than argv built with one, and the two have to
   * match or `respawnFingerprint` reads a bridge toggle as a settings change
   * and replaces the process the phone is attached to.
   */
  model?: string;
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
  /**
   * Whether this conversation has work that a process replacement would
   * destroy — a turn in flight, or a background agent that has not reported.
   *
   * Read at the top of every turn, not captured: the answer changes while the
   * user sits in the settings. Absent, a replacement happens as it always did.
   */
  hasLiveWork?: () => boolean;
  /** Told which of the user's choices this process is not honouring yet, so the
   *  panel can mark those controls rather than lie about them. Called with an
   *  empty list whenever a fresh process makes the question moot. */
  onSettingsPending?: (pending: PendingSetting[]) => void;
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

/** A composer control whose setting cannot reach a running CLI. */
export type PendingSetting = "mode" | "effort" | "thinking" | "skills";

/**
 * Which of the user's choices this process is not honouring yet.
 *
 * Measured against 2.1.219: the CLI takes exactly five settings on a live
 * session — `set_cwd`, `set_model`, `set_permission_mode`,
 * `set_max_thinking_tokens`, `set_mcp_permission_mode_override`. Everything
 * else rides on argv, and argv is fixed at spawn. The official extension makes
 * the same trade and simply offers no way to change effort mid-channel; we
 * defer instead, which is only honest if the panel says so.
 *
 * `mode` is listed even though `set_permission_mode` exists, because the mode
 * also carries an `--append-system-prompt` block: the enforcement changes
 * immediately, the posture prompt does not.
 */
export function pendingSettings(
  spawned: ClaudeCliOpts,
  wanted: ClaudeCliOpts
): PendingSetting[] {
  const pending: PendingSetting[] = [];
  if (
    (spawned.permissionMode ?? "default") !==
    (wanted.permissionMode ?? "default")
  ) {
    pending.push("mode");
  }
  if (
    spawned.effort !== wanted.effort ||
    spawned.ultracode !== wanted.ultracode
  ) {
    pending.push("effort");
  }
  if (spawned.thinking !== wanted.thinking) pending.push("thinking");
  const before = [...(spawned.disabledSkills ?? [])].sort().join(" ");
  const after = [...(wanted.disabledSkills ?? [])].sort().join(" ");
  if (before !== after) pending.push("skills");
  return pending;
}
