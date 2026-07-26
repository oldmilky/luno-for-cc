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

export type PermissionMode = "default" | "auto" | "plan";

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

export interface HistoryEntry {
  id: string;
  title: string;
  /** Longer cleaned preview of the first user message; "" when redundant. */
  snippet?: string;
  createdAt: number;
  updatedAt: number;
  eventCount: number;
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
  | { type: "prompt"; text: string }
  | { type: "cancel" }
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
  | { type: "setEffort"; effort: EffortLevel }
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
  | { type: "requestSkills" }
  | { type: "requestFileSearch"; id: string; query: string }
  | { type: "captureSelection" }
  | { type: "requestHistory" }
  | { type: "loadSession"; id: string }
  | { type: "deleteHistoryEntry"; id: string }
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
    }
  | { type: "hello" }
  | { type: "reset" }
  | { type: "timeline"; event: TimelineEvent }
  | { type: "delta"; delta: Delta }
  | { type: "turnStart" }
  | { type: "turnEnd" }
  | { type: "permissionRequest"; request: PermissionRequestView }
  /** The host resolved/withdrew a pending prompt (e.g. turn cancelled) — clear
   *  the card if it's the one currently shown. */
  | { type: "permissionResolved"; requestId: string }
  | { type: "error"; message: string }
  | { type: "editorContext"; context: EditorContext | null }
  | { type: "rewind"; events: TimelineEvent[] }
  | { type: "models"; models: ModelInfo[] }
  /** Resolved model the CLI reported for the last turn, plus the alias/value
   *  that was selected when it ran (so the UI only shows it while that
   *  selection is still active). */
  | { type: "activeModel"; model: string; alias: string }
  | { type: "skills"; skills: SkillInfo[] }
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
  | { type: "loadedSession"; events: TimelineEvent[]; title: string }
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
      /** Authoritative limits from Anthropic's response headers, when available. */
      rateLimit?: RateLimitInfo;
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
  /** ms epoch when the 5-hour window began (first message of the burst). */
  startedAt: number;
  /** ms epoch when the window will reset (startedAt + 5h). */
  resetsAt: number;
}

export interface RateLimitBucket {
  limit?: number;
  remaining?: number;
  /** ms epoch when this bucket resets. */
  resetsAt?: number;
}

export interface RateLimitInfo {
  tokens: RateLimitBucket;
  inputTokens: RateLimitBucket;
  outputTokens: RateLimitBucket;
  requests: RateLimitBucket;
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
