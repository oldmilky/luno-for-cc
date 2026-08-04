import {
  log as logInfo,
  warn as logWarn,
  error as logError
} from "../services/logger.js";
import * as vscode from "vscode";
import * as path from "node:path";
import { Session } from "../core/session.js";
import { Orchestrator } from "../core/orchestrator.js";
import { DeltaQueue } from "../core/delta-queue.js";
import {
  isTerminalTaskStatus,
  isWorkflowTask,
  PermissionMode,
  PermissionBehavior,
  GrantScope,
  PermissionRequestPayload,
  RemoteControlStatus,
  StreamDelta,
  SubagentUpdate
} from "../core/types.js";
import type { ChatProvider } from "../providers/base.js";
import { createProvider } from "../providers/factory.js";
import {
  claudePreferences,
  disabledPermissionModes,
  modelPolicy
} from "../services/claude-settings.js";
import {
  readPermissionRules,
  unreadableRuleSources
} from "../services/permission-sources.js";
import {
  availableFileScopes,
  writeAllowRule
} from "../services/permission-writer.js";
import { grantFileEligibility, grantToCliRule } from "../core/grant-rules.js";
import { answersFromApproval } from "../core/permission-policy.js";
import type { NotifyTrigger } from "../core/notify.js";
import { additionalDirectories } from "../core/workspace-dirs.js";
import { permittedModel } from "../core/model-allowlist.js";
import { raiseNotification } from "./domains/notify.js";
import { VoiceSession } from "./domains/voice.js";
import { keytermsFrom } from "../core/voice/protocol.js";
import type { ClaudeCliProvider } from "../providers/claude-cli.js";
import type { PendingSetting } from "../providers/cli/options.js";
import type { EffortLevel } from "../core/effort.js";
import {
  CheckpointService,
  checkpointStoreDir
} from "../services/checkpoint.js";
import {
  deriveStatus,
  deriveTitle,
  HistoryService,
  type StoredSession
} from "../services/history.js";
import { PlanDecorationService } from "../services/plan-decorations.js";
import { PlanArtifactManager } from "./plan-artifact-panel.js";
import { buildWebviewHtml } from "./webview-html.js";
import {
  asStringArray,
  cleanSelection,
  compactionSummary,
  forkName,
  stripUndefined,
  subagentTitle,
  worktreeName
} from "./conversation-format.js";
import { extractInlineImages } from "./prompt-attachments.js";
import {
  arr,
  bool,
  num,
  obj,
  oneOf,
  str,
  type HandlerTable,
  type InboundType,
  type Post,
  type RawMessage
} from "./messages.js";
import { broadcastUsage } from "./domains/usage.js";
import {
  SessionStore,
  type ConversationSettings
} from "./domains/session-store.js";
import { applyPermissionMode } from "./domains/permission-modes.js";
import { toggleRemoteControl } from "./domains/remote-control.js";
import { nextCycleMode } from "../core/permission-cycle.js";
import { AuthManager } from "./domains/auth.js";
import { PlanHandlers } from "./domains/plan-handlers.js";
import { runInSetupTerminal } from "./domains/terminal.js";
import {
  broadcastEditorContext,
  openFile,
  openPlanFileRef,
  readAttachment,
  revertFile,
  saveDirtyEditors,
  searchFiles
} from "./domains/files.js";
import { capturedRun, capturedRuns } from "./domains/terminal-capture.js";
import { expandTerminalMentions } from "../core/terminal-output.js";
import { grantFor, grantLabel } from "../core/tool-grants.js";
import {
  broadcastGrants,
  grantTool,
  readGrants,
  revokeAllTools,
  revokeTool
} from "./domains/tool-grants.js";
import { collectDiagnostics } from "./domains/diagnostics.js";
import { collectEditorContext } from "./domains/editor-context.js";
import {
  broadcastSlashCommands,
  rememberCliCommands
} from "./domains/slash-commands.js";
import {
  broadcastHistory,
  deleteHistoryEntry,
  type LiveState
} from "./domains/history.js";
import { ModelResolver } from "./domains/models.js";
import {
  broadcastSkills,
  disabledSkillIds,
  dismissSuggestion,
  installMarketplaceSkill,
  requestMarketplace,
  requestSkillDetail,
  setSkillEnabled,
  suggestSkill,
  uninstallMarketplaceSkill
} from "./domains/skills.js";
import {
  addCustomConnector,
  broadcastConnectors,
  cancelConnectorConnect,
  connectConnector,
  connectConnectorWithApiKey,
  disconnectConnector,
  refreshManagedAndRebroadcast,
  removeCustomConnector,
  setupConnectorViaClaudeCode,
  type CustomDraft
} from "./domains/connectors.js";
import { loadConventions, ConventionsFile } from "../services/conventions.js";
import {
  createWorktree,
  removeWorktree,
  repoRoot,
  type Worktree
} from "../services/worktree.js";
import { classifyTask } from "../core/task-classifier.js";
import type { RateLimitTracker } from "../services/rate-limit.js";
import type { InstallTarget } from "../services/marketplace.js";
// Only what the turn path still needs: the connector *handlers* live in
// `domains/connectors.ts`, but a turn has to hand the CLI an MCP config file
// built from whatever is currently connected.
import { writeCliMcpConfig } from "../services/mcp/index.js";

/**
 * Services that exist once per extension, not once per conversation.
 *
 * The split is not cosmetic. `history` is a file store, `decorations` paints the
 * one editor everybody shares, and `models` and `auth` describe the single CLI
 * install and the single credential behind it — none of them mean anything
 * per-conversation, and duplicating them would give five chats five model
 * probes and five sign-in flows.
 */
export interface SharedServices {
  ctx: vscode.ExtensionContext;
  history: HistoryService;
  decorations: PlanDecorationService;
  models: ModelResolver;
  auth: AuthManager;
  /**
   * The conversation already showing `sessionId`, if one is open.
   *
   * A host asks before adopting a stored session so it can hand over instead of
   * opening a second view onto the same chat. Two hosts on one session would
   * resume the same CLI session from two processes and interleave their
   * timelines into one history file.
   */
  conversationFor(sessionId: string): ConversationHost | undefined;
  /** Open a stored conversation as an editor tab. The explicit "new tab"
   *  command; picking a chat from history switches in place instead. */
  openConversationInTab(sessionId: string): void;
  /**
   * Show a stored conversation on the surface the caller is on.
   *
   * Switching, not replacing: the conversation being left keeps its turn, its
   * checkpoints and its process, and is reachable again from history. This is
   * what a chat picker is expected to do — the earlier behaviour of opening an
   * editor tab moved the work somewhere the user had not asked for.
   */
  showConversation(sessionId: string): void;
  /**
   * Start a new chat on the surface `host` is on.
   *
   * The registry decides whether that means clearing this conversation or
   * taking a fresh one alongside it, because only the registry knows what the
   * surface can do. A conversation with work in it is never cleared in place:
   * `newSession` aborts the turn and releases the CLI process, and a
   * `run_in_background` workflow dies with it — measured, a 19m52s audit lost
   * two agents at 15:08:28 to exactly this, one blank chat later.
   */
  startNewConversation(host: ConversationHost): void;
  /**
   * End the conversation showing `sessionId`, if one is open.
   *
   * Its history entry is being deleted. Left running it would rewrite that file
   * on its next debounced save — the delete would simply undo itself — and it
   * would keep a CLI process alive for a chat the user believes is gone.
   */
  discardConversation(sessionId: string): void;
  /** Note which conversation the user is working in, so a keybinding lands on
   *  the chat in front of them rather than an arbitrary one. */
  /** The account's quota verdicts as the CLI reports them. Shared because the
   *  quota is per account: what one conversation learns applies to all. */
  rateLimits: RateLimitTracker;
  markActive(host: ConversationHost): void;
  /** A conversation now wants — or no longer wants — the user. Lets the
   *  registry keep one badge for every chat that is off screen. */
  attentionChanged(): void;
  /**
   * A chat webview gained or lost keyboard focus.
   *
   * VS Code offers no focus event for a webview, so the webview reports its
   * own. This is what backs the `luno.chatFocused` context key, and without it
   * every keybinding scoped to the chat can never match.
   */
  focusChanged(host: ConversationHost, focused: boolean): void;
  /** Post to every open conversation. For facts that belong to the account or
   *  the machine rather than to one chat — the standing grants are global, so
   *  revoking one in a tab has to empty the list in the sidebar too. */
  broadcast(msg: unknown): void;
}

/**
 * The surface a conversation renders into.
 *
 * Deliberately not `vscode.WebviewView`: the sidebar hands over a view and an
 * editor tab hands over a `WebviewPanel`, and the only things this needs from
 * either are the webview to post through and a way to bring itself forward.
 */
export interface HostTarget {
  webview: vscode.Webview;
  reveal(): void;
  /** Rename the surface. Only an editor tab can — the sidebar's title is the
   *  view's, and VS Code owns it. */
  setTitle?(title: string): void;
  /** Close the surface. Again only a tab: the sidebar is a fixed surface whose
   *  occupant changes, and it has no way to close itself. */
  close?(): void;
}

export interface AttachOptions {
  /**
   * Adopt the most recently updated stored session instead of starting empty.
   *
   * True for the sidebar only. Without it a window reload would give the user's
   * one chat a new session id and split it across history entries. A new tab
   * must not do this: it would open a second view onto a conversation that is
   * already on screen, and two hosts resuming one CLI session is the process
   * contention this whole design exists to avoid.
   */
  resumeLastConversation?: boolean;
  /**
   * Open this stored conversation instead of an empty one.
   *
   * Passed through `attach` rather than called afterwards so the adoption lands
   * before the boot chain replays the timeline. Posting into a webview that has
   * only just been handed its HTML races its message listener — the artifact
   * panels carry a `requestArtifactState` handshake for exactly that reason.
   */
  adoptSessionId?: string;
  /**
   * Give this conversation its own git worktree.
   *
   * Off for the sidebar: that is the chat working on the files the user has
   * open, and edits landing in a checkout they cannot see would be worse than
   * the collisions isolation prevents.
   */
  isolate?: boolean;
}

/**
 * One conversation: its session, checkpoints, resume id, in-flight turn, and the
 * webview it talks to. Everything here used to be fields on the panel provider,
 * which is why there could only ever be one chat — switching sessions had to
 * kill the running turn because there was nowhere else to put it.
 *
 * Nothing in this class knows other conversations exist. That is what keeps the
 * webview protocol untouched: a webview hosts exactly one of these and therefore
 * only ever receives its own messages.
 */
export class ConversationHost {
  private target?: HostTarget;
  private orchestrator?: Orchestrator;
  /** The provider running the current turn. Held so the `permissionResponse`
   *  message can route the user's allow/deny back to the live CLI process. */
  private activeProvider?: ChatProvider;
  /**
   * The provider kept alive between turns while Remote Control is on.
   *
   * Everywhere else a provider is built per turn and thrown away, which is
   * what makes per-turn options simple. The bridge cannot live that way — it
   * ends with its process — so this one persists and is handed the turn's
   * options through `updateOptions()` instead of being rebuilt.
   */
  /** The conversation's own CLI process, alive across turns. Built by
   *  `ensureSessionProvider` on the first turn and released only when the
   *  conversation is — see `dispose`. */
  private sessionProvider: ClaudeCliProvider | null = null;

  /** The spawn in flight, so two sends cannot start two `claude` processes.
   *  See `ensureSessionProvider`. */
  private sessionProviderStarting: Promise<ClaudeCliProvider> | null = null;
  private remoteControl: RemoteControlStatus = { state: "off" };
  /** Where a turn started on another device is being fed from. Present only
   *  while such a turn runs — it is also what tells the out-of-turn reader that
   *  the deltas arriving now belong to something on the timeline. */
  private remoteTurn?: DeltaQueue;
  // In-flight turn; awaited before starting a new one so turns never overlap.
  private activeTurn?: Promise<void>;
  /** Owns the current session, its timeline listeners, debounced persistence,
   *  checkpoints and the CLI resume id. Four fields and six methods used to
   *  live on this class. */
  private readonly sessions: SessionStore;
  /** The fourteen plan-review actions. They could not move until the session
   *  store existed — see the note at the bottom of `plan-state.ts`. */
  private readonly plan: PlanHandlers;
  /** Plan artifacts open as editor tabs and mirror this conversation's plan, so
   *  they belong to it rather than to the extension. */
  private readonly artifacts: PlanArtifactManager;
  /** Whether this conversation gets its own checkout. Cleared when isolation
   *  turns out to be impossible, so it is asked for once rather than per turn. */
  private isolate = false;
  /** Isolation was asked for and could not be given — no repository, or `git
   *  worktree add` failed. Remembered so moving between surfaces cannot retry
   *  it, and re-report it, every time the user switches chats. */
  private isolationImpossible = false;
  /** Whether the user can currently see this conversation. A hidden one still
   *  runs — that is the whole point — so it has to be able to say it needs
   *  attention without being on screen. */
  private visible = true;
  /** A turn parked on an approval holds a live CLI process and will sit there
   *  forever. Invisible, that reads as a chat that simply stopped. */
  private awaitingApproval = false;
  private finishedWhileHidden = false;
  /** When the running turn began, for the one notification that depends on how
   *  long it took. Zero between turns. */
  private turnStartedAt = 0;
  /**
   * Subagents dispatched this turn that have not reported a terminal status,
   * keyed by CLI task id.
   *
   * Kept because `task_updated` identifies its task by id alone — it carries no
   * `tool_use_id` — so the card it belongs to is only findable through what
   * `task_started` said. Cleared when a task ends and swept at turn end: the
   * CLI process dies with the turn, so anything still open at that point is
   * dead rather than slow, and a card left spinning would claim otherwise.
   */
  private readonly liveTasks = new Map<string, SubagentUpdate>();
  /**
   * Tasks the CLI has itself reported a terminal status for.
   *
   * A `task_progress` can land *after* the `task_notification` that ended a
   * task — measured, 1.4s after, in the run behind the ten-minute-cutoff audit.
   * Any phase but `notification` puts its task back into `liveTasks`, so that
   * one late event resurrected a finished workflow and the turn-end sweep then
   * filed it `interrupted`. That fabricated status is what the card showed,
   * over the `stopped` the CLI had actually reported a second earlier.
   *
   * Only a status the CLI reported gets an entry here. A card closed by the
   * sweep does not, so a late notification can still heal one — measured, an
   * agent closed yellow at 38.6s and reopened green at 107.6s.
   */
  /** Controls whose value the running process has not been told, because
   *  telling it means replacing the process and the conversation has agents in
   *  it. Cleared by the provider the moment a fresh process is spawned. */
  private pendingSettings: PendingSetting[] = [];
  private readonly reportedTasks = new Set<string>();
  /** Identity of every task seen this conversation: the fields that arrive once
   *  on `task_started` and never again. Kept past the end of the card so a late
   *  event cannot degrade a workflow's row to a bare "Agent". */
  private readonly taskIdentity = new Map<string, SubagentUpdate>();
  /** Text the model produced with no turn running — see the `text` branch in
   *  `onOutOfTurn`. Buffered because it arrives as a stream of fragments and
   *  only reads as a message once. */
  private outOfTurnText = "";
  /** Enough of the live turn to rebuild it on a surface that was showing
   *  another conversation while it happened. */
  private busy = false;
  private streamed = "";
  private pendingRequest?: unknown;
  /** Every approval this turn has asked for, by id. Read only when the user
   *  answers with "always", and cleared with the turn. */
  private readonly askedPermissions = new Map<
    string,
    PermissionRequestPayload
  >();
  /**
  /** Whether the turn in flight has already reported a failure. */
  private turnFailed = false;
  /** The posture this conversation runs in. Born from the `luno.*` defaults,
   *  then owned here and saved with the session. */
  private settings: ConversationSettings = defaultSettings();
  private worktree?: Worktree;
  /** The repository the worktree belongs to — needed to remove it later, and
   *  not the same path as the worktree itself. */
  private repo?: string;

  // Delegating accessors for the shared services. Reading them through `shared`
  // at each of the ~58 call sites would have been the same change spelled out
  // fifty-eight times; this keeps the extraction reviewable as a move.
  private get ctx(): vscode.ExtensionContext {
    return this.shared.ctx;
  }
  private get history(): HistoryService {
    return this.shared.history;
  }
  private get decorations(): PlanDecorationService {
    return this.shared.decorations;
  }
  private get models(): ModelResolver {
    return this.shared.models;
  }
  private get auth(): AuthManager {
    return this.shared.auth;
  }

  // Delegating accessors. The state moved into the store; the ~90 call sites
  // that read it did not, which keeps this change small enough to verify. They
  // migrate to `this.sessions.*` as the surrounding code is touched anyway.
  private get session(): Session {
    return this.sessions.current;
  }
  private get checkpoints(): CheckpointService | undefined {
    return this.sessions.checkpoints;
  }
  private get resumeId(): string | undefined {
    return this.sessions.resumeId;
  }
  private set resumeId(value: string | undefined) {
    this.sessions.resumeId = value;
  }
  private scheduleSave(): void {
    this.sessions.scheduleSave();
  }
  constructor(private readonly shared: SharedServices) {
    this.artifacts = new PlanArtifactManager(shared.ctx);
    // After history and decorations: the store wires session events straight
    // into both, so it cannot be built before they exist.
    this.sessions = new SessionStore(
      this.post,
      this.history,
      this.decorations,
      () => this.settings
    );
    this.plan = new PlanHandlers({
      post: this.post,
      sessions: this.sessions,
      artifacts: this.artifacts,
      // Several plan actions continue the conversation rather than only
      // editing state — accepting a step prompts the agent to do it.
      startPrompt: (text) => this.handlePrompt(text),
      refreshAuth: () => this.auth.broadcast()
    });
    // Artifact panels share the chat panel's RPC handler so any user action
    // (comment, accept, reply, …) reaches the same session no matter which
    // surface fired it.
    this.artifacts.setMessageHandler((msg) => this.onMessage(msg));
    this.sessions.reset();
  }

  /**
   * Drop what this conversation owns.
   *
   * Not registered on `ctx.subscriptions`: a host can outlive a webview and a
   * closed tab must not wait for extension shutdown to release its CLI process.
   * The registry decides when a conversation is over.
   */
  /**
   * Dictation for this conversation, while it is running.
   *
   * Per conversation rather than per window: two chats open at once are two
   * composers, and a transcript belongs to the one whose button was pressed.
   */
  private voice: VoiceSession | null = null;

  private async startVoice(): Promise<void> {
    if (this.voice?.active) return;
    const root = await this.ensureWorkingRoot();
    this.voice = new VoiceSession({
      post: this.post,
      extensionPath: this.ctx.extensionPath,
      workspaceRoot: root,
      keyterms: keytermsFrom({
        folder: root ? path.basename(root) : undefined,
        branch: this.worktree?.branch
      })
    });
    await this.voice.start();
  }

  dispose(): void {
    // A microphone left open on a closed tab is the one leak a user can hear.
    this.voice?.stop();
    this.abortTurn();
    // `abortTurn` interrupts the turn; it deliberately leaves the process
    // alive, which is the whole point of a session that outlives a turn. Here
    // the conversation itself is over, so the process has to go with it — and
    // it has to happen even when no turn was running, which is the common case
    // for a tab closed between turns.
    this.releaseSessionProvider();
    this.artifacts.closeAll();
    this.sessions.dispose();
    // Nothing may be posted after this: the webview behind a closed tab is
    // gone, and a retired conversation that still holds its surface would post
    // into it — which is reachable now that deleting a chat retires the
    // conversation showing it and then refreshes the list.
    this.target = undefined;
  }

  /**
   * Signing out invalidates the credential every turn is running on, so the
   * in-flight turn dies with it and the resume id stops meaning anything.
   * Called by the registry for each live conversation.
   */
  abandonTurnOnSignOut(): void {
    this.abortTurn();
    this.releaseSessionProvider();
    this.orchestrator = undefined;
    this.resumeId = undefined;
  }

  /** The conversation this host is currently showing. */
  get sessionId(): string {
    return this.session.id;
  }

  /**
   * Where this conversation's files live, creating its isolated checkout on
   * first use.
   *
   * Lazy for the same reason checkpoints are: a chat that is opened and never
   * prompted should not leave a checkout behind. Returns the folder VS Code has
   * open when this conversation is not isolated, and undefined when there is no
   * folder at all.
   */
  /** The tree as it stands, without creating one. Used by anything that only
   *  needs to resolve a path — opening a file must not conjure a checkout. */
  private get workingRoot(): string | undefined {
    return (
      this.worktree?.path ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    );
  }

  private async ensureWorkingRoot(): Promise<string | undefined> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder || !this.isolate) return folder;
    if (this.worktree) return this.worktree.path;

    const root = await repoRoot(folder);
    if (!root) {
      this.isolate = false;
      this.isolationImpossible = true;
      this.post({
        type: "error",
        message:
          "This folder is not a git repository, so this chat shares the " +
          "working tree with the others. Edits and rewinds can collide."
      });
      return folder;
    }
    try {
      this.worktree = await createWorktree(root, worktreeName(this.session.id));
      this.repo = root;
      this.refreshSurface();
      return this.worktree.path;
    } catch (err) {
      // Isolation was asked for and could not be given. Saying so and running
      // anyway beats refusing to answer, but it must not be silent — the whole
      // point of the mode is that the user believes their chats cannot collide.
      this.isolate = false;
      this.isolationImpossible = true;
      const message = err instanceof Error ? err.message : String(err);
      this.post({
        type: "error",
        message: `Couldn't create an isolated worktree (${message}). This chat shares the working tree.`
      });
      return folder;
    }
  }

  /**
   * Give the conversation's checkout back, keeping it when that would destroy
   * work. Called when the conversation is closed, since a headless CLI run has
   * no exit prompt of its own to do it.
   */
  async releaseWorktree(): Promise<void> {
    if (!this.worktree || !this.repo) return;
    const tree = this.worktree;
    this.worktree = undefined;
    const result = await removeWorktree(this.repo, tree).catch(
      (err: unknown) => ({
        removed: false,
        reason: err instanceof Error ? err.message : String(err)
      })
    );
    if (!result.removed) {
      void vscode.window.showInformationMessage(
        `Luno kept ${tree.path} on branch ${tree.branch} because ${result.reason}.`
      );
    }
  }

  /**
   * What this conversation needs from the user, for a surface that can only
   * show a glyph.
   *
   * `approval` outranks `finished`: one is a turn that cannot continue until
   * someone answers, the other is an answer waiting to be read.
   */
  get attention(): "none" | "approval" | "finished" {
    if (this.awaitingApproval) return "approval";
    if (this.finishedWhileHidden) return "finished";
    return "none";
  }

  /**
   * What this conversation is doing right now, or nothing when it is merely
   * sitting there — then the state derived from its timeline stands.
   *
   * Distinct from `attention`, which answers "does a surface need a glyph". A
   * chat the user is looking at is never *waiting* for their eye but can very
   * much be waiting for their answer, and the list has to say so either way.
   */
  get live(): LiveState {
    if (this.awaitingApproval) return { status: "needs-you" };
    if (this.busy) return { status: "working" };
    // The turn is over and the work is not. Its own state rather than `working`
    // because nothing is streaming and nobody is being waited on — and because
    // this is precisely the row the user is looking for in the list, which
    // would otherwise read `done` while twenty agents run.
    if (this.liveTasks.size > 0) return { status: "agents" };
    return {};
  }

  /** The name the user gave this conversation, or nothing. */
  get name(): string | undefined {
    return this.sessions.name;
  }

  /**
   * Name this conversation, or clear the name back to the derived title.
   *
   * Persisted immediately rather than on the next turn: a chat named and then
   * left alone is the normal case — the user names it precisely so they can
   * walk away from it.
   */
  setName(name: string | undefined): void {
    this.sessions.name = name && name.length > 0 ? name : undefined;
    this.refreshSurface();
    this.scheduleSave();
  }

  /**
   * What to call this conversation on a surface and in the list.
   *
   * A user-given name wins over the derived one; nothing derivable yet reads
   * as a new chat rather than as an empty title.
   */
  private conversationTitle(): string {
    return this.name || deriveTitle(this.session.timeline) || "New chat";
  }

  /**
   * Close the surface this conversation is on, if it can be closed.
   *
   * A tab can; the sidebar cannot close itself — it is a fixed surface whose
   * occupant changes. Returns whether anything happened so the caller can pick
   * the other ending.
   */
  closeSurface(): boolean {
    if (!this.target?.close) return false;
    this.target.close();
    return true;
  }

  /**
   * Watch what goes out, so a conversation can be rebuilt on a surface it was
   * not attached to when it happened.
   *
   * Switching the sidebar to another chat leaves this one running with nowhere
   * to post. Its timeline keeps filling, but the text streaming *between* two
   * timeline events lives only in the messages themselves — come back mid-turn
   * without this and the answer is invisible until the next flush.
   */
  private rememberLiveState(msg: unknown): void {
    const m = msg as {
      type?: string;
      delta?: { type?: string; text?: string };
    };
    if (m.type === "turnStart") {
      this.busy = true;
      this.streamed = "";
      this.turnFailed = false;
    } else if (m.type === "error") {
      this.turnFailed = true;
    } else if (m.type === "turnEnd") {
      this.busy = false;
      this.streamed = "";
      this.pendingRequest = undefined;
      this.askedPermissions.clear();
    } else if (m.type === "delta" && m.delta?.type === "text") {
      this.streamed += m.delta.text ?? "";
    } else if (m.type === "timeline") {
      // The orchestrator flushes streamed text into a real event before any
      // tool call, so the buffer's job ends exactly where the webview's does.
      const kind = (msg as { event?: { kind?: string } }).event?.kind;
      if (kind === "assistant" || kind === "tool_call") this.streamed = "";
    } else if (m.type === "permissionRequest") {
      const request = (msg as { request?: unknown }).request;
      this.pendingRequest = request;
      // Kept by id as well, because "always allow" has to derive the grant
      // from what the CLI actually asked for. Taking the webview's word for
      // what it was showing would make the panel the authority on what it is
      // being granted, and parallel tool calls mean the newest request is not
      // necessarily the one being answered.
      const asked = request as PermissionRequestPayload | undefined;
      if (asked?.requestId) this.askedPermissions.set(asked.requestId, asked);
    } else if (m.type === "permissionResolved") {
      // Matched by id: a withdrawn request must not take a *different* prompt
      // off the surface with it. Answering the phone's question while another
      // card waits here is an ordinary thing to do.
      const gone = (msg as { requestId?: string }).requestId;
      const held = (this.pendingRequest as { requestId?: string } | undefined)
        ?.requestId;
      if (gone && gone === held) this.pendingRequest = undefined;
    }
  }

  /** Whether this conversation holds anything worth not losing — a running
   *  turn, or messages already exchanged. */
  get hasWork(): boolean {
    return this.activeTurn !== undefined || this.session.timeline.length > 0;
  }

  /**
   * Whether something is running in this conversation *right now*.
   *
   * Distinct from `hasWork`, which is true of any chat that has ever said
   * anything. This one decides whether a conversation may be cleared in place:
   * a turn — including one parked on an approval, which is how the measured
   * incident sat for 11 minutes — or a background agent nobody has heard back
   * from. Both die with the CLI process, and neither is recoverable.
   */
  get hasLiveWork(): boolean {
    return this.activeTurn !== undefined || this.liveTasks.size > 0;
  }

  /** Whether some surface is currently showing this conversation. */
  get hasSurface(): boolean {
    return this.target !== undefined;
  }

  /**
   * Ask for — or drop — an isolated checkout, before the conversation resolves
   * where its files live.
   *
   * The surface decides, so both `attach` and `show` go through here. `attach`
   * alone used to set it, which meant a conversation switched onto the sidebar
   * was never asked: under `luno.worktree: "always"` a chat picked from history
   * quietly ran in the folder the editor has open, which is the one thing that
   * mode exists to prevent.
   *
   * A conversation that already has a checkout keeps it — dropping isolation
   * underneath it would leave its files somewhere nothing else resolves against.
   */
  private setIsolation(isolate: boolean): void {
    if (this.worktree || this.isolationImpossible) return;
    this.isolate = isolate;
  }

  /** Stop rendering: the surface is about to show a different conversation.
   *  The turn, if any, carries on. */
  hide(): void {
    this.target = undefined;
    this.visible = false;
  }

  /**
   * Take over a surface that was showing something else, and rebuild what the
   * user would have seen had they never left: the conversation, its posture,
   * whether a turn is running, the text streamed so far, and an approval still
   * waiting for an answer.
   *
   * Posts straight to the webview rather than through `post`, which exists to
   * *record* this state — replaying it through there would fold the restore
   * back into the buffer it came from.
   */
  show(target: HostTarget, opts: { isolate?: boolean } = {}): void {
    this.target = target;
    this.setIsolation(opts.isolate === true);
    this.visible = true;
    this.finishedWhileHidden = false;
    const webview = target.webview;
    void webview.postMessage({
      type: "loadedSession",
      events: this.session.timeline,
      title: this.session.title,
      sessionId: this.session.id
    });
    void this.publishAuthState();
    if (this.busy) void webview.postMessage({ type: "turnStart" });
    if (this.streamed) {
      void webview.postMessage({
        type: "delta",
        delta: { type: "text", text: this.streamed }
      });
    }
    if (this.pendingRequest) {
      void webview.postMessage({
        type: "permissionRequest",
        request: this.pendingRequest
      });
    }
    // The live half of every card this conversation still has open. The surface
    // just cleared what the previous occupant left there, and these outlive a
    // turn now — without this, switching back to a chat running a workflow
    // showed a card with a title and nothing moving in it.
    for (const task of this.liveTasks.values()) {
      void webview.postMessage({ type: "subagentProgress", task });
    }
    // Including `off`, and that is the whole point: the pill's state lives in
    // `ChatScreen`, which the sidebar swap does not remount, so a conversation
    // with no bridge inherits the previous occupant's pill — a live-looking
    // link to somebody else's session. Saying "off" is what clears it.
    void webview.postMessage({
      type: "remoteControl",
      status: this.remoteControl
    });
    this.refreshSurface();
  }

  /**
   * The model this conversation may actually use.
   *
   * Filtering the picker is not enough on its own. A model pinned in settings
   * can become disallowed between sessions — an administrator adds
   * `availableModels` and what is already stored is not on it. Running it
   * anyway would be the same override the picker filter exists to prevent, so
   * it falls back rather than quietly persisting.
   */
  private get effectiveModel(): string {
    const policy = modelPolicy(this.workingRoot);
    return (
      permittedModel(
        this.settings.model,
        policy.availableModels,
        policy.enforceAvailableModels
      ) ?? this.settings.model
    );
  }

  /**
   * The argv-shaped options that come from settings rather than from the turn.
   *
   * Gathered in one place so every spawn gets the same set: a conversation
   * whose process is replaced mid-flight must come back with the folders and
   * the fallbacks it had, or the agent quietly loses sight of half the window.
   */
  private extraCliOptions(root: string | undefined) {
    const config = vscode.workspace.getConfiguration("luno");
    return {
      additionalDirectories: additionalDirectories({
        cwd: root,
        workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(
          (f) => f.uri.fsPath
        ),
        configured: config.get<string[]>("additionalDirectories", []),
        isolated: this.isolate
      }),
      fallbackModels: config.get<string[]>("fallbackModels", []),
      maxBudgetUsd: config.get<number>("maxBudgetUsd", 0),
      safeMode: config.get<boolean>("safeMode", false),
      sessionName: this.session.title
    };
  }

  /**
   * Raise a banner for something this conversation needs, if the rule and the
   * user's switches allow one.
   *
   * The badge is not decided here — every trigger raises it, through
   * `refreshSurface`. This is only the loud channel.
   */
  private notify(trigger: NotifyTrigger): void {
    const turnMs =
      trigger === "turnFinished" && this.turnStartedAt > 0
        ? Date.now() - this.turnStartedAt
        : undefined;
    if (trigger === "turnFinished") this.turnStartedAt = 0;
    raiseNotification(
      {
        trigger,
        visible: this.visible,
        turnMs,
        // Named, because a person with several chats open needs to know which
        // one is asking before deciding whether to leave what they are doing.
        title: this.session.title
      },
      () => this.reveal()
    );
  }

  /** Told by the surface when the user can or cannot see this conversation. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    // Seeing it is reading it. An approval still stands, because it needs an
    // answer rather than an eye.
    if (visible) this.finishedWhileHidden = false;
    this.refreshSurface();
  }

  /**
   * Re-label the surface: the conversation's own title, prefixed by whatever it
   * needs from the user.
   *
   * A leading glyph rather than a coloured dot because VS Code exposes no
   * per-tab badge — `iconPath` is a static image and the title is the only part
   * a tab will render on demand.
   */
  private refreshSurface(): void {
    const title = this.conversationTitle();
    const prefix =
      this.attention === "approval"
        ? "⚠ "
        : this.attention === "finished"
          ? "● "
          : "";
    // An isolated conversation says so in its own title: its edits land on that
    // branch and nowhere the user's open files can show them, which is the one
    // thing about this mode that surprises people.
    const branch = this.worktree ? ` · ${this.worktree.branch}` : "";
    this.target?.setTitle?.(`${prefix}${title}${branch}`);
    // The panel's own header names the conversation too, and this is the one
    // place that already runs whenever the name or the attention could have
    // moved. Posting from here is what keeps the tab and the header from
    // drifting into two different answers.
    this.post({
      type: "sessionMeta",
      title,
      status: deriveStatus(this.session.timeline)
    });
    this.shared.attentionChanged();
  }

  /** Read by the registry to paint editor decorations for whichever
   *  conversation is in front. */
  get timeline() {
    return this.session.timeline;
  }

  /** Deliver a message the registry published to every conversation — auth
   *  state, the model list, usage. Per-conversation traffic does not come
   *  through here; it is posted directly by the code that produced it. */
  receiveBroadcast(msg: unknown): void {
    this.post(msg);
  }

  /**
   * Bind this conversation to a surface and boot it.
   *
   * Takes a `HostTarget` rather than a `WebviewView` so the same path serves an
   * editor tab, whose `WebviewPanel` shares only the webview and a way to come
   * forward.
   */
  attach(target: HostTarget, opts: AttachOptions = {}) {
    this.target = target;
    this.setIsolation(opts.isolate === true);
    const view = target;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.ctx.extensionUri, "webview", "dist")
      ]
    };
    view.webview.html = this.html(view.webview);
    this.post({ type: "hello", sessionId: this.session.id });
    this.publishWebviewSettings();
    void this.broadcastAuthState();
    const booted = opts.adoptSessionId
      ? this.adoptStored(opts.adoptSessionId)
      : opts.resumeLastConversation
        ? this.restoreLatestSession()
        : Promise.resolve();
    void booted.then(() => {
      // Again, and only now with the id this conversation settled on: the
      // `hello` above went out before adoption, carrying the empty session this
      // host was born with. The webview persists whatever id it last heard, and
      // that is what VS Code hands back when it restores this surface — so the
      // stale one would restore a session that was never saved.
      this.post({ type: "hello", sessionId: this.session.id });
      this.replayTimeline();
      // A reopened conversation has a title the moment it is adopted, so the
      // surface should not sit on its placeholder until the next turn.
      this.refreshSurface();
      // Again, after the boot chain: the first publish above went out with the
      // posture this host was born with, and adopting a stored conversation
      // replaces it with the one that conversation ran in. Without this the
      // composer shows the defaults while the turn would use something else.
      void this.publishAuthState();
      void broadcastUsage(this.post, this.shared.rateLimits);
      // The bridge outlives the surface: reloading the panel must not make a
      // conversation the user's phone is connected to look disconnected.
      if (this.remoteControl.state !== "off") {
        this.post({ type: "remoteControl", status: this.remoteControl });
      }
    });
  }

  /** Aggregate authoritative usage from Claude Code's per-workspace JSONL
   *  files and push it to the webview. No-op if no workspace is open. */

  /**
   * On startup, list saved sessions and adopt the most recently updated one
   * as the current session. The user can still click "New Chat" to start a
   * fresh one explicitly.
   */
  /** Adopt one named stored conversation. Best-effort like the restore below:
   *  a missing file leaves the empty session this host was born with. */
  async adoptStored(id: string): Promise<void> {
    const stored = await this.history.load(id);
    if (!stored) return;
    // A process spawned for the conversation being replaced holds that one, and
    // holds it in its own memory where `--resume` cannot reach. Usually a no-op:
    // adopting happens at boot, before any turn has spawned anything.
    this.releaseSessionProvider();
    this.sessions.adopt(stored);
    this.applyStoredSettings(stored);
    this.armCheckpoints();
  }

  /**
   * Load this session's snapshots without waiting for a prompt.
   *
   * Rewind and per-file revert are offered the moment a restored chat renders,
   * and they read the checkpoint service. Armed only on the first prompt, both
   * reported "no snapshot" for a conversation whose snapshots were sitting on
   * disk the whole time.
   *
   * Uses the root already known rather than resolving one: creating a worktree
   * here would do it for every chat a reload brings back. If this conversation
   * later moves into its own tree, `ensureCheckpoints` rebuilds against it.
   */
  private armCheckpoints(): void {
    const root = this.workingRoot;
    if (!root) return;
    this.sessions.ensureCheckpoints(
      root,
      checkpointStoreDir(this.ctx.globalStorageUri.fsPath)
    );
  }

  private async restoreLatestSession(): Promise<void> {
    // Only restore if our in-memory session is still empty — otherwise we'd
    // clobber a user that's already typing. (Ordinarily the constructor's
    // fresh session is empty until the first prompt.)
    if (this.session.timeline.length > 0) return;
    try {
      const list = await this.history.list();
      if (list.length === 0) return;
      // Sorted by updatedAt desc — but a restored editor tab picks its own
      // conversation back up during the same startup, and that may well be the
      // most recent one. Adopting it here too would put two hosts on one
      // session, which resumes the same CLI session from two processes. So the
      // sidebar takes the newest chat nobody else is already holding.
      const latest = list.find((e) => !this.shared.conversationFor(e.id));
      if (!latest) return;
      const stored = await this.history.load(latest.id);
      // Require real user content — never re-adopt an empty / placeholder
      // session (e.g. one rewound down to empty), which would resurrect a
      // chat the user just cleared.
      if (!stored || !stored.timeline.some((e) => e.kind === "user")) return;

      this.releaseSessionProvider();
      this.sessions.adopt(stored);
      this.applyStoredSettings(stored);
      this.armCheckpoints();
    } catch {
      // Restore is best-effort; on any failure we fall through to the
      // empty session created by the constructor.
    }
  }

  /**
   * Publish this conversation's auth message: whether a turn can run, plus the
   * posture the composer renders from.
   *
   * `auth` owns the first half and every conversation shares it; the second
   * half belongs to this conversation alone, which is why the message is
   * composed here rather than inside the shared service.
   */
  async publishAuthState(): Promise<void> {
    this.post({
      type: "auth",
      authed: await this.auth.isAuthed(),
      ...this.settings,
      // Rides with the posture it contradicts: these are the controls showing a
      // value the running process has not been given, because giving it would
      // have meant replacing the process under live agents.
      pendingSettings: this.pendingSettings,
      // Read fresh rather than cached: the file is the user's own, they can
      // edit it while the panel is open, and this is published often enough
      // that a stale answer would outlive its reason.
      disabledModes: disabledPermissionModes() as PermissionMode[]
    });
  }

  /** Re-derive credential state and have every conversation republish. Used
   *  when the credential itself may have changed, not when only this
   *  conversation's posture did. */
  async broadcastAuthState() {
    await this.auth.broadcast();
  }

  /** Shift+Tab. Walks the cycle for this conversation only — the other chats
   *  keep the posture they were left in. */
  async cycleMode(): Promise<void> {
    await this.applySetting(
      "permissionMode",
      nextCycleMode(this.settings.permissionMode)
    );
  }

  /**
   * Change one setting for this conversation, then republish and persist.
   *
   * Persisting matters: the posture is part of the conversation now, so
   * reopening it from history has to bring it back rather than reset to the
   * workspace default.
   */
  private async applySetting<K extends keyof ConversationSettings>(
    key: K,
    value: ConversationSettings[K]
  ): Promise<void> {
    this.settings = { ...this.settings, [key]: value };
    await this.publishAuthState();
    this.scheduleSave();
  }

  /** Restore the posture a stored conversation ran in, falling back to the
   *  current defaults for sessions written before it was recorded. */
  private applyStoredSettings(stored: StoredSession): void {
    const fallback = defaultSettings();
    this.settings = {
      model: stored.model ?? fallback.model,
      permissionMode: stored.permissionMode ?? fallback.permissionMode,
      effort: stored.effort ?? fallback.effort,
      thinking: stored.thinking ?? fallback.thinking,
      ultracode: stored.ultracode ?? fallback.ultracode
    };
  }

  reveal() {
    this.target?.reveal();
  }

  /** Reveal the chat panel and instruct the webview to open the Connectors modal. */
  openConnectors() {
    this.reveal();
    this.post({ type: "openConnectors" });
    // Best-effort: also push the current list so the modal opens with data.
    broadcastConnectors(this.post, this.ctx);
  }

  newSession() {
    this.artifacts.closeAll();
    // Cleared, not returned: the follow-up belonged to the conversation being
    // left behind, and a blank chat is the one place it would read as noise.
    // `reset` covers the session, the resume id and the checkpoints together.
    // They were three separate statements here, and forgetting one is how a
    // "new" chat inherits the old one's rewind history.
    this.sessions.reset();
    this.abortTurn();
    this.releaseSessionProvider();
    this.orchestrator = undefined;
    this.post({ type: "reset", sessionId: this.session.id });
  }

  async sendUserMessage(text: string) {
    this.reveal();
    await this.handlePrompt(text);
  }

  /**
   * Turn "always allow" on a card into a standing grant.
   *
   * The call is looked up by id rather than taken from the message: the panel
   * says *which* approval it answered, and the host decides what that approval
   * was for. A destructive or network call is refused outright — the card does
   * not offer the button for one, and this is the half that has to hold if the
   * message arrives anyway.
   */
  private async grantFromRequest(
    requestId: string,
    scope: GrantScope
  ): Promise<void> {
    const asked = this.askedPermissions.get(requestId);
    if (!asked || asked.destructive || asked.network) return;
    const grant = grantFor(asked.toolName, asked.input);
    if (!grant) return;

    // A file scope is re-checked here, whatever the panel asked for. The picker
    // chooses; it does not decide. Anything our own gate would stop falls back
    // to LUNO's own storage, where that gate still runs on every call.
    const rule = scope === "luno" ? null : grantToCliRule(grant);
    if (rule && grantFileEligibility(grant).eligible) {
      try {
        const { file, added, warning } = await writeAllowRule(
          scope,
          this.workingRoot,
          rule
        );
        logInfo(
          `[luno] ${added ? "wrote" : "already present"}: ${rule} → ${file}`
        );
        // A rule the CLI will ignore has to be said out loud. Silently it
        // reads as a permission granted, and the user is asked for it again
        // on the very next call with nothing explaining why.
        if (warning) this.post({ type: "error", message: warning });
        // Not also stored in `globalState`: two copies of one permission is
        // two places to revoke it from, and only one of them would work.
        return;
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        logWarn(`[luno] could not write ${rule}: ${why}`);
        this.post({
          type: "error",
          message: `The permission was kept in LUNO instead: ${why}`
        });
      }
    }

    const grants = await grantTool(this.ctx, grant);
    logInfo(`[luno] standing grant added: ${grantLabel(grant)}`);
    this.shared.broadcast({ type: "toolGrants", grants });
  }

  /**
   * Tell the card where an "always allow" on it could go.
   *
   * Computed here rather than in the provider: which scopes exist depends on
   * the workspace and on our own storage, neither of which the CLI bridge
   * knows about — and the eligibility rule imports that bridge, so asking it
   * from inside would be a cycle.
   */
  private withGrantScopes(
    request: PermissionRequestPayload
  ): PermissionRequestPayload {
    if (!request.grantLabel) return request;
    const grant = grantFor(request.toolName, request.input);
    if (!grant) return request;

    const verdict = grantFileEligibility(grant);
    if (!verdict.eligible) {
      return {
        ...request,
        grantScopes: ["luno"],
        grantScopeReason: verdict.reason
      };
    }
    return {
      ...request,
      grantScopes: ["luno", ...availableFileScopes(this.workingRoot)]
    };
  }

  /** Put text in the composer without sending it. The way in from outside the
   *  editor — a `vscode://` link — and deliberately the whole of what such a
   *  link can do. */
  prefillComposer(text: string) {
    this.reveal();
    this.post({ type: "prefillComposer", text });
  }

  /** The settings the webview acts on itself. Sent on attach and on every
   *  change, because a setting that needs a window reload to take effect is
   *  one the user reports as broken. */
  publishWebviewSettings(): void {
    const cfg = vscode.workspace.getConfiguration("luno");
    this.post({
      type: "settings",
      useCtrlEnterToSend: cfg.get<boolean>("useCtrlEnterToSend", false),
      // Hand-edited JSON reaches this unvalidated — the schema in package.json
      // is a hint to the editor, not a guarantee about what arrives here.
      startupSuggestions: asStringArray(
        cfg.get<unknown>("startupSuggestions", [])
      )
    });
  }

  /**
   * Right-click → "Luno: Comment on selection". Anchors a plan_comment
   * to the active editor's current selection on the latest plan revision.
   * The comment carries `quote` = the selected text so the existing
   * highlight + jump-to-passage flow lights up in the chat panel.
   */
  commentOnEditorSelection() {
    const ed = vscode.window.activeTextEditor;
    if (!ed) {
      vscode.window.showInformationMessage("Luno: open a file first.");
      return;
    }
    const sel = ed.selection;
    if (sel.isEmpty) {
      vscode.window.showInformationMessage("Luno: select some code first.");
      return;
    }
    const latest = [...this.session.timeline]
      .reverse()
      .find((e) => e.kind === "plan_revision");
    if (!latest) {
      vscode.window.showInformationMessage(
        "Luno: no active plan to comment on. Run a /plan turn first."
      );
      return;
    }
    const revisionId =
      (latest.meta as { revisionId?: string }).revisionId ?? "";
    const quote = ed.document.getText(sel);
    void vscode.window
      .showInputBox({
        prompt: "Comment on selection",
        placeHolder: "Leave a comment for the agent…"
      })
      .then((body) => {
        if (!body || !body.trim()) return;
        this.plan.handlePlanComment(revisionId, "__inline__", body, quote);
        this.reveal();
      });
  }

  /**
   * Cmd+U: pull the active editor's selection (or current line if no
   * selection) and surface it inside the composer as a clean attachment.
   * Strips stray slash prefixes and other formatting artifacts.
   */
  sendSelectionToChat() {
    const ed = vscode.window.activeTextEditor;
    if (!ed) {
      vscode.window.showInformationMessage("Luno: open a file first.");
      return;
    }
    const sel = ed.selection;
    const range = sel.isEmpty ? ed.document.lineAt(sel.active.line).range : sel;
    const raw = ed.document.getText(range);
    const cleaned = cleanSelection(raw);
    if (!cleaned) {
      vscode.window.showInformationMessage("Luno: selection is empty.");
      return;
    }
    this.reveal();
    this.post({
      type: "insertSelection",
      file: vscode.workspace.asRelativePath(ed.document.uri),
      language: ed.document.languageId,
      startLine: range.start.line + 1,
      endLine: range.end.line + 1,
      text: cleaned
    });
  }

  private replayTimeline() {
    for (const e of this.session.timeline)
      this.post({ type: "timeline", event: e });
    this.decorations.syncFromTimeline(this.session.timeline);
  }

  /** Interrupt the in-flight turn. Cancels the orchestrator loop AND kills the
   *  live CLI process. The kill matters while a permission prompt has the turn
   *  paused — no deltas are flowing to trip the orchestrator's cancel check, so
   *  without it the Stop button (and rewind/edit/new-session) would hang on the
   *  blocked child. */
  private abortTurn(): void {
    logInfo("[luno] aborting turn (cancel/rewind/new-session)");
    this.orchestrator?.cancel();
    this.activeProvider?.cancel?.();
    // A remote turn has no generator to return from — it ends when its source
    // says so. Closing the queue is what lets Stop end it at all: the interrupt
    // above stops the CLI, but a session that never reports the `result` would
    // otherwise leave the panel busy forever.
    this.remoteTurn?.close();
  }

  /**
   * Every message the host accepts, one entry each.
   *
   * Typed as `HandlerTable` — `Record<InboundType, Handler>` — so leaving a
   * message type out is a compile error. The `switch` this replaced had no
   * `default`, which meant an unhandled or misspelled type fell off the end and
   * did nothing, with no error and no log.
   *
   * A field arriving in the wrong shape drops the message and says so. The
   * webview is ours, so that is a bug to see rather than an exception to raise
   * inside the extension host.
   */
  private readonly handlers: HandlerTable = {
    // ── Chat + turn lifecycle ──────────────────────────────────
    prompt: async (m) => {
      await this.handlePrompt(String(m.text ?? ""));
    },
    cancel: () => this.abortTurn(),
    // Through the registry, never straight to `newSession`: this button used to
    // clear the conversation in place, which aborts its turn and kills the CLI
    // process a background workflow is living in.
    newSession: () => this.shared.startNewConversation(this),
    permissionResponse: async (m) => {
      const requestId = str(m, "requestId");
      const behavior = oneOf(m, "behavior", ["allow", "deny"] as const);
      if (!requestId || !behavior) return;
      this.awaitingApproval = false;
      this.refreshSurface();
      if (behavior === "allow" && m.always === true) {
        await this.grantFromRequest(
          requestId,
          oneOf(m, "alwaysScope", [
            "luno",
            "project",
            "local",
            "user"
          ] as const) ?? "luno"
        );
      }
      // Between turns `activeProvider` is empty, and a prompt raised by a
      // background agent is answered exactly then. The session provider is the
      // same process either way — falling back to it is what makes the card
      // answerable rather than decorative.
      const provider = this.activeProvider ?? this.sessionProvider;
      if (!provider?.respondToPermission) {
        logWarn(
          "[luno] permissionResponse arrived but no provider to answer it"
        );
      }
      // Forwarded, never reshaped: `updatedInput` is the CLI's schema, not
      // ours, and a host that rebuilds it is a second place to get it wrong.
      const updatedInput = obj(m, "updatedInput");
      const reason = str(m, "reason");
      provider?.respondToPermission?.(
        requestId,
        behavior as PermissionBehavior,
        {
          restOfTurn: m.restOfTurn === true,
          ...(updatedInput && { updatedInput }),
          ...(reason && { reason })
        }
      );
      const asked = this.askedPermissions.get(requestId);
      const answers = answersFromApproval(
        behavior as PermissionBehavior,
        asked?.toolName,
        updatedInput
      );
      if (answers)
        this.plan.recordAnswerFromTool(asked?.toolUseId ?? "", answers);
    },
    userDialogResponse: async (m) => {
      const requestId = str(m, "requestId");
      if (!requestId) return;
      this.awaitingApproval = false;
      this.refreshSurface();
      // `result` absent is a cancel, and every kind defaults to one — so a
      // panel that closes the card without choosing still frees the turn.
      this.activeProvider?.respondToDialog?.(requestId, m.result);
    },
    rewindTo: async (m) => {
      const turnId = str(m, "turnId");
      if (turnId) await this.rewindTo(turnId);
    },
    editAt: async (m) => {
      const turnId = str(m, "turnId");
      const text = str(m, "text");
      if (turnId && text !== undefined) {
        await this.editAt(turnId, text, m.revertFiles === true);
      }
    },

    // ── Auth + setup ───────────────────────────────────────────
    refreshAuth: () => this.auth.broadcast(),
    claudeLogout: () => this.auth.logout(),
    submitToken: async (m) => {
      const token = str(m, "token");
      if (token) await this.auth.submitToken(token);
    },
    startClaudeSetup: () => this.auth.startSetup(),
    cancelClaudeSetup: () => this.auth.cancelSetup(),
    confirmClaudeSetup: () => this.auth.confirmSetup(),
    runTerminalCommand: (m) => {
      const command = str(m, "command");
      if (command) runInSetupTerminal(command);
    },

    // ── Settings ───────────────────────────────────────────────
    setModel: async (m) => {
      const model = str(m, "model");
      if (!model) return;
      await this.applySetting("model", model);
      // Same reason as the mode below: a turn arriving from the phone rebuilds
      // no argv, so without this the CLI keeps answering under the model the
      // picker stopped naming.
      void this.sessionProvider?.setLiveModel(model);
    },
    setPermissionMode: async (m) => {
      const mode = str(m, "mode");
      if (!mode) return;
      await applyPermissionMode(mode, {
        apply: (next) => this.applySetting("permissionMode", next),
        republish: () => this.auth.broadcast(),
        pushLive: (next) =>
          void this.sessionProvider?.setLivePermissionMode(next)
      });
    },
    setEffort: async (m) => {
      const effort = str(m, "effort");
      if (!effort) return;
      // Both in one message on purpose: ultracode *is* an effort choice from
      // the picker's side, and sending them separately would let a turn start
      // between the two halves under a posture nobody picked.
      const ultracode = bool(m, "ultracode");
      this.settings = {
        ...this.settings,
        effort: effort as EffortLevel,
        ultracode: ultracode ?? false
      };
      await this.publishAuthState();
      this.scheduleSave();
    },
    setThinking: async (m) => {
      const thinking = bool(m, "thinking");
      if (thinking !== undefined) {
        await this.applySetting("thinking", thinking);
      }
    },
    toggleRemoteControl: async (m) => {
      await toggleRemoteControl(bool(m, "enabled") ?? false, {
        liveProvider: () => this.sessionProvider,
        ensureProvider: () => this.ensureSessionProvider(),
        publish: (status) => this.publishRemoteControl(status),
        title: this.session.title
      });
    },

    // ── Editor + files ─────────────────────────────────────────
    openExternal: async (m) => {
      const url = str(m, "url");
      if (url) await vscode.env.openExternal(vscode.Uri.parse(url));
    },
    openFile: async (m) => {
      const path = str(m, "path");
      if (path) {
        await openFile(
          this.post,
          path,
          num(m, "startLine") ?? 0,
          num(m, "endLine") ?? 0,
          this.workingRoot
        );
      }
    },
    readAttachment: async (m) => {
      const id = str(m, "id");
      const path = str(m, "path");
      if (id && path) await readAttachment(this.post, id, path);
    },
    revertFile: async (m) => {
      const path = str(m, "path");
      if (path) {
        await revertFile(this.post, this.checkpoints, path, this.workingRoot);
      }
    },
    requestFileSearch: async (m) => {
      await searchFiles(
        this.post,
        String(m.query ?? ""),
        str(m, "id") ?? "",
        this.workingRoot
      );
    },
    requestToolGrants: () => broadcastGrants(this.post, readGrants(this.ctx)),
    requestPermissionRules: () => {
      // Scoped to this conversation's own root, which for a worktree chat is
      // the worktree — the same checkout the CLI reads `.claude/settings.json`
      // from, so the answer is what is in force for *this* conversation.
      const { rules, unreadable } = readPermissionRules(this.workingRoot);
      this.post({
        type: "permissionRules",
        rules,
        unreadable,
        cannotRead: unreadableRuleSources()
      });
    },
    revokeToolGrant: async (m) => {
      const key = str(m, "key");
      if (!key) return;
      const grants =
        key === "*"
          ? await revokeAllTools(this.ctx)
          : await revokeTool(this.ctx, key);
      this.shared.broadcast({ type: "toolGrants", grants });
    },
    requestTerminals: (m) => {
      this.post({
        type: "terminalList",
        id: str(m, "id") ?? "",
        terminals: capturedRuns().map(({ output: _output, ...view }) => view)
      });
    },
    captureSelection: () => this.sendSelectionToChat(),
    voiceStart: () => this.startVoice(),
    voiceStop: () => this.voice?.stop(),
    refreshEditorContext: () => broadcastEditorContext(this.post),
    chatFocus: (m) => {
      const focused = bool(m, "focused");
      if (focused === undefined) return;
      this.shared.focusChanged(this, focused);
    },

    // ── Models ─────────────────────────────────────────────────
    requestModels: () => this.models.broadcast(),
    requestLegacyModels: (m) => this.models.broadcastLegacy(m.probe !== false),

    // ── Skills + marketplace ───────────────────────────────────
    requestSkills: () => broadcastSkills(this.post, this.ctx),
    requestSlashCommands: () =>
      broadcastSlashCommands(this.post, this.ctx, this.workingRoot),
    setSkillEnabled: async (m) => {
      const id = str(m, "id");
      const enabled = bool(m, "enabled");
      if (id && enabled !== undefined)
        await setSkillEnabled(this.post, this.ctx, id, enabled);
    },
    requestMarketplace: async (m) => {
      await requestMarketplace(
        this.post,
        num(m, "offset") ?? 0,
        num(m, "limit") ?? 24,
        str(m, "query")
      );
    },
    requestSkillDetail: async (m) => {
      const name = str(m, "name");
      if (name) await requestSkillDetail(this.post, name);
    },
    installMarketplaceSkill: async (m) => {
      const target = obj(m, "target");
      const scope = oneOf(m, "scope", ["user", "project"] as const);
      if (target && scope) {
        await installMarketplaceSkill(
          this.post,
          this.ctx,
          target as unknown as InstallTarget,
          scope
        );
      }
    },
    uninstallMarketplaceSkill: async (m) => {
      const name = str(m, "name");
      const scope = oneOf(m, "scope", ["user", "project"] as const);
      if (name && scope)
        await uninstallMarketplaceSkill(this.post, this.ctx, name, scope);
    },
    dismissSkillSuggestion: async (m) => {
      const skillId = str(m, "skillId");
      if (skillId) await dismissSuggestion(this.ctx, skillId);
    },

    // ── History ────────────────────────────────────────────────
    requestHistory: () => this.publishHistory(),
    loadSession: async (m) => {
      const id = str(m, "id");
      if (id) await this.loadHistorySession(id);
    },
    deleteHistoryEntry: async (m) => {
      const id = str(m, "id");
      if (!id) return;
      await deleteHistoryEntry(this.history, id, {
        discard: (sessionId) => this.shared.discardConversation(sessionId),
        checkpointStore: checkpointStoreDir(this.ctx.globalStorageUri.fsPath)
      });
      await this.publishHistory();
    },
    renameSession: async (m) => {
      const id = str(m, "id");
      if (!id) return;
      // An empty name is how the row clears one — the title falls back to the
      // first prompt, which is where it came from.
      const name = str(m, "name")?.trim() ?? "";
      await this.renameConversation(id, name);
      await this.publishHistory();
    },

    // ── Usage ──────────────────────────────────────────────────
    refreshUsage: () =>
      broadcastUsage(this.post, this.shared.rateLimits, { force: true }),

    // ── Conventions ────────────────────────────────────────────
    dismissConventionsBanner: async () => {
      await this.ctx.workspaceState.update(
        "luno.conventionsBannerDismissed.v1",
        true
      );
    },
    openConventionsFile: async (m) => {
      const path = str(m, "path");
      if (path) await vscode.window.showTextDocument(vscode.Uri.file(path));
    },
    generateConventions: async () => {
      await vscode.commands.executeCommand("luno.generateConventions");
    },

    // ── Plan review ────────────────────────────────────────────
    planComment: (m) => {
      const revisionId = str(m, "revisionId");
      const taskId = str(m, "taskId");
      const body = str(m, "body");
      if (revisionId && taskId && body !== undefined) {
        this.plan.handlePlanComment(revisionId, taskId, body, str(m, "quote"));
      }
    },
    planEditComment: (m) => {
      const commentId = str(m, "commentId");
      const body = str(m, "body");
      if (commentId && body !== undefined) {
        this.plan.handlePlanEditComment(commentId, body);
      }
    },
    planDeleteComment: (m) => {
      const commentId = str(m, "commentId");
      if (commentId) this.plan.handlePlanDeleteComment(commentId);
    },
    planReplyComment: (m) => {
      const revisionId = str(m, "revisionId");
      const parentCommentId = str(m, "parentCommentId");
      const body = str(m, "body");
      if (revisionId && parentCommentId && body !== undefined) {
        this.plan.handlePlanReplyComment(revisionId, parentCommentId, body);
      }
    },
    planResolveComment: (m) => {
      const commentId = str(m, "commentId");
      if (commentId) this.plan.handlePlanResolveComment(commentId, true);
    },
    planReopenComment: (m) => {
      const commentId = str(m, "commentId");
      if (commentId) this.plan.handlePlanResolveComment(commentId, false);
    },
    planOpenFileRef: async (m) => {
      const path = str(m, "path");
      const startLine = num(m, "startLine");
      const endLine = num(m, "endLine");
      if (path && startLine !== undefined && endLine !== undefined) {
        await openPlanFileRef(this.post, path, startLine, endLine);
      }
    },
    planAcceptStep: async (m) => {
      const revisionId = str(m, "revisionId");
      const taskId = str(m, "taskId");
      if (revisionId && taskId) {
        await this.plan.handlePlanAcceptStep(revisionId, taskId);
      }
    },
    planModifyStep: async (m) => {
      const revisionId = str(m, "revisionId");
      const taskId = str(m, "taskId");
      const instruction = str(m, "instruction");
      if (revisionId && taskId && instruction !== undefined) {
        await this.plan.handlePlanModifyStep(revisionId, taskId, instruction);
      }
    },
    planSkipStep: (m) => {
      const revisionId = str(m, "revisionId");
      const taskId = str(m, "taskId");
      if (revisionId && taskId)
        this.plan.handlePlanSkipStep(revisionId, taskId);
    },
    planOpenInEditor: (m) => {
      const revisionId = str(m, "revisionId");
      if (revisionId) this.plan.handlePlanOpenInEditor(revisionId);
    },
    planResubmit: async (m) => {
      const revisionId = str(m, "revisionId");
      if (revisionId) await this.plan.handlePlanResubmit(revisionId);
    },
    planAnswer: async (m) => {
      const questionId = str(m, "questionId");
      const toolUseId = str(m, "toolUseId");
      const answers = arr(m, "answers");
      if (questionId && toolUseId && answers) {
        await this.plan.handlePlanAnswer(
          questionId,
          toolUseId,
          answers as Array<{ choice: string; note?: string }>
        );
      }
    },
    planRewindTo: async (m) => {
      const revisionId = str(m, "revisionId");
      if (revisionId) await this.rewindTo(revisionId);
    },
    planProceedRequest: async (m) => {
      const revisionId = str(m, "revisionId");
      if (revisionId) await this.plan.handlePlanProceed(revisionId);
    },
    requestArtifactState: (m) => {
      // Webview-side handshake: the artifact panel mounts, asks for current
      // state, and the host posts it back to that specific panel only. Avoids
      // the race where the post fires before the webview's message listener is
      // wired up.
      const revisionId = str(m, "revisionId");
      if (revisionId) {
        this.artifacts.postToPanel(revisionId, {
          type: "loadedSession",
          events: this.session.timeline,
          title: "",
          sessionId: this.session.id
        });
      }
    },

    // ── MCP connectors ─────────────────────────────────────────
    requestConnectors: () => {
      broadcastConnectors(this.post, this.ctx);
      // Then fill in tool counts and the CLI-reported status, and re-broadcast
      // so the cards complete themselves. Best-effort + cached, so reopening
      // the panel is cheap.
      void refreshManagedAndRebroadcast(this.post, this.ctx);
    },
    connectorConnect: async (m) => {
      const id = str(m, "id");
      if (id) await connectConnector(this.post, this.ctx, id);
    },
    connectorCancelConnect: (m) => {
      const id = str(m, "id");
      if (id) cancelConnectorConnect(this.post, id);
    },
    connectorDisconnect: async (m) => {
      const id = str(m, "id");
      if (id) await disconnectConnector(this.post, this.ctx, id);
    },
    connectorAddCustom: async (m) => {
      const draft = obj(m, "draft");
      if (draft) {
        await addCustomConnector(
          this.post,
          this.ctx,
          draft as unknown as CustomDraft
        );
      }
    },
    connectorRemoveCustom: async (m) => {
      const id = str(m, "id");
      if (id) await removeCustomConnector(this.post, this.ctx, id);
    },
    connectorSetupViaClaudeCode: async (m) => {
      const id = str(m, "id");
      if (id) await setupConnectorViaClaudeCode(this.post, this.ctx, id);
    },
    connectorConnectWithApiKey: async (m) => {
      const id = str(m, "id");
      const apiKey = str(m, "apiKey");
      if (id && apiKey)
        await connectConnectorWithApiKey(this.post, this.ctx, id, apiKey);
    }
  };

  /**
   * Take one message from a webview.
   *
   * Public, and the listener lives with the *surface* rather than here. The
   * sidebar's occupant changes; a listener registered by whichever conversation
   * happened to be first would keep receiving after the swap and answer into a
   * webview it no longer owns — which is a chat that renders but cannot be
   * typed into, and a history panel that never loads.
   */
  receiveMessage(msg: RawMessage): void {
    // onMessage is async; surface rejections instead of letting them become
    // silent unhandled promise rejections (which previously masked failures
    // like a throwing checkpoint restore mid-rewind).
    void this.onMessage(msg).catch((err) =>
      logError("[luno] onMessage failed:", err)
    );
  }

  private async onMessage(msg: RawMessage) {
    // Any inbound message means the user is working in this conversation.
    this.shared.markActive(this);
    const handler = this.handlers[msg.type as InboundType];
    if (!handler) {
      // Previously silent. A type that reaches here is either a webview
      // sending something the host never learned, or a typo on one side —
      // both are contract drift, and both used to look like "nothing
      // happened". `test/unit/protocol-contract.test.ts` catches the first
      // kind before it ships.
      logWarn(`[luno] no handler for message type "${msg.type}"`);
      return;
    }
    await handler(msg);
  }

  // ── MCP connector handlers ──────────────────────────────────

  /** Tell the webview which conventions file is loaded so the status pill can
   *  render. Posts even when null so the pill can clear. */
  private broadcastConventionsStatus(c: ConventionsFile | null): void {
    this.post({
      type: "conventionsStatus",
      source: c?.source ?? null,
      path: c?.absolutePath ?? null,
      relativePath: c?.workspaceRelativePath ?? null,
      hasAlternative: c?.hasAlternative ?? false
    });
  }

  /** Plan mode only: if the classifier picked a task type with a known
   *  marketplace skill recommendation and that skill isn't installed, post a
   *  one-line suggestion to the webview. Reuses the existing
   *  `installMarketplaceSkill` flow when the user clicks Install. */

  /** After 3+ turns in a workspace with no conventions file, show a one-time
   *  banner suggesting the user generate one. Dismissal is workspace-scoped. */
  private maybeShowConventionsBanner(c: ConventionsFile | null): void {
    if (c) return;
    const dismissed = this.ctx.workspaceState.get<boolean>(
      "luno.conventionsBannerDismissed.v1",
      false
    );
    if (dismissed) return;
    const turnCount = this.ctx.workspaceState.get<number>(
      "luno.turnCount.v1",
      0
    );
    const next = turnCount + 1;
    this.ctx.workspaceState.update("luno.turnCount.v1", next);
    if (next >= 3) {
      this.post({ type: "conventionsBanner" });
    }
  }

  /** The stored chats, each told whether a conversation is open on it. Only
   *  the registry knows that, so the annotation happens here rather than in the
   *  file store. */
  private publishHistory(): Promise<void> {
    return broadcastHistory(
      this.post,
      this.history,
      (id) => this.shared.conversationFor(id)?.live
    );
  }

  /**
   * Name a stored conversation, whether or not it is open.
   *
   * A live conversation owns its own name — writing the file underneath it
   * would be overwritten by its next save — so it is asked to rename itself.
   * Only a chat nobody holds is patched on disk, and `updatedAt` is left alone
   * there: naming a chat is not working in it, and bumping it would reorder the
   * list under the user's cursor.
   */
  private async renameConversation(id: string, name: string): Promise<void> {
    const live = this.shared.conversationFor(id);
    if (live) {
      live.setName(name);
      return;
    }
    const stored = await this.history.load(id);
    if (!stored) return;
    await this.history.save({
      ...stored,
      name: name.length > 0 ? name : undefined
    });
  }

  private async loadHistorySession(id: string) {
    // Two reasons not to adopt this session here, and both end the same way:
    // another conversation already owns it — two hosts on one session would
    // resume the same CLI session twice — or this conversation has work in it,
    // and replacing that in place is what used to kill a running turn.
    //
    // Deciding *how* to show it is the registry's job, because only it knows
    // whether the owner is on screen or merely detached. Answering that here
    // was the bug: a detached owner was told to `reveal`, which does nothing
    // without a surface, so switching back to a chat left running silently
    // did nothing at all.
    const open = this.shared.conversationFor(id);
    if ((open && open !== this) || this.hasWork) {
      this.shared.showConversation(id);
      return;
    }
    const stored = await this.history.load(id);
    if (!stored) {
      this.post({ type: "error", message: "Session not found." });
      return;
    }
    this.artifacts.closeAll();
    this.releaseSessionProvider();
    // Splices the stored session in keeping its original id, so the next save
    // overwrites the same file instead of forking the conversation into a
    // second history entry — and drops the previous session's checkpoints.
    // `restoreLatestSession` used to carry its own copy of this.
    this.sessions.adopt(stored);
    this.applyStoredSettings(stored);
    this.armCheckpoints();

    this.post({
      type: "loadedSession",
      events: stored.timeline,
      title: stored.title,
      sessionId: this.session.id
    });
  }

  // ── Models / skills / search ─────────────────────────────────

  // ── Marketplace handlers ────────────────────────────────────

  private async rewindTo(turnId: string) {
    this.abortTurn();
    await this.forkBeforeTruncating(turnId);
    // Truncate the conversation and clear the UI FIRST. File restore (below)
    // can be slow or throw on a large/dirty tree, and its rejection used to
    // be swallowed by the fire-and-forget message handler — which silently
    // aborted the rewind before it ever posted, so a first-message rewind
    // "did nothing". Doing the truncate + post up front means the chat always
    // clears (a single-message rewind drops straight to the new-chat screen),
    // regardless of what happens during file restore.
    const surviving = this.session.truncateAt(turnId);
    this.resumeId = undefined;
    this.releaseSessionProvider();

    // If the user is rewinding to a proceeded plan revision, unlock it so
    // they can comment / modify steps / re-Proceed, and restore the
    // permission mode that was active just before they pressed Proceed.
    const target = surviving.find((e) => e.id === turnId);
    if (target && target.kind === "plan_revision") {
      const meta = target.meta as
        | {
            proceeded?: boolean;
            prePermissionMode?: PermissionMode;
          }
        | undefined;
      if (meta?.proceeded) {
        const prevMode = meta.prePermissionMode;
        delete meta.proceeded;
        delete meta.prePermissionMode;
        if (prevMode && this.settings.permissionMode !== prevMode) {
          await this.applySetting("permissionMode", prevMode);
        }
        this.scheduleSave();
      }
    }

    this.post({ type: "rewind", events: surviving });
    // Persist the truncation so a reload doesn't bring the rewound messages
    // back. When nothing survives (e.g. rewinding a single-message chat down
    // to empty), `history.save` would no-op — it never persists an empty
    // timeline — leaving the stale file on disk for `restoreLatestSession`
    // to resurrect on the next reload. So cancel any queued save and delete
    // the session file outright.
    if (surviving.length === 0) {
      this.sessions.cancelPendingSave();
      await this.history.delete(this.session.id);
    } else {
      this.scheduleSave();
    }

    // Revert file changes from the removed turns — best-effort, AFTER the UI
    // has already cleared. A checkpoint is captured for every turn (even
    // read-only ones), so this runs on a first-message rewind too; wrapping
    // it means a slow or failing restore can never make rewind look like it
    // "did nothing".
    if (this.checkpoints?.hasCheckpoint(turnId)) {
      try {
        await this.checkpoints.restore(turnId);
      } catch (err) {
        logError("[luno] checkpoint restore failed during rewind:", err);
      }
    }
  }

  /**
   * Keep the branch a rewind is about to discard.
   *
   * Rewinding truncated the timeline, rewrote the file and dropped `resumeId`,
   * which between them left no way back to the conversation as it stood — not
   * the messages, not the CLI session behind them. The copy goes into history
   * as its own chat, so the user can open it and carry on from where they were.
   *
   * Skipped when nothing after the target would be lost: a rewind to the last
   * turn is a no-op, and a history row per no-op is clutter that makes the real
   * forks harder to find.
   */
  private async forkBeforeTruncating(turnId: string): Promise<void> {
    const timeline = this.session.timeline;
    const idx = timeline.findIndex((e) => e.id === turnId);
    if (idx === -1 || idx === timeline.length - 1) return;

    try {
      const forkId = await this.sessions.forkCurrent(
        `${this.session.id}-fork-${Date.now()}`,
        forkName(this.sessions.name, timeline)
      );
      if (forkId) await this.publishHistory();
    } catch (err) {
      // A rewind the user asked for must still happen. Losing the safety copy
      // is worth saying out loud, but not worth refusing the operation over.
      logError("[luno] could not fork before rewind:", err);
    }
  }

  private async editAt(turnId: string, text: string, revertFiles: boolean) {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.abortTurn();
    await this.forkBeforeTruncating(turnId);
    if (revertFiles && this.checkpoints?.hasCheckpoint(turnId)) {
      try {
        await this.checkpoints.restore(turnId);
      } catch (err) {
        logError("[luno] checkpoint restore failed during edit:", err);
      }
    }
    const surviving = this.session.truncateAt(turnId);
    this.resumeId = undefined;
    this.releaseSessionProvider();
    this.post({ type: "rewind", events: surviving });
    await this.handlePrompt(trimmed);
  }

  private async handlePrompt(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    // Sending never queues. A turn already in flight takes the message as an
    // addition: the CLI picks it off stdin at the next tool boundary and
    // continues the same turn, which is what makes a correction land while the
    // work it corrects is still happening rather than after it.
    if (this.activeTurn && (await this.steerIntoRunningTurn(trimmed))) return;
    await this.runTurnReportingFailure(trimmed);
  }

  /**
   * Add a message to the turn already running.
   *
   * Written first, recorded second. Upstream records first, and this diverges
   * on purpose: a write that stdin refuses must not leave a message on the
   * timeline that nobody ever received. `false` sends the caller back to
   * opening an ordinary turn, which records it itself.
   *
   * Recording is this method's job and nothing else's — `addUser` lives inside
   * `Orchestrator.turn`/`observe`, and a steered message opens neither. Without
   * it the bubble would render, the model would answer, and the message would
   * be absent from the stored session and from every later turn's context.
   */
  private async steerIntoRunningTurn(text: string): Promise<boolean> {
    if (!this.sessionProvider?.steer(text)) return false;
    await this.session.addUser(text);
    this.scheduleSave();
    return true;
  }

  private async runTurnReportingFailure(text: string): Promise<void> {
    try {
      await this.runPromptTurn(text);
    } catch (err) {
      // Surface pre-stream failures instead of letting the submit vanish.
      const message = err instanceof Error ? err.message : String(err);
      logError("[luno] handlePrompt failed:", err);
      this.post({
        type: "error",
        message: `Couldn't start the turn: ${message}`
      });
    }
  }

  /**
   * Hand back what the CLI never got to read.
   *
   * The queue lives inside the CLI now, and `interrupt` answers with what it
   * still held. Measured against 2.1.219: a message the turn had already
   * *accepted* comes back as `[]` — accepted is gone, not returned — so this
   * is narrower than the local queue it replaces, and honestly so.
   *
   * The official extension asks for the same field and drops it. Returning it
   * is a deliberate divergence, matching the TUI, which consumes it.
   */
  private returnStillQueued(text: string): void {
    if (!text.trim()) return;
    this.post({ type: "returnToComposer", text });
  }

  /** Remember it as well as send it: the webview is rebuilt on reload and asks
   *  for the current surface, and a bridge that is up must not look off. */
  private publishRemoteControl(status: RemoteControlStatus): void {
    this.remoteControl = status;
    this.post({ type: "remoteControl", status });
  }

  /**
   * The conversation's CLI process, built on demand and kept across turns.
   *
   * One process per conversation, not per turn: a `run_in_background` agent
   * keeps working after the turn that launched it ends, and on a process that
   * died with the turn the only way to keep it alive was to hold the turn open
   * — which held the thinking indicator and the composer with it.
   *
   * Per-turn options are deliberately absent: `runPromptTurn` pushes them in
   * through `updateOptions()` every turn, which is the only way they stay
   * fresh on a provider that is no longer rebuilt.
   *
   * @param root the working root the caller already resolved, if it has one.
   *   Remote Control's toggle has no turn behind it and resolves its own.
   * @param token likewise for the credential — `ensureAuthedForTurn` repairs a
   *   stale signed-out flag on the way through, so it is not free to re-run.
   */
  private ensureSessionProvider(
    root?: string,
    token?: string
  ): Promise<ClaudeCliProvider> {
    const live = this.sessionProvider;
    if (live) return Promise.resolve(live);
    // The lock is this phase's, not an afterthought: the `activeTurn` gate that
    // used to queue a second send was also serialising the spawn. Now that
    // sending never queues, two sends against a conversation with no process
    // both reach here — and `session.busy` is set after the spawn, so it cannot
    // cover the gap. The promise is what the second caller waits on.
    this.sessionProviderStarting ??= this.startSessionProvider(
      root,
      token
    ).finally(() => {
      this.sessionProviderStarting = null;
    });
    return this.sessionProviderStarting;
  }

  /** The half of `ensureSessionProvider` that may only run once at a time. */
  private async startSessionProvider(
    root?: string,
    token?: string
  ): Promise<ClaudeCliProvider> {
    const workspaceRoot = root ?? (await this.ensureWorkingRoot());
    if (!workspaceRoot) {
      throw new Error("Open a folder to use Luno.");
    }
    if (!token) {
      const credential = await this.auth.ensureAuthedForTurn();
      if (!credential.ok) {
        throw new Error("Sign in to Claude Code before sending a message.");
      }
      token = credential.token;
    }
    const cfg = vscode.workspace.getConfiguration("luno");
    const provider = createProvider({
      // Also here, not only on `updateOptions`: the Remote Control bridge can
      // spawn before any turn has run, and argv built without these would
      // differ from argv built with them — which `respawnFingerprint` reads as
      // a settings change and answers by replacing the process the phone is
      // attached to. The same trap `--model` is already excluded for.
      ...this.extraCliOptions(workspaceRoot),
      cwd: workspaceRoot,
      permissionMode: this.settings.permissionMode,
      allowedBashPatterns: cfg.get<string[]>("allowedBashPatterns", []),
      disabledSkills: disabledSkillIds(this.ctx),
      conventions: await loadConventions(workspaceRoot),
      getResumeSessionId: () => this.resumeId,
      setResumeSessionId: (id) => {
        this.resumeId = id;
      },
      getToolGrants: () => readGrants(this.ctx),
      onSlashCommands: (names) => {
        rememberCliCommands(this.ctx, names);
        void broadcastSlashCommands(this.post, this.ctx, this.workingRoot);
      },
      token,
      effort: this.settings.effort,
      thinking: this.settings.thinking,
      sessionMode: true,
      // Replacing the process to pick up a new effort would kill every agent in
      // it, and nobody flips a chip meaning that. Read fresh on every turn.
      hasLiveWork: () => this.hasLiveWork,
      onSettingsPending: (pending) => {
        this.pendingSettings = pending;
        void this.publishAuthState();
      },
      onStillQueued: (text) => this.returnStillQueued(text),
      onOutOfTurn: (d) => {
        // The other device talking while the panel is not driving the turn.
        if (d.type === "remote_control" && d.remoteControl) {
          this.publishRemoteControl(d.remoteControl);
          return;
        }
        // A prompt sent from the phone. It is the only announcement that a turn
        // is starting here, so the queue that will carry the rest of it has to
        // exist before this call returns.
        if (d.type === "remote_prompt" && d.prompt) {
          this.beginRemoteTurn(d.prompt);
          return;
        }
        // A steered message that found no tool boundary before its turn ended.
        // The CLI opened one of its own for it, and it gets a full turn here
        // rather than the out-of-turn text path — that path keeps only `text`,
        // so the answer would arrive as one bare paragraph with every tool call
        // missing. `null` because the message is already on the timeline.
        if (d.type === "steer_turn") {
          this.beginRemoteTurn(null);
          return;
        }
        // A subagent that outlived the turn that launched it. In session mode
        // the process survives, so a `run_in_background` agent keeps working
        // and reports minutes later with the turn long over — its card is
        // still on the timeline waiting to be closed. Routed before the remote
        // queue because this belongs to the panel's own conversation, not to
        // whatever a phone happens to be doing.
        if (d.type === "task" && d.task) {
          this.onSubagentUpdate(d.task);
          return;
        }
        // What the model says once a background task answers. The CLI queues a
        // `<task-notification>` and opens a whole extra turn to report it, and
        // that turn arrives here — after the panel's own turn has ended and
        // with no remote turn to belong to. Falling through dropped it — the
        // agent finished, the card closed, and the chat said nothing about what
        // came back, which is the only account the user ever gets.
        if (d.type === "text" && d.text && !this.remoteTurn) {
          this.outOfTurnText += d.text;
          return;
        }
        // The process is gone, so no late report is coming for anything still
        // open — close those cards rather than leave them spinning. Guarded on
        // there being no remote turn, because `done` is also how one of those
        // ends: swallowing it there would hang the phone's turn.
        //
        // `sessionEnded` is what makes this specific. A session process pushes
        // `done` at every `result`, including the extra turn the CLI opens to
        // report a task that just finished — and sweeping on that one filed
        // every *other* agent still running as `interrupted`, seconds before it
        // answered. Measured on a live run: one agent was closed yellow at
        // 38.6s and reopened green at 107.6s, leaving two closing rows on the
        // timeline for one agent.
        if (d.type === "done" && !this.remoteTurn) {
          this.flushOutOfTurnText();
          if (d.sessionEnded) this.sweepLiveTasks();
          return;
        }
        // An approval prompt with no turn to attach to. `run_in_background` is
        // the default for agents, so an agent hitting an Edit long after the
        // turn that launched it ended is the ordinary case, not an edge — and
        // the CLI blocks on that answer for the life of the process. Dropped,
        // the card spun with nothing on screen to answer and the request id was
        // later destroyed by an unrelated turn.
        if (
          !this.remoteTurn &&
          (d.type === "permission_request" ||
            d.type === "permission_resolved" ||
            d.type === "user_dialog" ||
            d.type === "user_dialog_resolved")
        ) {
          this.onTurnDelta(d, this.effectiveModel);
          return;
        }
        // Everything else belongs to that turn — or to no turn at all, in which
        // case there is nothing on the timeline for it to attach to and
        // dropping it is the honest outcome.
        this.remoteTurn?.push(d);
      }
    });
    this.sessionProvider = provider;
    return provider;
  }

  /**
   * End the conversation's process and forget it.
   *
   * Called wherever the conversation the process is holding stops being the one
   * we are in: a new chat, a rewind or edit that truncates the history, a
   * sign-out that invalidates the credential it runs on, and the conversation
   * being disposed. `--resume` is applied at spawn and nowhere else, so a
   * process kept across any of those would answer from a history the panel has
   * already thrown away — the model remembering what the user just rewound past
   * is the visible form of that.
   *
   * Not called at the end of a turn. That is the entire point of it.
   */
  private releaseSessionProvider(): void {
    const provider = this.sessionProvider;
    if (!provider) return;
    // Say what is being taken down with it. Nothing anywhere logged the end of
    // a session process, so when one took a background workflow with it the log
    // could not even establish that it had happened, let alone why.
    logInfo(
      `[luno] releasing the CLI process` +
        (this.hasLiveWork
          ? ` — with a turn ${this.activeTurn ? "running" : "idle"} and ${this.liveTasks.size} task(s) still open`
          : "")
    );
    this.sessionProvider = null;
    if (this.activeProvider === provider) this.activeProvider = undefined;
    provider.disposeSession();
    this.publishRemoteControl({ state: "off" });
  }

  private async runPromptTurn(text: string) {
    await saveDirtyEditors();
    // Resolved once and used for everything downstream. In an isolated
    // conversation this is the worktree, not the folder VS Code has open, and a
    // path that misses it lands in the wrong tree: attachments the agent cannot
    // read, checkpoints that restore someone else's file.
    const workspaceRoot = await this.ensureWorkingRoot();
    if (workspaceRoot) {
      text = await extractInlineImages(text, workspaceRoot);
    }
    // `@terminal:name` becomes the output itself, here rather than in the CLI
    // — it has no such token, and the recording only exists in this process.
    // Expanded into the turn text, which puts it on the timeline too: a run
    // that is not there is the only way to tell tomorrow what the model was
    // actually shown.
    text = expandTerminalMentions(text, capturedRun);
    // Posture comes from the conversation, not the workspace: another chat may
    // be running under a different mode right now, and the `luno.*` settings
    // are only what a new one starts with.
    const {
      model,
      permissionMode: permMode,
      effort,
      thinking,
      ultracode
    } = this.settings;
    const cfg = vscode.workspace.getConfiguration("luno");
    const maxTokens = cfg.get<number>("maxTokens", 0);
    const bashAllowlist = cfg.get<string[]>("allowedBashPatterns", []);
    // Skills the user toggled off in the picker. Passed through to the CLI
    // so it actually skips them at invocation time, not just visually.
    const disabledSkills = disabledSkillIds(this.ctx);

    // Refuse the turn without a usable credential. `auth` owns what counts as
    // one — a pasted token, or Claude Code's own stored creds — and repairs a
    // stale signed-out flag on the way through. The token comes back with the
    // verdict so it cannot be read without passing the check; it is undefined
    // when the CLI holds its own creds and wants nothing injected.
    const credential = await this.auth.ensureAuthedForTurn();
    if (!credential.ok) return;
    const token = credential.token;

    if (!workspaceRoot) {
      this.post({ type: "error", message: "Open a folder to use Luno." });
      return;
    }

    this.sessions.ensureCheckpoints(
      workspaceRoot,
      checkpointStoreDir(this.ctx.globalStorageUri.fsPath)
    );

    // Per-turn prompt context: classify the task and discover project
    // conventions so the CLI gets the same grounding info every time.
    // Conventions are cached per-workspace and invalidated by file watcher.
    const activeFile = vscode.window.activeTextEditor
      ? vscode.workspace.asRelativePath(
          vscode.window.activeTextEditor.document.uri
        )
      : undefined;
    const taskType = classifyTask(text, activeFile);
    const conventions = await loadConventions(workspaceRoot);
    this.broadcastConventionsStatus(conventions);

    // Materialize the per-turn MCP config the CLI consumes via
    // `--mcp-config`. Contains only currently-connected servers with
    // their bearer tokens; written to OS temp with mode 0600 and
    // unlinked after the CLI exits below.
    let mcpConfig: Awaited<ReturnType<typeof writeCliMcpConfig>> = null;
    try {
      mcpConfig = await writeCliMcpConfig(this.ctx);
    } catch {
      mcpConfig = null;
    }

    // One process for the whole conversation, so it is reused rather than
    // rebuilt — and handed everything that changed since the last turn. Without
    // that, diagnostics and the editor's selection would stay frozen at whatever
    // they were when the process was spawned, because a running CLI cannot be
    // told a new system prompt.
    let providerInstance: ClaudeCliProvider;
    try {
      providerInstance = await this.ensureSessionProvider(workspaceRoot, token);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`[luno] turn failed before the stream opened: ${msg}`);
      this.post({ type: "error", message: msg });
      void mcpConfig?.cleanup();
      return;
    }
    providerInstance.updateOptions({
      permissionMode: permMode,
      allowedBashPatterns: bashAllowlist,
      disabledSkills,
      // Not for this turn — that carries its own on the request. For the next
      // spawn with no turn behind it, so the Remote Control toggle builds the
      // argv an ordinary turn would and does not read as a settings change.
      model: this.effectiveModel,
      taskType,
      conventions,
      diagnostics: collectDiagnostics(workspaceRoot),
      editorContext: collectEditorContext(workspaceRoot),
      token,
      mcpConfigPath: mcpConfig?.path,
      mcpServerNames: mcpConfig?.serverNames,
      effort,
      thinking,
      ultracode,
      ...this.extraCliOptions(workspaceRoot)
    });

    // In `default`/`auto` the provider routes each mutating tool call back to
    // us over the stream-json control channel; we surface it as an inline
    // approval card (see onDelta's `permission_request` handling). The mode,
    // task-type and conventions prompts are not composed here — `buildArgs`
    // pushes each as its own `--append-system-prompt`, on top of the base
    // prompt the CLI already carries.
    this.maybeShowConventionsBanner(conventions);
    if (permMode === "plan") {
      void suggestSkill(this.post, this.ctx, taskType, workspaceRoot);
    }

    this.activeProvider = providerInstance;
    this.orchestrator = new Orchestrator(this.session, {
      provider: providerInstance,
      model,
      maxTokens,
      onDelta: (d: StreamDelta) => this.onTurnDelta(d, model)
    });

    this.turnStartedAt = Date.now();
    this.post({ type: "turnStart" });
    const orchestrator = this.orchestrator;
    const turn = (async () => {
      try {
        await orchestrator.turn(text);
      } finally {
        this.activeProvider = undefined;
        this.awaitingApproval = false;
        // No sweep here, deliberately. The process outlives the turn now, so a
        // `run_in_background` agent really is still working and will report
        // later through `onOutOfTurn` — closing its card would put
        // `interrupted` on an agent that is about to answer, and
        // `emitSubagentEnd` persists that. Only the `done` that says the
        // process itself is gone may sweep.
        // A turn that landed while the user was looking elsewhere is the other
        // thing worth a glyph: the answer is sitting there unread.
        if (!this.visible) this.finishedWhileHidden = true;
        this.refreshSurface();
        this.notify("turnFinished");
        this.post({ type: "turnEnd" });
        // Refresh authoritative usage after every turn — Claude Code writes
        // its session JSONL synchronously, so by this point the new tokens
        // are on disk and the aggregator will pick them up.
        void broadcastUsage(this.post, this.shared.rateLimits);
        // Drop the per-turn MCP config so the bearer tokens it held don't
        // sit on disk between turns.
        void mcpConfig?.cleanup();
      }
    })();
    this.activeTurn = turn;
    try {
      await turn;
    } finally {
      if (this.activeTurn === turn) this.activeTurn = undefined;
    }
  }

  /**
   * Take over a turn the phone started.
   *
   * Not async, and that is the whole point: the prompt arrives on the reader's
   * thread and the answer is already on its way behind it, so the queue that
   * catches it has to be in place before this returns. Everything that has to
   * wait — a local turn still finishing, the checkpoint — waits inside.
   *
   * The turn is otherwise indistinguishable from one sent here: same
   * orchestrator, same delta handler, same busy state, and Stop still stops it,
   * because `activeProvider` is what the cancel and approval paths reach for.
   */
  private beginRemoteTurn(text: string | null): void {
    const provider = this.sessionProvider;
    if (!provider) return;
    // Two prompts typed on the phone in quick succession: the CLI takes both
    // and replays the second while the first turn is still open here. Ending
    // the first explicitly is what keeps that from deadlocking — the new turn
    // waits on the old one, and the old one would never finish, because its
    // `done` is now arriving on a queue nothing is reading.
    this.remoteTurn?.close();
    const queue = new DeltaQueue();
    this.remoteTurn = queue;
    const model = this.effectiveModel;
    const maxTokens = vscode.workspace
      .getConfiguration("luno")
      .get<number>("maxTokens", 0);
    const orchestrator = new Orchestrator(this.session, {
      provider,
      model,
      maxTokens,
      onDelta: (d: StreamDelta) => this.onTurnDelta(d, model)
    });
    // Normally nothing: the CLI answers one turn at a time, so a prompt from
    // the phone lands between ours. The exception is the moment a local turn is
    // finishing — its `finally` has not run yet, and starting on top of it
    // would leave two turns sharing one `activeProvider`.
    const previous = this.activeTurn;
    const turn = (async () => {
      try {
        await previous;
      } catch {
        // A local turn that failed reported it itself; this one still runs.
      }
      this.orchestrator = orchestrator;
      this.activeProvider = provider;
      this.armCheckpoints();
      this.turnStartedAt = Date.now();
      this.post({ type: "turnStart" });
      try {
        await orchestrator.observe(text, queue);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logError("[luno] remote turn failed:", err);
        this.post({ type: "error", message });
      } finally {
        if (this.remoteTurn === queue) this.remoteTurn = undefined;
        if (this.activeProvider === provider) this.activeProvider = undefined;
        this.awaitingApproval = false;
        // Only when the process itself is gone. A remote turn ends on a `done`
        // like any other, and while one is live that `done` reaches the queue
        // rather than the guarded branch in `onOutOfTurn` — so sweeping here
        // unconditionally filed every agent still working as `interrupted`,
        // and `emitSubagentEnd` wrote that to disk. A workflow always outlives
        // the turn that launched it, so this was reachable whenever a prompt
        // arrived from another device mid-run.
        if (queue.sessionEnded) this.sweepLiveTasks();
        if (!this.visible) this.finishedWhileHidden = true;
        this.refreshSurface();
        this.notify("turnFinished");
        this.post({ type: "turnEnd" });
        this.scheduleSave();
        void broadcastUsage(this.post, this.shared.rateLimits);
      }
    })();
    this.activeTurn = turn;
    void turn.finally(() => {
      if (this.activeTurn === turn) this.activeTurn = undefined;
    });
  }

  /**
   * One delta from a turn in flight, whichever surface started it.
   *
   * @param requestedModel what the picker asked for, so the resolved id the CLI
   *   reports can be recorded against it.
   */
  private onTurnDelta(d: StreamDelta, requestedModel: string): void {
    // The bridge describes the session, not the turn, and its state moves while
    // a turn holds the sink — switching it on mid-turn is the ordinary case.
    // The verbatim forward below cannot carry it: the webview's `Delta` union
    // has no `remote_control` member, so the pill would go on advertising a
    // session URL nobody is holding.
    if (d.type === "remote_control" && d.remoteControl) {
      this.publishRemoteControl(d.remoteControl);
      return;
    }
    // A pending tool-permission prompt: surface it as a dedicated typed
    // message (an inline approval card in the webview) rather than a raw
    // delta the timeline doesn't know how to render.
    if (d.type === "permission_request" && d.permission) {
      // The turn now cannot continue until someone answers. Off screen that
      // reads as a chat that simply stopped, so it has to say so.
      // Before the flag is raised, so a second card arriving while the first
      // is still unanswered does not stack a second banner. A background agent
      // can ask while the main turn is already parked, which is the only way
      // two are outstanding at once.
      const alreadyWaiting = this.awaitingApproval;
      this.awaitingApproval = true;
      this.refreshSurface();
      if (!alreadyWaiting) this.notify("approval");
      this.post({
        type: "permissionRequest",
        request: this.withGrantScopes(d.permission)
      });
      return;
    }
    // A decision that is not about a tool. Blocks the turn exactly as an
    // approval does, and reads the same off screen, so it raises the same flag.
    if (d.type === "user_dialog" && d.dialog) {
      const dialogAlreadyWaiting = this.awaitingApproval;
      this.awaitingApproval = true;
      this.refreshSurface();
      // Its own trigger, not `approval`: the CLI can time a question out, so a
      // missed one costs the answer rather than merely waiting for it.
      if (!dialogAlreadyWaiting) this.notify("question");
      this.post({ type: "userDialog", dialog: d.dialog });
      return;
    }
    if (d.type === "user_dialog_resolved" && d.requestId) {
      this.awaitingApproval = false;
      this.refreshSurface();
      this.post({ type: "userDialogResolved", requestId: d.requestId });
      return;
    }
    // The same prompt went to the phone, someone answered it there, and the CLI
    // has withdrawn the request. The card has to go: answering it now would
    // write against an id the CLI has already forgotten, and the turn it was
    // blocking has moved on.
    if (d.type === "permission_resolved" && d.requestId) {
      this.awaitingApproval = false;
      this.refreshSurface();
      this.post({ type: "permissionResolved", requestId: d.requestId });
      // A tool ran without anyone approving it *here*. Reopening this chat
      // tomorrow, that is the only thing explaining why.
      this.session.emit({
        kind: "approval",
        title: "Answered on another device",
        body: d.permission?.toolName ?? "",
        meta: { requestId: d.requestId, remote: true }
      });
      this.scheduleSave();
      return;
    }
    // Forward stream deltas to the webview verbatim (text, tool_use_*, etc.).
    this.post({ type: "delta", delta: d });
    // The CLI reports the resolved model (alias → concrete id). Re-publish
    // it as a typed event so the model picker can show what's actually
    // running, not just the alias the user selected.
    if (d.type === "model" && d.model) {
      this.models.record(requestedModel, d.model);
    }
    // Usage deltas are the authoritative token counts reported by the
    // CLI. Re-publish them as a typed `tokenUsage` event so the
    // TokenMeter doesn't need to parse the raw delta envelope.
    if (d.type === "usage" && d.usage) {
      this.post({
        type: "tokenUsage",
        inputTokens: d.usage.inputTokens,
        outputTokens: d.usage.outputTokens,
        cacheReadTokens: d.usage.cacheReadTokens,
        cacheCreatedTokens: d.usage.cacheCreatedTokens,
        costUsd: d.usage.costUsd,
        sessionId: d.usage.sessionId,
        source: "claude-cli",
        contextTokens: d.usage.contextTokens,
        contextWindow: d.usage.contextWindow
      });
    }
    // Compaction is the one thing that changes what the model remembers
    // without the user doing anything, so it goes on the timeline rather
    // than into a transient message: reopening the chat tomorrow, the gap
    // still needs explaining.
    if (d.type === "compact") {
      this.session.emit({
        kind: "compact",
        title: "Context compacted",
        body: compactionSummary(d.compaction),
        meta: { ...d.compaction }
      });
      this.scheduleSave();
    }
    if (d.type === "task" && d.task) {
      this.onSubagentUpdate(d.task);
    }
    // The CLI's own quota verdict — which window is binding and when it
    // resets. It anchors the 5-hour aggregation, so record it before the
    // post-turn refresh reads it back.
    if (d.type === "rate_limit" && d.rateLimit) {
      this.shared.rateLimits.record(d.rateLimit);
    }
  }

  /**
   * One `task_*` event from the CLI, routed by what it actually tells us.
   *
   * Two of the four phases go on the timeline and two do not, and the split is
   * about what still means something tomorrow. That an agent was dispatched and
   * what it answered explain the turn when the chat is reopened; that it was
   * four seconds into a Grep explains nothing once it has finished. Persisting
   * progress would also grow the timeline by one event per nested tool call —
   * for a fleet of agents that is hundreds of rows nobody will ever read.
   *
   * `notification` closes the card rather than `updated`, even though `updated`
   * reports the terminal status first: it is the only phase carrying the
   * summary, and the pair arrives back to back.
   */
  private onSubagentUpdate(update: SubagentUpdate): void {
    // The CLI has already said how this one ended. Nothing arriving afterwards
    // can add to that, and letting it through is what put a task the CLI had
    // reported `stopped` back among the live ones, to be swept as
    // `interrupted` — see `reportedTasks`.
    if (this.reportedTasks.has(update.taskId)) return;

    const merged: SubagentUpdate = {
      ...this.taskIdentity.get(update.taskId),
      ...this.liveTasks.get(update.taskId),
      ...stripUndefined(update),
      // Restated because `stripUndefined` widens both to optional; they are the
      // two fields the incoming event is always authoritative for.
      taskId: update.taskId,
      phase: update.phase
    };

    // `task_type` rides on `task_started` and on no other phase, so this is the
    // first point that knows a progress event belongs to a workflow — the
    // dispatch has been merged in by now. A workflow puts the *agent's label*
    // in `last_tool_name` ("Reply with exactly the word OK"), not the name of a
    // tool, and the same string is already the activity.
    if (isWorkflowTask(merged.taskType)) delete merged.lastToolName;

    if (update.phase === "notification") {
      this.liveTasks.delete(update.taskId);
      this.reportedTasks.add(update.taskId);
      this.emitSubagentEnd(merged);
      return;
    }

    this.liveTasks.set(update.taskId, merged);

    if (update.phase === "started") {
      // The only phase carrying description, task type and workflow name. Kept
      // apart from `liveTasks` because that map is cleared when the card
      // closes, and a row rebuilt without these reads as an anonymous "Agent".
      this.taskIdentity.set(update.taskId, merged);
      this.session.emit({
        kind: "subagent",
        title: subagentTitle(merged),
        body: merged.description ?? "",
        meta: { ...merged, phase: "start", status: "running" }
      });
      this.scheduleSave();
      return;
    }
    this.post({ type: "subagentProgress", task: merged });
  }

  private emitSubagentEnd(task: SubagentUpdate): void {
    this.session.emit({
      kind: "subagent",
      title: subagentTitle(task),
      body: task.summary ?? task.description ?? "",
      meta: {
        ...task,
        phase: "end",
        status: isTerminalTaskStatus(task.status) ? task.status : "interrupted"
      }
    });
    this.scheduleSave();
  }

  /**
   * Put the model's out-of-turn report on the timeline, if it said anything.
   *
   * Written as an ordinary assistant row rather than through the streaming
   * path: there is no turn for the panel to attach it to, and a stored session
   * has to show it tomorrow exactly as it read today.
   */
  private flushOutOfTurnText(): void {
    const text = this.outOfTurnText.trim();
    this.outOfTurnText = "";
    if (!text) return;
    this.session.emit({ kind: "assistant", title: "Assistant", body: text });
    this.scheduleSave();
    if (!this.visible) this.finishedWhileHidden = true;
    this.refreshSurface();
  }

  /**
   * Close every subagent still open, because nothing more is coming for them.
   *
   * Called when the process that was running them is gone: the end of a turn on
   * the per-turn path, or the session process exiting on the other one. A task
   * that never reported a terminal status did not keep working — it died there,
   * whether that was Stop, a crash, or the hard timeout.
   *
   * **Never call this because a turn ended.** In session mode the process
   * survives the turn, so a `run_in_background` agent really is still running
   * and will report later through `onOutOfTurn`; sweeping would put
   * "interrupted" on a card that is about to answer — and `emitSubagentEnd`
   * persists it. Every call site is gated on the process being gone, and the
   * one that was not is what D1 in the parity audit was.
   */
  private sweepLiveTasks(): void {
    if (this.liveTasks.size === 0) return;
    const open = [...this.liveTasks.values()];
    this.liveTasks.clear();
    for (const task of open) this.emitSubagentEnd(task);
  }

  /**
   * An arrow property, not a method: extracted domains take `post` as a value,
   * and a plain method passed by reference arrives with `this` unbound.
   */
  private readonly post: Post = (msg: unknown) => {
    this.rememberLiveState(msg);
    this.target?.webview.postMessage(msg);
    // Mirror to any open artifact editor tabs so they stay in sync with the
    // chat — comment edits, step accepts, plan revisions, etc. all need to
    // appear on both surfaces.
    this.artifacts.broadcast(msg);
  };

  private html(webview: vscode.Webview): string {
    return buildWebviewHtml({
      webview,
      extensionUri: this.ctx.extensionUri,
      title: "Luno"
    });
  }
}

/**
 * Directory name for a conversation's checkout.
 *
 * Derived from the session id rather than the title: it becomes a branch name
 * and a path, both of which have to stay put, and a title is rewritten every
 * time the conversation's first message changes.
 */
/**
 * What a new conversation is born with.
 *
 * The `luno.*` settings are defaults here, not live state: changing one must
 * not retarget a chat that is already running under a different posture.
 */
function defaultSettings(): ConversationSettings {
  const cfg = vscode.workspace.getConfiguration("luno");
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const claude = claudePreferences(root);
  // `luno.*` explicitly set wins over Claude's own file; Claude's wins over
  // LUNO's built-in default. That is what makes these preferences rather than
  // restrictions — a restriction is enforced elsewhere and cannot be overridden
  // by either, which is the whole difference this phase turns on.
  return {
    model: explicit(cfg, "model") ?? claude.model ?? "default",
    permissionMode:
      explicit<PermissionMode>(cfg, "permissionMode") ??
      claude.defaultMode ??
      "default",
    effort: explicit<EffortLevel>(cfg, "effort") ?? claude.effort ?? "high",
    thinking: explicit<boolean>(cfg, "thinking") ?? claude.thinking ?? true,
    // Deliberately not a `luno.*` setting: ultracode makes the model stand up
    // fleets of agents, and something that spends the quota that fast is a
    // choice per conversation rather than the shape every new one is born in.
    ultracode: false
  };
}

/**
 * A `luno.*` value only when someone actually set one.
 *
 * `getConfiguration().get(key, fallback)` cannot tell "the user chose this"
 * from "this is the packaged default", and the difference decides whether
 * Claude's own preference gets a say. Without it, LUNO's default would silently
 * outrank a value the user had already set for Claude Code.
 */
function explicit<T>(
  cfg: vscode.WorkspaceConfiguration,
  key: string
): T | undefined {
  const info = cfg.inspect<T>(key);
  return (
    info?.workspaceFolderValue ??
    info?.workspaceValue ??
    info?.globalValue ??
    undefined
  );
}
