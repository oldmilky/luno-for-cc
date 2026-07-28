export type Role = "user" | "assistant" | "system" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  id: string;
  content: string;
  isError?: boolean;
}

export interface Message {
  role: Role;
  content: string | Array<ContentBlock>;
}

export type ContentBlock =
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
      content: string;
      is_error?: boolean;
    };

/**
 * How tool calls get approved.
 *
 * These are LUNO's modes, not the CLI's — `auto` in particular has no CLI
 * equivalent, being `default` plus an explicit allow-list. See
 * `mapPermissionMode` in `providers/claude-cli.ts` for the translation.
 *
 * `bypass` is the one that turns the gate off entirely: the CLI approves
 * everything itself and never asks, so no approval card appears for anything —
 * including `rm`, `curl … | bash` and force-push. Enabling it requires an
 * explicit confirmation, and it is deliberately absent from the Shift+Tab
 * cycle: a mode that disables every safety check should not be two keystrokes
 * away by accident.
 */
export type PermissionMode = "default" | "plan" | "auto" | "bypass";

export type TaskType =
  | "backend"
  | "frontend"
  | "fullstack"
  | "devops"
  | "integration"
  | "docs-driven"
  | "refactor"
  | "bugfix"
  | "migration"
  | "new-impl"
  | "generic";

export interface TokenUsage {
  /** Tokens read from prompt (incl. cached). */
  inputTokens: number;
  /** Tokens emitted by the assistant in this message. */
  outputTokens: number;
  /** Cached prompt tokens served from a previously-written cache (cheap). */
  cacheReadTokens?: number;
  /** Prompt tokens written to a new cache entry (one-time cost). */
  cacheCreatedTokens?: number;
  /** Total cost in USD if the provider reports it. */
  costUsd?: number;
  /** Free-form session identifier the provider associates with this usage. */
  sessionId?: string;
  /**
   * How much of the model's context the last request occupied, and how much
   * there is. Both come from the CLI's own numbers: the size is
   * `input + cache_creation + cache_read`, which is the sum the CLI itself
   * uses, and the window is what it reports for the model that ran.
   *
   * Unlike the plan caps in the meter, these are not estimates.
   */
  contextTokens?: number;
  contextWindow?: number;
}

/**
 * The CLI folded earlier messages into a summary to make room.
 *
 * Worth surfacing because the alternative is a chat that appears to forget its
 * own beginning for no stated reason — the user reads that as the product
 * losing their work rather than as the context window doing its job.
 */
export interface CompactionInfo {
  /** `auto` when the CLI did it to make room; otherwise the user asked. */
  trigger?: string;
  /** Context size either side of the fold, when the CLI reports them. */
  preTokens?: number;
  postTokens?: number;
}

/**
 * One subagent the main agent dispatched through its `Agent` tool.
 *
 * The CLI owns the whole lifecycle — it dispatches, runs and reports; nothing
 * here executes anything. What it does is carry the four `system`/`task_*`
 * events into one shape, because each of them says a different part of the
 * story and none of them says all of it.
 *
 * Field availability by phase, observed on 2.1.220 and not guessable:
 * `started` has the identity and the prompt; `progress` replaces `description`
 * with what the subagent is doing *right now* and adds `lastToolName`;
 * `updated` carries nothing but `taskId` and the patch — no `toolUseId`, which
 * is why the host keeps the id map; `notification` is the only one with
 * `summary`.
 */
export interface SubagentTask {
  /** CLI task id — the only field present on every phase. */
  taskId: string;
  /** The main agent's `Agent` tool_use block this task belongs to. Absent on
   *  `updated`; the host fills it in from `started`. */
  toolUseId?: string;
  /** Which agent ran: `Explore`, `general-purpose`, a name from
   *  `.claude/agents/`. */
  subagentType?: string;
  /** The label the main agent gave the task. Set once, on `started`. */
  description?: string;
  /**
   * What the subagent is doing at this moment — "Searching for makeProcessor".
   *
   * Split out because the CLI sends it in `description`, the same field it used
   * for the task label. Merging the two in place would leave a finished card
   * reading whatever the agent happened to be doing a second before it stopped,
   * instead of what it was asked for.
   */
  activity?: string;
  /** The full prompt handed to the subagent. `started` only. */
  prompt?: string;
  /**
   * Kept as a free string rather than a union: the CLI adds statuses between
   * releases, and an unknown one must render as itself instead of collapsing
   * into "done". Terminal values are decided by {@link isTerminalTaskStatus}.
   */
  status?: string;
  /** Wall-clock the CLI measured, not a difference of our own timestamps. */
  durationMs?: number;
  /** How many tools the subagent has used so far — the only cheap signal that
   *  a long-running agent is alive without routing its nested traffic. */
  toolUses?: number;
  totalTokens?: number;
  /** Name of the tool the subagent most recently ran. `progress` only. */
  lastToolName?: string;
  /** The subagent's answer, handed back to the main agent. `notification`
   *  only. */
  summary?: string;
  /** Where the CLI spilled the full output when it was too long to inline. */
  outputFile?: string;
}

/** Which `task_*` event this update came from. The host routes on it: two of
 *  the four belong on the timeline, the other two are live-only. */
export type SubagentPhase = "started" | "progress" | "updated" | "notification";

export interface SubagentUpdate extends SubagentTask {
  phase: SubagentPhase;
}

/**
 * Whether a reported status means the subagent has stopped.
 *
 * Anything unrecognised counts as still running, which is the safe way round:
 * a card left spinning is corrected by the turn-end sweep, whereas a card
 * closed early reports a result the subagent never produced.
 */
export function isTerminalTaskStatus(status: string | undefined): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "error" ||
    status === "cancelled" ||
    status === "canceled" ||
    // What the CLI reports for a backgrounded agent whose process was killed
    // under it. Observed on resume: a session whose turn ended while three
    // `async_launched` agents were still running replayed three
    // `task_notification`s with exactly this status. Without it the card was
    // relabelled `interrupted` — the same thing in this case, but by accident.
    status === "stopped" ||
    status === "interrupted"
  );
}

/**
 * The quota verdict the CLI reports mid-turn, from its `rate_limit_event`.
 *
 * This is the only authoritative quota signal available on the subscription
 * path — the CLI owns the HTTP exchange and does not pass the
 * `anthropic-ratelimit-*` headers through. It says which window is currently
 * binding and exactly when that window resets; it does not say how much of it
 * is spent. Amounts still come from the session files on disk, anchored to
 * this reset time.
 */
export interface RateLimitStatus {
  /**
   * Which quota is binding: `five_hour`, `seven_day`, `seven_day_sonnet`,
   * `seven_day_opus`. Kept as a string — the CLI adds buckets (`extra_usage`,
   * `cinder_cove`) between releases, and an unknown one must display, not
   * crash.
   */
  bucket: string;
  /** ms epoch when that window resets. */
  resetsAt: number;
  /** The CLI's own verdict: `allowed`, `allowed_warning`, `rejected`. */
  status: string;
  /** True while the account is spending purchased overage rather than plan
   *  quota — the reset time then means something different to the user. */
  usingOverage?: boolean;
  /** When this verdict was observed (ms epoch). It ages: a window that has
   *  already reset must not keep being reported as current. */
  observedAt: number;
}

export interface StreamDelta {
  type:
    | "text"
    | "tool_use_start"
    | "tool_use_input"
    | "tool_use_end"
    | "tool_result"
    | "usage"
    | "rate_limit"
    | "model"
    | "permission_request"
    | "permission_resolved"
    | "compact"
    | "task"
    | "remote_control"
    | "done"
    | "error";
  text?: string;
  tool?: { id: string; name: string };
  partialInput?: string;
  error?: string;
  toolUseId?: string;
  resultContent?: string;
  resultIsError?: boolean;
  usage?: TokenUsage;
  /** Carried on `type: "compact"` — the CLI folded earlier messages away. */
  compaction?: CompactionInfo;
  /** Carried on `type: "task"` — one subagent moved through its lifecycle. */
  task?: SubagentUpdate;
  /** Carried on `type: "rate_limit"` — the CLI's own quota verdict for the
   *  turn in flight. */
  rateLimit?: RateLimitStatus;
  /** Resolved model id the CLI reports for the turn (e.g. an alias like
   *  `opus` resolving to `claude-opus-4-8`). Carried on `type: "model"`. */
  model?: string;
  /** Carried on `type: "permission_request"` — the CLI is asking the user to
   *  approve a tool call before it runs (the `can_use_tool` control request
   *  routed through `--permission-prompt-tool stdio`). */
  permission?: PermissionRequestPayload;
  /** Carried on `type: "permission_resolved"` — the request with this id was
   *  answered somewhere else (a connected phone or browser) and the CLI has
   *  withdrawn it. The card for it must go away; answering it now would write
   *  against an id the CLI has already forgotten. */
  requestId?: string;
  /** Carried on `type: "remote_control"` — the state of the bridge to
   *  claude.ai/code and the Claude mobile app. */
  remoteControl?: RemoteControlStatus;
}

/** Whether this conversation can currently be driven from another device.
 *
 * `state` mirrors the CLI's own `bridge_state` event, with `off` for "we never
 * asked". The URLs arrive with the reply to the request that turned it on and
 * are the same ones the CLI would print in a terminal. */
export interface RemoteControlStatus {
  state: "off" | "ready" | "connected" | "disconnected" | "error";
  /** The session on claude.ai/code — what a QR code encodes. */
  sessionUrl?: string;
  connectUrl?: string;
  /** Why the bridge failed, when `state` is "error". */
  error?: string;
}

/** A single approval the CLI suggests alongside a permission request — e.g.
 *  `{ type: "setMode", mode: "acceptEdits", destination: "session" }` meaning
 *  "you can stop being asked about edits for the rest of this session". */
export interface PermissionSuggestion {
  type: string;
  mode?: string;
  destination?: string;
  [k: string]: unknown;
}

/** A pending tool-permission prompt surfaced to the user. Mirrors the
 *  `can_use_tool` control request the Claude CLI emits over stream-json. */
export interface PermissionRequestPayload {
  /** CLI control-request id — echoed back in our control_response. */
  requestId: string;
  /** Tool the agent wants to run (Write, Edit, MultiEdit, Bash, …). */
  toolName: string;
  /** The assistant tool_use block this request corresponds to, so the UI can
   *  tie the prompt to the already-rendered tool card. */
  toolUseId?: string;
  /** Tool input the agent proposes — echoed back verbatim on "allow". */
  input: Record<string, unknown>;
  /** Short human label the CLI attaches (often the file basename). */
  description?: string;
  /** True when the call would irreversibly destroy data (delete files, wipe
   *  disks, force-push, pipe a remote script to a shell, …). Such calls always
   *  prompt — never auto-allowed, even in `auto` mode — and the card renders a
   *  hard warning. */
  destructive?: boolean;
  /** True when the call reaches the network or outside the workspace (curl,
   *  ssh, git push, web fetch, …). Always prompts, never auto-allowed (even if
   *  allow-listed); the card flags it as network/external access. */
  network?: boolean;
  /** Approval shortcuts the CLI offers (e.g. "accept edits this session"). */
  suggestions: PermissionSuggestion[];
}

/** How the user answered a permission prompt. */
export type PermissionBehavior = "allow" | "deny";

export interface TimelineEvent {
  id: string;
  ts: number;
  kind:
    | "user"
    | "assistant"
    | "tool_call"
    | "tool_result"
    | "approval"
    | "error"
    | "checkpoint"
    | "compact"
    | "subagent"
    | "plan_revision"
    | "plan_question"
    | "plan_comment"
    | "plan_answer";
  title: string;
  body?: string;
  meta?: Record<string, unknown>;
}

export interface PlanTaskFileRef {
  /** Workspace-relative path. */
  path: string;
  /** 1-based line number where the relevant slice starts. */
  startLine: number;
  /** 1-based line number where it ends (inclusive). */
  endLine: number;
  /** Optional caption shown on the step row. */
  label?: string;
}

export type PlanTaskStatus =
  "pending" | "in_progress" | "completed" | "skipped" | "accepted";

export interface PlanTask {
  id: string;
  content: string;
  activeForm: string;
  status: PlanTaskStatus;
  /** Optional file/range references parsed from the task body. */
  fileRefs?: PlanTaskFileRef[];
  /** True while the agent is paused waiting for the user to Accept / Modify / Skip. */
  blocked?: boolean;
}

export interface PlanRevisionMeta {
  revisionId: string;
  parentRevisionId?: string;
  toolUseId?: string;
  body: string;
  tasks: PlanTask[];
  /** False when only tasks changed (TodoWrite-only update). */
  bodyChanged: boolean;
  /** Path of the plan markdown file (e.g. ~/.claude/plans/foo.md) the CLI wrote, when the plan body came from a file rather than ExitPlanMode.input.plan. */
  planFilePath?: string;
  /** Parsed H2 sections from the plan body. Drives the completeness badge in
   *  PlanCard. Each value is the section's body text (may be empty if the
   *  heading exists with no content). Undefined means parsing wasn't run
   *  (e.g. plan from before this feature shipped). */
  sections?: PlanSections;
  /** Set when the user clicks "Proceed" — the revision is locked from further
   *  comments / step mutations / re-proceed until the user rewinds to this
   *  revision's checkpoint. */
  proceeded?: boolean;
  /** Permission mode the user was in just before clicking "Proceed". Restored
   *  on rewind so the user lands back where they started. */
  prePermissionMode?: PermissionMode;
}

/** Required sections in plan-mode.md, in the order the prompt mandates. */
export interface PlanSections {
  context?: string;
  approach?: string;
  conventions?: string;
  risks?: string;
  verification?: string;
}

export const REQUIRED_PLAN_SECTIONS: ReadonlyArray<keyof PlanSections> = [
  "context",
  "approach",
  "conventions",
  "risks",
  "verification"
] as const;

export interface PlanQuestionOption {
  label: string;
  description?: string;
}

export interface PlanQuestionEntry {
  question: string;
  header?: string;
  options: PlanQuestionOption[];
  multiSelect?: boolean;
}

export interface PlanQuestionMeta {
  questionId: string;
  toolUseId: string;
  revisionId?: string;
  questions: PlanQuestionEntry[];
}

export interface PlanCommentMeta {
  commentId: string;
  revisionId: string;
  /**
   * Either a real task id from the plan, "__general__" for whole-plan comments
   * left in the header dropdown, or "__inline__" for comments anchored to a
   * specific text passage via the selection-+ trigger in the modal body.
   */
  taskId: string;
  body: string;
  /**
   * For inline comments, the exact substring of the plan body the user
   * selected before clicking "+". Used to render a "quoting" preview next
   * to the comment and to highlight the passage in the document on render.
   */
  quote?: string;
  /** Set once a follow-up revision lands after the comment was submitted. */
  resolvedInRevisionId?: string;
  /** Soft-delete: the event stays in the timeline (rewind safety) but is
   * hidden in the UI and excluded from feedback resubmits. */
  deleted?: boolean;
  /** Last-edited timestamp (only set after at least one edit). */
  editedAt?: number;
  /** Threading: when set, this comment is a reply to another. */
  parentCommentId?: string;
  /** Manual resolve toggle (separate from the auto resolvedInRevisionId
   * which fires when a follow-up plan revision lands). */
  resolvedAt?: number;
}

export interface PlanAnswerMeta {
  questionId: string;
  /** Per-question answer keyed by question index. */
  answers: Array<{ choice: string; note?: string }>;
}
