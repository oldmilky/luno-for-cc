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
 * One per mode the CLI has and the official client offers, under LUNO's own
 * names: Ask, Edits, Plan, Agent, Bypass. The behaviour matches theirs; the
 * vocabulary does not, deliberately. See `mapPermissionMode` in
 * `providers/claude-cli.ts` for the translation, which is now a formality for
 * every mode but `default`.
 *
 * `bypass` is the one that turns the gate off entirely: the CLI approves
 * everything itself and never asks, so no approval card appears for anything —
 * including `rm`, `curl … | bash` and force-push. Enabling it requires an
 * explicit confirmation, and it is deliberately absent from the Shift+Tab
 * cycle: a mode that disables every safety check should not be two keystrokes
 * away by accident. The reference client does cycle through it; this is the one
 * place LUNO knowingly diverges.
 */
export type PermissionMode =
  "default" | "acceptEdits" | "plan" | "auto" | "bypass";

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
   * there is.
   *
   * The size is `input + cache_creation + cache_read + output` of the most
   * recent assistant message — one message is one request, and its reply is
   * already part of what the next one carries. Anthropic's own extension sums
   * the same four fields. Not the `result` event's usage: that is the turn's
   * running total across every request in it, and dividing it by the window
   * reported 173% of a million-token context.
   *
   * The window is what the CLI reports for the model that ran the main loop.
   * Both are the CLI's numbers, not estimates.
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
  /**
   * Which kind of background task this is — `local_agent` for a dispatched
   * subagent, `local_workflow` for a `Workflow` script, `remote_agent` for one
   * handed to the cloud. Absent on an older CLI, where subagents were the only
   * kind there was.
   *
   * Read before any other field. A workflow reuses this event shape and means
   * something different by half of it: `prompt` holds its entire script,
   * `last_tool_name` holds an agent's label rather than a tool, and there is no
   * `subagent_type` at all. Rendering one as a subagent misreports every one of
   * those.
   */
  taskType?: string;
  /** `meta.name` from the workflow script. `local_workflow` only. */
  workflowName?: string;
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
  /** Live phase-and-agent breakdown of a running workflow. `local_workflow`
   *  only, and only on `progress`. */
  workflowProgress?: WorkflowProgressEntry[];
}

/**
 * One row of a workflow's live progress, as the CLI already computes it.
 *
 * Passed through rather than remapped: the wire shape is what a progress view
 * wants. Every field but `type` is optional because phases and agents share one
 * array — `workflow_phase` carries `title`, `workflow_agent` carries the rest.
 */
export interface WorkflowProgressEntry {
  type: string;
  index?: number;
  /** Phase heading. `workflow_phase` only. */
  title?: string;
  /** What this agent was asked, in a few words. `workflow_agent` only. */
  label?: string;
  /** The head of the agent's prompt. Falls back for `label` when the script
   *  passed no explicit one. */
  promptPreview?: string;
  phaseIndex?: number;
  phaseTitle?: string;
  agentId?: string;
  model?: string;
  /** `start` while it runs, `done` once it answered. Left a free string for the
   *  same reason a task status is: the CLI adds values between releases. */
  state?: string;
  attempt?: number;
  /** Only once the agent finishes — a running one reports none, which is why
   *  a panel's token total reads the task's `usage` instead of summing these. */
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
  /** Epoch ms the agent began. With `durationMs` it reconstructs how many ran
   *  at once, which the CLI never states, and gives a running agent an elapsed
   *  time it otherwise has no field for. */
  startedAt?: number;
  /** Epoch ms it entered the queue. Earlier than `startedAt` whenever the
   *  concurrency cap made it wait. */
  queuedAt?: number;
  /** Epoch ms of its last progress record — the only signal separating a slow
   *  agent from a wedged one. */
  lastProgressAt?: number;
  /** The head of what the agent returned. `done` only. */
  resultPreview?: string;
}

/** Which `task_*` event this update came from. The host routes on it: two of
 *  the four belong on the timeline, the other two are live-only. */
export type SubagentPhase = "started" | "progress" | "updated" | "notification";

export interface SubagentUpdate extends SubagentTask {
  phase: SubagentPhase;
}

/**
 * Whether this task is a `Workflow` run rather than a dispatched subagent.
 *
 * Absent `taskType` reads as a subagent: that is what an older CLI meant by
 * saying nothing, and it is the safe way round — a workflow mislabelled as an
 * agent is a wrong card, an agent mislabelled as a workflow is a card with no
 * agent type and a script viewer over a prompt.
 */
export function isWorkflowTask(taskType: string | undefined): boolean {
  return taskType === "local_workflow";
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
    /** The CLI needs a decision that is not about a tool — see
     *  {@link UserDialogPayload}. Withdrawn through `user_dialog_resolved`,
     *  which the CLI sends the moment a new user message makes it moot. */
    | "user_dialog"
    | "user_dialog_resolved"
    | "compact"
    | "task"
    | "remote_control"
    | "remote_prompt"
    /** Our own steered message came back as an echo with no turn reading, so
     *  the CLI is opening a turn of its own to answer it. The host opens one
     *  here to receive it — the out-of-turn path keeps only `text`, which
     *  would drop every tool call the answer makes. Unlike `remote_prompt` the
     *  message is already on the timeline: it was recorded when it was sent. */
    | "steer_turn"
    | "done"
    | "error";
  text?: string;
  tool?: { id: string; name: string };
  partialInput?: string;
  error?: string;
  toolUseId?: string;
  resultContent?: string;
  resultIsError?: boolean;
  /** Carried on `type: "tool_result"` — the reason the CLI's auto-mode
   *  classifier refused the call, when it was the mode that stopped it rather
   *  than the tool that failed. The two are indistinguishable on the wire
   *  otherwise: a denial arrives as an ordinary failed result. */
  autoModeDenial?: string;
  usage?: TokenUsage;
  /** Carried on `type: "compact"` — the CLI folded earlier messages away. */
  compaction?: CompactionInfo;
  /** Carried on `type: "task"` — one subagent moved through its lifecycle. */
  task?: SubagentUpdate;
  /**
   * Carried on `type: "done"` — the CLI process itself is gone, not merely a
   * turn that finished.
   *
   * In session mode one process serves every turn, so `done` is pushed twice
   * for two entirely different reasons: at each `result`, and again on exit.
   * Reading them as the same event is what stamped `interrupted` on agents that
   * were still working — the turn the CLI opened to report a *finished* agent
   * ended, and its `done` was taken for the session dying.
   */
  sessionEnded?: boolean;
  /** Carried on `type: "rate_limit"` — the CLI's own quota verdict for the
   *  turn in flight. */
  rateLimit?: RateLimitStatus;
  /** Resolved model id the CLI reports for the turn (e.g. an alias like
   *  `opus` resolving to `claude-opus-4-8`). Carried on `type: "model"`. */
  model?: string;
  /** Carried on `type: "permission_request"` — the CLI is asking the user to
   *  approve a tool call before it runs (the `can_use_tool` control request
   *  routed through `--permission-prompt-tool stdio`). Carried again on
   *  `type: "permission_resolved"`, where it names the request that was
   *  withdrawn — the CLI's own cancel says only which id is gone. */
  permission?: PermissionRequestPayload;
  /** Carried on `type: "permission_resolved"` — the request with this id was
   *  answered somewhere else (a connected phone or browser) and the CLI has
   *  withdrawn it. The card for it must go away; answering it now would write
   *  against an id the CLI has already forgotten. Carried on
   *  `user_dialog_resolved` for the same reason. */
  requestId?: string;
  /** Carried on `type: "user_dialog"` — the CLI asking the person something
   *  that is not a tool call. */
  dialog?: UserDialogPayload;
  /** Carried on `type: "remote_control"` — the state of the bridge to
   *  claude.ai/code and the Claude mobile app. */
  remoteControl?: RemoteControlStatus;
  /** Carried on `type: "remote_prompt"` — a prompt typed on another surface
   *  (a connected phone or claude.ai/code) that the CLI replayed back to us.
   *  It starts a turn this panel did not send, and the text is what the user
   *  actually asked, preamble and all. */
  prompt?: string;
}

/** Whether this conversation can currently be driven from another device.
 *
 * `state` mirrors the CLI's own `bridge_state` event, with `off` for "we never
 * asked". The URLs arrive with the reply to the request that turned it on and
 * are the same ones the CLI would print in a terminal. */
export interface RemoteControlStatus {
  /** `connecting` is ours, not the CLI's: enabling reaches the Anthropic API
   *  and takes a moment, and the panel says so at once rather than sitting
   *  mute. It must not be `ready` — that one claims a bridge is up and waiting,
   *  with a link the reply has not delivered yet. */
  state:
    "off" | "connecting" | "ready" | "connected" | "disconnected" | "error";
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
/**
 * The dialog kinds LUNO is prepared to draw, and therefore the only ones it
 * declares on `initialize`.
 *
 * Declaring is a switch, not a shop window: the CLI sends a kind only to a
 * client that named it, and a named kind nothing renders parks the turn. So
 * this list may only ever grow alongside a card that answers it.
 */
export const SUPPORTED_DIALOG_KINDS = ["fable_overage_consent_prompt"] as const;

export type DialogKind = (typeof SUPPORTED_DIALOG_KINDS)[number];

/**
 * A `request_user_dialog` the CLI is blocked on. Not a permission: nothing is
 * about to run, the CLI simply cannot continue until the person decides.
 *
 * The answer is one of two shapes on the wire —
 * `{behavior:"completed", result}` or `{behavior:"cancelled"}` — and a result
 * the kind's own schema rejects is read as a cancel.
 */
export interface UserDialogPayload {
  /** CLI control-request id — echoed back in our control_response. */
  requestId: string;
  kind: DialogKind;
  /** Shape depends on the kind; the card that draws it owns the reading. */
  payload: Record<string, unknown>;
  toolUseId?: string;
}

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
  /**
   * `AskUserQuestion` only, and only when the user set a "Question
   * auto-continue timeout" in their Claude settings. Milliseconds after which
   * the card answers itself with whatever is selected and lets the turn
   * continue. Absent means no deadline, which is the CLI's own default.
   */
  afkTimeoutMs?: number;
  /** Set when a subagent raised this prompt rather than the main turn. The
   *  card says so: otherwise a background agent asking to write a file is
   *  indistinguishable from the conversation the user is watching. */
  agentId?: string;
  /**
   * What an "always allow" on this card would grant, already worded — e.g.
   * `Bash(bun run …)`. Absent when no standing grant is on offer: a
   * destructive or network call, or a shell command composed of several
   * commands, for which no single prefix describes what is being agreed to.
   *
   * Computed here rather than in the webview so the button cannot promise
   * something other than what gets stored.
   */
  grantLabel?: string;
  /**
   * Where an "always allow" on this card may be stored.
   *
   * `"luno"` is always here when `grantLabel` is. The three file scopes appear
   * only when the grant is eligible for one — a rule in a settings file means
   * the CLI stops asking us at all, so anything our own destructive/network
   * gate guards is offered LUNO-only. Absent entirely when no grant is on
   * offer at all.
   */
  grantScopes?: GrantScope[];
  /** Why the file scopes are missing, in words. The card says which case it is
   *  rather than leaving an option quietly absent. */
  grantScopeReason?: string;
}

/**
 * Where a standing grant is stored.
 *
 * `"luno"` is `globalState`, where our own gate still runs on every call. The
 * other three are the CLI's own settings files, where it does not: a rule there
 * means the CLI never asks us about the call again.
 *
 * There is deliberately no `managed` — an administrator's policy file is not a
 * target this extension has.
 */
export type GrantScope = "luno" | "project" | "local" | "user";

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
