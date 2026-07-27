// ─────────────────────────────────────────────────────────────
// Typed RPC layer between webview and the VS Code extension host.
// All messages flowing in either direction are enumerated here so
// every callsite gets full type-safety + autocomplete.
// ─────────────────────────────────────────────────────────────

declare function acquireVsCodeApi(): {
  postMessage: (msg: unknown) => void;
  getState: <T = unknown>() => T | undefined;
  setState: <T = unknown>(s: T) => void;
};

const vscode = acquireVsCodeApi();

// ── Domain types ──────────────────────────────────────────────

// Mirrors PermissionMode in src/core/types.ts. "bypass" turns the approval gate
// off entirely and is deliberately absent from the Shift+Tab cycle.
export type PermissionMode = "default" | "auto" | "plan" | "bypass";

/** Reasoning effort levels — mirror the CLI's `--effort` choices. */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface TimelineEvent {
  id: string;
  ts: number;
  kind:
    | "user"
    | "assistant"
    | "tool_call"
    | "tool_result"
    | "plan_revision"
    | "plan_question"
    | "plan_comment"
    | "plan_answer"
    | string;
  title: string;
  body?: string;
  meta?: Record<string, unknown>;
}

// ── Plan-mode payloads (mirror src/core/types.ts) ─────────────

export interface PlanTaskFileRef {
  path: string;
  startLine: number;
  endLine: number;
  label?: string;
}

export type PlanTaskStatus =
  "pending" | "in_progress" | "completed" | "skipped" | "accepted";

export interface PlanTask {
  id: string;
  content: string;
  activeForm: string;
  status: PlanTaskStatus;
  fileRefs?: PlanTaskFileRef[];
  blocked?: boolean;
}

export interface PlanRevisionMeta {
  revisionId: string;
  parentRevisionId?: string;
  toolUseId?: string;
  body: string;
  tasks: PlanTask[];
  bodyChanged: boolean;
  planFilePath?: string;
  sections?: PlanSections;
  proceeded?: boolean;
  prePermissionMode?: "default" | "plan" | "auto";
}

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

/** Display labels for missing-section badges, in the same order as
 *  REQUIRED_PLAN_SECTIONS. */
export const PLAN_SECTION_LABELS: Record<keyof PlanSections, string> = {
  context: "Context",
  approach: "Approach",
  conventions: "Conventions",
  risks: "Risks",
  verification: "Verification"
};

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
  taskId: string;
  body: string;
  quote?: string;
  resolvedInRevisionId?: string;
  deleted?: boolean;
  editedAt?: number;
  parentCommentId?: string;
  resolvedAt?: number;
}

export interface PlanAnswerMeta {
  questionId: string;
  answers: Array<{ choice: string; note?: string }>;
}

export type Delta =
  | { type: "text"; text: string }
  | { type: "tool_use_start"; tool: { id: string; name: string } }
  | { type: "tool_use_input"; text?: string }
  | { type: "tool_use_end" }
  | { type: "model"; model: string }
  | { type: "done" }
  | { type: "error"; error: string };

export interface EditorContext {
  file: string;
  language: string;
  selection: { startLine: number; endLine: number } | null;
}

export type ModelGroup = "alias" | "version";

export interface ModelInfo {
  value: string;
  label: string;
  note: string;
  supportsTools: boolean;
  /**
   * UI grouping. `alias` = Claude Code CLI shorthands (`opus`, `sonnet`, …),
   * `version` = explicit Messages API model IDs. See model-config docs.
   */
  group: ModelGroup;
  /** `version` rows only: one reason to pin it, one reason not to. */
  plus?: string;
  minus?: string;
  /** Levels this model accepts from `--effort`, in order; empty means it
   *  rejects the flag. Absent on aliases, which always resolve to something
   *  current. Mirrors `ModelInfo` in src/ui/domains/models.ts. */
  effort?: ReadonlyArray<EffortLevel>;
  /** Whether the user's own CLI served this id when asked. `undefined` while
   *  the probe is still working through the list. */
  available?: boolean;
}

export interface SkillInfo {
  id: string;
  name: string;
  category: "tool" | "skill" | "integration";
  description: string;
  enabled: boolean;
  toggleable: boolean;
  external?: boolean;
  /** "user" or "project" for filesystem-discovered skills. */
  source?: "user" | "project";
}

export interface FileSearchResult {
  path: string;
  name: string;
}

/** Mirrors `SlashCommand` in src/services/slash-commands.ts. Expansion is the
 *  CLI's own — this only drives the composer's popover. */
export interface SlashCommand {
  name: string;
  description?: string;
  source: "project" | "user" | "cli";
}

// ── Tool permission prompts ──────────────────────────────────
//
// When Luno runs in `default` (or `auto`) mode the CLI asks before each
// mutating tool call. The request is mirrored here and rendered as an inline
// approval card; the user's answer flows back as `permissionResponse`.

export interface PermissionSuggestion {
  /** e.g. "setMode" — the only kind we currently act on. */
  type: string;
  /** For setMode: the mode to switch to, e.g. "acceptEdits". */
  mode?: string;
  /** For setMode: scope, e.g. "session". */
  destination?: string;
}

export interface PermissionRequestView {
  /** CLI control-request id — passed back verbatim in the response. */
  requestId: string;
  /** Tool the agent wants to run (Write, Edit, MultiEdit, Bash, …). */
  toolName: string;
  /** Assistant tool_use id this prompt corresponds to. */
  toolUseId?: string;
  /** Proposed tool input — drives the diff / command preview. */
  input: Record<string, unknown>;
  /** Short label the CLI attaches (often the file basename). */
  description?: string;
  /** True for irreversible operations (file delete, force-push, disk wipe,
   *  remote-script-to-shell). The card renders a hard warning, defaults focus
   *  to Deny. */
  destructive?: boolean;
  /** True for network / external-access commands (curl, ssh, git push, web
   *  fetch). The card flags it as reaching outside the workspace. */
  network?: boolean;
  /** Approval shortcuts the CLI offers (drives the "allow this turn" button). */
  suggestions: PermissionSuggestion[];
}

// ── Marketplace ────────────────────────────────────────────

export interface MarketplaceSkill {
  id: string;
  name: string;
  /** "@author/repo/skill-name" — display + match key. */
  namespace: string;
  description: string;
  author: string;
  stars: number;
  installs: number;
  sourceUrl: string;
  repoOwner: string;
  repoName: string;
  directoryPath: string;
}

/** Subset needed to drive install. */
export interface MarketplaceInstallTarget {
  name: string;
  repoOwner: string;
  repoName: string;
  directoryPath: string;
}

/**
 * What state a chat is in. Mirrors `ChatStatus` in src/services/history.ts.
 *
 * The host picks exactly one — a running turn outranks however the last one
 * ended — so nothing here decides precedence. Four of these are read off a
 * stored timeline and hold for chats nobody has open.
 */
export type ChatStatus =
  "working" | "needs-you" | "no-reply" | "interrupted" | "failed" | "done";

export interface HistoryEntry {
  id: string;
  title: string;
  /** Whether `title` is a name the user typed rather than one derived from the
   *  first prompt. Lets a row offer to clear it instead of guessing. */
  named?: boolean;
  /** Longer cleaned preview of the first user message; "" when redundant. */
  snippet?: string;
  createdAt: number;
  updatedAt: number;
  eventCount: number;
  status: ChatStatus;
  /** A conversation currently holds this session. Orthogonal to `status` — a
   *  chat can be open and done, or closed and interrupted. */
  open: boolean;
}

// ── MCP connectors ────────────────────────────────────────

export interface ConnectorTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface ConnectorView {
  id: string;
  name: string;
  vendor: string;
  description: string;
  /** Remote endpoint. Absent for stdio connectors. */
  url?: string;
  transport: "streamable-http" | "sse" | "stdio";
  categories: string[];
  /** Icon name from our local design/icons.tsx registry. */
  icon: string;
  homepage?: string;
  builtIn: boolean;
  status: "connected" | "disconnected" | "error";
  connectedAt?: number;
  toolCount: number;
  tools?: ConnectorTool[];
  lastError?: string;
  /** stdio: the command line shown on the card. */
  command?: string;
  /** True for servers imported from Claude Code's own config (read-only). */
  managed?: boolean;
  /** For managed servers: which Claude Code scope they came from. */
  scope?: "user" | "project" | "local";
  /** True when this connector can only be set up through Claude Code (the
   *  vendor blocks third-party OAuth registration — e.g. Figma). */
  requiresClaudeCodeAuth?: boolean;
  /** Local preset that authenticates with an API token — prompt for this and
   *  connect via `connectorConnectWithApiKey`. */
  apiKeyEnv?: { key: string; label: string; hint?: string };
  /** True when the user authorized this through Claude Code's `/mcp` flow and
   *  `claude mcp list` reports it connected. Read-only, owned by Claude Code. */
  connectedViaClaudeCode?: boolean;
}

export interface CustomConnectorDraft {
  name: string;
  /** "remote" (http/sse via url) or "stdio" (local command). */
  kind?: "remote" | "stdio";
  url?: string;
  clientId?: string;
  clientSecret?: string;
  /** stdio: executable to spawn. */
  command?: string;
  /** stdio: arguments passed to the command. */
  args?: string[];
  /** stdio: extra environment variables. */
  env?: Record<string, string>;
}

// ── Outbound (webview → extension) ────────────────────────────

export type Outbound =
  | { type: "refreshAuth" }
  | { type: "refreshEditorContext" }
  /** Keyboard focus entered or left this chat. The host has no way to observe
   *  it — VS Code exposes no focus event for a webview — and turns it into the
   *  `luno.chatFocused` context key that chat keybindings are scoped to. */
  | { type: "chatFocus"; focused: boolean }
  /** Sending during a turn is allowed: the host queues the text and sends it
   *  when the turn ends. It never interrupts what is running. */
  | { type: "prompt"; text: string }
  | { type: "cancel" }
  /** The user dismissed the queued follow-up. Distinct from `cancel`, which
   *  hands the text back to the composer instead of discarding it. */
  | { type: "dropQueued" }
  | {
      type: "permissionResponse";
      requestId: string;
      behavior: "allow" | "deny";
      /** Allow + stop prompting for similar calls for the rest of this turn. */
      restOfTurn?: boolean;
    }
  | { type: "newSession" }
  | { type: "setModel"; model: string }
  | { type: "setPermissionMode"; mode: PermissionMode }
  /** Both halves of one choice. The picker offers ultracode as a sixth option
   *  on the effort control, so it must not be possible for a turn to start
   *  between the level landing and the flag landing. */
  | { type: "setEffort"; effort: EffortLevel; ultracode: boolean }
  | { type: "setThinking"; thinking: boolean }
  | { type: "rewindTo"; turnId: string }
  | { type: "editAt"; turnId: string; text: string; revertFiles: boolean }
  | { type: "openExternal"; url: string }
  | { type: "openFile"; path: string; startLine?: number; endLine?: number }
  | { type: "readAttachment"; id: string; path: string }
  | { type: "revertFile"; path: string }
  | { type: "refreshUsage" }
  | { type: "runTerminalCommand"; command: string }
  | { type: "claudeLogout" }
  | { type: "submitToken"; token: string }
  | { type: "startClaudeSetup" }
  | { type: "cancelClaudeSetup" }
  | { type: "confirmClaudeSetup" }
  | { type: "requestModels" }
  /** `probe: false` asks for the catalogue alone — used on boot when the
   *  conversation is already pinned to a version and the picker needs its
   *  effort ladder. Opening the panel asks with the probe, which costs one CLI
   *  spawn per entry and is why it is not the default on boot. */
  | { type: "requestLegacyModels"; probe?: boolean }
  | { type: "requestSkills" }
  | { type: "requestSlashCommands" }
  | { type: "requestFileSearch"; id: string; query: string }
  | { type: "captureSelection" }
  | { type: "requestHistory" }
  | { type: "loadSession"; id: string }
  | { type: "deleteHistoryEntry"; id: string }
  /** An empty `name` clears the name and falls back to the derived title. */
  | { type: "renameSession"; id: string; name: string }
  | { type: "setSkillEnabled"; id: string; enabled: boolean }
  | {
      type: "requestMarketplace";
      offset?: number;
      limit?: number;
      query?: string;
    }
  | { type: "requestSkillDetail"; name: string }
  | {
      type: "installMarketplaceSkill";
      target: MarketplaceInstallTarget;
      scope: "user" | "project";
    }
  | {
      type: "uninstallMarketplaceSkill";
      name: string;
      scope: "user" | "project";
    }
  | {
      type: "planComment";
      revisionId: string;
      taskId: string;
      body: string;
      quote?: string;
    }
  | { type: "planEditComment"; commentId: string; body: string }
  | { type: "planDeleteComment"; commentId: string }
  | {
      type: "planReplyComment";
      revisionId: string;
      parentCommentId: string;
      body: string;
    }
  | { type: "planResolveComment"; commentId: string }
  | { type: "planReopenComment"; commentId: string }
  | {
      type: "planOpenFileRef";
      path: string;
      startLine: number;
      endLine: number;
    }
  | { type: "planAcceptStep"; revisionId: string; taskId: string }
  | {
      type: "planModifyStep";
      revisionId: string;
      taskId: string;
      instruction: string;
    }
  | { type: "planSkipStep"; revisionId: string; taskId: string }
  | { type: "planOpenInEditor"; revisionId: string }
  | { type: "requestArtifactState"; revisionId: string }
  | { type: "planResubmit"; revisionId: string }
  | {
      type: "planAnswer";
      questionId: string;
      toolUseId: string;
      answers: Array<{ choice: string; note?: string }>;
    }
  | { type: "planRewindTo"; revisionId: string }
  | { type: "planProceedRequest"; revisionId: string }
  | { type: "dismissConventionsBanner" }
  | { type: "openConventionsFile"; path: string }
  | { type: "generateConventions" }
  | { type: "dismissSkillSuggestion"; skillId: string }
  | { type: "requestConnectors" }
  | { type: "connectorConnect"; id: string }
  | { type: "connectorCancelConnect"; id: string }
  | { type: "connectorDisconnect"; id: string }
  | { type: "connectorAddCustom"; draft: CustomConnectorDraft }
  | { type: "connectorRemoveCustom"; id: string }
  | { type: "connectorSetupViaClaudeCode"; id: string }
  | { type: "connectorConnectWithApiKey"; id: string; apiKey: string };

// ── Inbound (extension → webview) ─────────────────────────────

export type Inbound =
  | {
      type: "auth";
      authed: boolean;
      model?: string;
      permissionMode?: PermissionMode;
      effort?: EffortLevel;
      thinking?: boolean;
      /** xhigh + standing workflow orchestration. Travels with the posture
       *  rather than inside `effort`, which mirrors the CLI's five levels. */
      ultracode?: boolean;
    }
  // `sessionId` on all three: the webview persists it, and it is the only thing
  // VS Code hands back when it restores a conversation's editor tab after a
  // window reload. The host declared it on `hello` and `reset` all along — the
  // contract just never said so, so no reader could reach it.
  | { type: "hello"; sessionId: string }
  | { type: "reset"; sessionId: string }
  /** What this conversation is called and how the host reads its stored
   *  timeline — the same pair its editor tab fuses into a prefixed label, sent
   *  whenever either could have changed. `status` is the stored view only; the
   *  live states (`working`, `needs-you`) are the webview's own to know, and it
   *  knows them a message sooner than this could say. */
  | { type: "sessionMeta"; title: string; status: ChatStatus }
  | { type: "timeline"; event: TimelineEvent }
  | { type: "delta"; delta: Delta }
  | { type: "turnStart" }
  | { type: "turnEnd" }
  /** Everything typed while the turn runs, merged into the one message that
   *  goes out when it ends. `""` means the queue is empty — it arrives on a
   *  flush, a dismissal and a hand-back alike. */
  | { type: "queued"; text: string }
  /** The queue came back unsent — Stop, a rewind, an edit, or a turn that
   *  failed. The composer takes the text so nothing typed is lost. */
  | { type: "returnToComposer"; text: string }
  | { type: "permissionRequest"; request: PermissionRequestView }
  | { type: "error"; message: string }
  | { type: "editorContext"; context: EditorContext | null }
  | { type: "rewind"; events: TimelineEvent[] }
  | { type: "models"; models: ModelInfo[] }
  /** The pinned-version catalogue. Arrives twice per open: once immediately
   *  with whatever availability is already cached, once more when the probes
   *  have finished — so the panel paints before the CLI has been asked. */
  | { type: "legacyModels"; models: ModelInfo[] }
  /** Resolved model the CLI reported for the last turn, plus the alias/value
   *  that was selected when it ran (so the UI only shows it while that
   *  selection is still active). */
  | { type: "activeModel"; model: string; alias: string }
  | { type: "skills"; skills: SkillInfo[] }
  | { type: "slashCommands"; commands: SlashCommand[] }
  | { type: "tokenResult"; ok: boolean; error?: string }
  | {
      type: "setupProgress";
      /**
       * `launching` — child process spawned, waiting for first output
       * `awaitingBrowser` — URL detected and opened, waiting for OAuth callback
       * `saving` — token captured, persisting to SecretStorage
       * `done` — auth state already flipped to signed-in
       * `error` — terminal state; message is in `error`
       */
      stage: "launching" | "awaitingBrowser" | "saving" | "done" | "error";
      error?: string;
    }
  | { type: "fileSearchResults"; id: string; results: FileSearchResult[] }
  | {
      type: "attachmentData";
      id: string;
      path: string;
      dataUrl?: string;
      error?: string;
    }
  | {
      type: "insertSelection";
      file: string;
      language: string;
      startLine: number;
      endLine: number;
      text: string;
    }
  | { type: "historyList"; sessions: HistoryEntry[] }
  | {
      type: "loadedSession";
      events: TimelineEvent[];
      title: string;
      sessionId: string;
    }
  | {
      type: "marketplaceList";
      skills: MarketplaceSkill[];
      total: number;
      offset: number;
      limit: number;
    }
  | { type: "marketplaceError"; message: string }
  | {
      type: "skillDetail";
      /** Echoes the requested name so the modal can match its in-flight request. */
      name: string;
      skill?: MarketplaceSkill;
      /** Raw SKILL.md markdown (frontmatter stripped). Empty if unavailable. */
      content?: string;
      error?: string;
    }
  | {
      type: "marketplaceInstallResult";
      action: "install" | "uninstall";
      name: string;
      ok: boolean;
      scope: "user" | "project";
      installPath?: string;
      filesWritten?: number;
      error?: string;
    }
  | {
      type: "conventionsStatus";
      source: ConventionsSource | null;
      path: string | null;
      relativePath: string | null;
      hasAlternative: boolean;
    }
  | { type: "conventionsBanner" }
  | {
      type: "skillSuggestion";
      skillId: string;
      skillName: string;
      reason: string;
      taskType: string;
    }
  | {
      type: "tokenUsage";
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheCreatedTokens?: number;
      costUsd?: number;
      sessionId?: string;
      /** Provider that reported the usage — webview shows it in the meter tooltip. */
      source: "anthropic" | "claude-cli";
      /** How full the model's context was on the last request, and how big it
       *  is. Reported by the CLI, so unlike the plan caps these are exact. */
      contextTokens?: number;
      contextWindow?: number;
    }
  | { type: "revertResult"; path: string; ok: boolean; error?: string }
  | { type: "connectorsList"; connectors: ConnectorView[] }
  | { type: "openConnectors" }
  | {
      type: "connectorResult";
      action: "connect" | "disconnect" | "add" | "remove" | "cancel";
      id: string;
      ok: boolean;
      /** True when the failure was due to the user clicking Cancel. */
      cancelled?: boolean;
      error?: string;
      /** Updated view of the connector after a successful action. */
      connector?: ConnectorView;
    }
  | {
      type: "claudeCodeUsage";
      /** Authoritative usage aggregated from ~/.claude/projects/<cwd>/*.jsonl */
      session: SessionWindow;
      today: UsageTotals;
      week: UsageTotals;
      weekSonnet: UsageTotals;
      total: UsageTotals;
      generatedAt: number;
      available: boolean;
      /** Live quota verdicts the CLI reported, newest per window. Empty until
       *  a turn has run — the CLI is the only source for these. */
      limits: RateLimitStatus[];
    };

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreatedTokens: number;
  messages: number;
}

export interface SessionWindow {
  usage: UsageTotals;
  /** ms epoch when the 5-hour window began. */
  startedAt: number;
  /** ms epoch when the window will reset (startedAt + 5h). */
  resetsAt: number;
  /** True when the boundary came from the CLI rather than being inferred from
   *  message timestamps. Drives the Authoritative/Estimate badge. */
  authoritative?: boolean;
}

/** Mirrors `RateLimitStatus` in src/core/types.ts — the CLI's own verdict on
 *  which quota window is binding and when it resets. */
export interface RateLimitStatus {
  bucket: string;
  resetsAt: number;
  status: string;
  usingOverage?: boolean;
  observedAt: number;
}

export type ConventionsSource =
  | "claude-root"
  | "claude-dotfolder"
  | "agents"
  | "copilot"
  | "cursor"
  | "cline";

// ── API ───────────────────────────────────────────────────────

export function send(msg: Outbound): void {
  vscode.postMessage(msg);
}

export function onMessage(handler: (m: Inbound) => void): () => void {
  const fn = (e: MessageEvent) => handler(e.data as Inbound);
  window.addEventListener("message", fn);
  return () => window.removeEventListener("message", fn);
}

/**
 * Merge a slice into the persisted webview state.
 *
 * Deliberately the only writer: `setState` replaces the whole object, so
 * independent owners (the app shell persisting the timeline, the theme
 * store persisting the palette) would clobber each other if they set it
 * wholesale.
 */
export function patchState<T extends object>(patch: T): void {
  vscode.setState({ ...(vscode.getState<object>() ?? {}), ...patch });
}

export function loadState<T>(): T | undefined {
  return vscode.getState<T>();
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 11);
}
