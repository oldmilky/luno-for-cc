import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { Session } from "../core/session.js";
import { Orchestrator } from "../core/orchestrator.js";
import {
  PermissionMode,
  PermissionBehavior,
  StreamDelta
} from "../core/types.js";
import type { ChatProvider } from "../providers/base.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { createProvider } from "../providers/factory.js";
import type { EffortLevel } from "../providers/claude-cli.js";
import { CheckpointService } from "../services/checkpoint.js";
import {
  deriveTitle,
  HistoryService,
  type LiveStatus,
  type StoredSession
} from "../services/history.js";
import { PlanDecorationService } from "../services/plan-decorations.js";
import { PlanArtifactManager } from "./plan-artifact-panel.js";
import { buildWebviewHtml } from "./webview-html.js";
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
import { confirmBypassMode } from "./domains/permission-modes.js";
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
  searchFiles
} from "./domains/files.js";
import { broadcastHistory } from "./domains/history.js";
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
   * End the conversation showing `sessionId`, if one is open.
   *
   * Its history entry is being deleted. Left running it would rewrite that file
   * on its next debounced save — the delete would simply undo itself — and it
   * would keep a CLI process alive for a chat the user believes is gone.
   */
  discardConversation(sessionId: string): void;
  /** Note which conversation the user is working in, so a keybinding lands on
   *  the chat in front of them rather than an arbitrary one. */
  markActive(host: ConversationHost): void;
  /** A conversation now wants — or no longer wants — the user. Lets the
   *  registry keep one badge for every chat that is off screen. */
  attentionChanged(): void;
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
  /** Enough of the live turn to rebuild it on a surface that was showing
   *  another conversation while it happened. */
  private busy = false;
  private streamed = "";
  private pendingRequest?: unknown;
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
  dispose(): void {
    this.abortTurn();
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
   * What this conversation is doing, for the history list.
   *
   * Distinct from `attention`, which answers "does a surface need a glyph". A
   * chat the user is looking at is never *waiting* for their eye but can very
   * much be waiting for their answer, and the list has to say so either way.
   */
  get live(): LiveStatus {
    if (this.awaitingApproval) return "waiting";
    if (this.busy) return "running";
    return "open";
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
    } else if (m.type === "turnEnd") {
      this.busy = false;
      this.streamed = "";
      this.pendingRequest = undefined;
    } else if (m.type === "delta" && m.delta?.type === "text") {
      this.streamed += m.delta.text ?? "";
    } else if (m.type === "timeline") {
      // The orchestrator flushes streamed text into a real event before any
      // tool call, so the buffer's job ends exactly where the webview's does.
      const kind = (msg as { event?: { kind?: string } }).event?.kind;
      if (kind === "assistant" || kind === "tool_call") this.streamed = "";
    } else if (m.type === "permissionRequest") {
      this.pendingRequest = (msg as { request?: unknown }).request;
    } else if (m.type === "permissionResolved") {
      this.pendingRequest = undefined;
    }
  }

  /** Whether this conversation holds anything worth not losing — a running
   *  turn, or messages already exchanged. */
  get hasWork(): boolean {
    return this.activeTurn !== undefined || this.session.timeline.length > 0;
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
    this.refreshSurface();
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
      void broadcastUsage(this.post);
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
    this.sessions.adopt(stored);
    this.applyStoredSettings(stored);
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

      this.sessions.adopt(stored);
      this.applyStoredSettings(stored);
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
      ...this.settings
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
      thinking: stored.thinking ?? fallback.thinking
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
    // `reset` covers the session, the resume id and the checkpoints together.
    // They were three separate statements here, and forgetting one is how a
    // "new" chat inherits the old one's rewind history.
    this.sessions.reset();
    this.abortTurn();
    this.orchestrator = undefined;
    this.post({ type: "reset", sessionId: this.session.id });
  }

  async sendUserMessage(text: string) {
    this.reveal();
    await this.handlePrompt(text);
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
    console.log("[luno] aborting turn (cancel/rewind/new-session)");
    this.orchestrator?.cancel();
    this.activeProvider?.cancel?.();
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
    newSession: () => this.newSession(),
    permissionResponse: (m) => {
      const requestId = str(m, "requestId");
      const behavior = oneOf(m, "behavior", ["allow", "deny"] as const);
      if (!requestId || !behavior) return;
      this.awaitingApproval = false;
      this.refreshSurface();
      if (!this.activeProvider?.respondToPermission) {
        console.warn(
          "[luno] permissionResponse arrived but no active provider to answer it"
        );
      }
      this.activeProvider?.respondToPermission?.(
        requestId,
        behavior as PermissionBehavior,
        { restOfTurn: m.restOfTurn === true }
      );
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
      if (model) await this.applySetting("model", model);
    },
    setPermissionMode: async (m) => {
      const mode = str(m, "mode");
      if (!mode) return;
      // The confirmation lives host-side rather than in the webview so no path
      // into the mode can skip it — not the picker, not a command, not a future
      // caller that has not been written yet.
      if (mode === "bypass" && !(await confirmBypassMode())) {
        // Re-publish so the picker snaps back off Bypass rather than showing a
        // mode that was never applied.
        await this.auth.broadcast();
        return;
      }
      await this.applySetting("permissionMode", mode as PermissionMode);
    },
    setEffort: async (m) => {
      const effort = str(m, "effort");
      if (effort) await this.applySetting("effort", effort as EffortLevel);
    },
    setThinking: async (m) => {
      const thinking = bool(m, "thinking");
      if (thinking !== undefined) {
        await this.applySetting("thinking", thinking);
      }
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
      if (path) await revertFile(this.post, this.checkpoints, path);
    },
    requestFileSearch: async (m) => {
      await searchFiles(this.post, String(m.query ?? ""), str(m, "id") ?? "");
    },
    captureSelection: () => this.sendSelectionToChat(),
    refreshEditorContext: () => broadcastEditorContext(this.post),

    // ── Models ─────────────────────────────────────────────────
    requestModels: () => this.models.broadcast(),

    // ── Skills + marketplace ───────────────────────────────────
    requestSkills: () => broadcastSkills(this.post, this.ctx),
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
      // Before the file, not after: a conversation still holding this session
      // would rewrite it on its next debounced save.
      this.shared.discardConversation(id);
      await this.history.delete(id);
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
    refreshUsage: () => broadcastUsage(this.post),

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
      console.error("[luno] onMessage failed:", err)
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
      console.warn(`[luno] no handler for message type "${msg.type}"`);
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
    // Splices the stored session in keeping its original id, so the next save
    // overwrites the same file instead of forking the conversation into a
    // second history entry — and drops the previous session's checkpoints.
    // `restoreLatestSession` used to carry its own copy of this.
    this.sessions.adopt(stored);
    this.applyStoredSettings(stored);

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
    // Truncate the conversation and clear the UI FIRST. File restore (below)
    // can be slow or throw on a large/dirty tree, and its rejection used to
    // be swallowed by the fire-and-forget message handler — which silently
    // aborted the rewind before it ever posted, so a first-message rewind
    // "did nothing". Doing the truncate + post up front means the chat always
    // clears (a single-message rewind drops straight to the new-chat screen),
    // regardless of what happens during file restore.
    const surviving = this.session.truncateAt(turnId);
    this.resumeId = undefined;

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
        console.error("[luno] checkpoint restore failed during rewind:", err);
      }
    }
  }

  private async editAt(turnId: string, text: string, revertFiles: boolean) {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.abortTurn();
    if (revertFiles && this.checkpoints?.hasCheckpoint(turnId)) {
      try {
        await this.checkpoints.restore(turnId);
      } catch (err) {
        console.error("[luno] checkpoint restore failed during edit:", err);
      }
    }
    const surviving = this.session.truncateAt(turnId);
    this.resumeId = undefined;
    this.post({ type: "rewind", events: surviving });
    await this.handlePrompt(trimmed);
  }

  private async handlePrompt(text: string) {
    if (!text.trim()) return;
    // Cancel + drain any in-flight turn first so two CLI processes never
    // contend for the same resumed session.
    if (this.activeTurn) {
      this.abortTurn();
      try {
        await this.activeTurn;
      } catch {
        /* previous turn surfaces its own errors; we only need it done */
      }
    }
    try {
      await this.runPromptTurn(text);
    } catch (err) {
      // Surface pre-stream failures instead of letting the submit vanish.
      const message = err instanceof Error ? err.message : String(err);
      console.error("[luno] handlePrompt failed:", err);
      this.post({
        type: "error",
        message: `Couldn't start the turn: ${message}`
      });
    }
  }

  private async runPromptTurn(text: string) {
    // Resolved once and used for everything downstream. In an isolated
    // conversation this is the worktree, not the folder VS Code has open, and a
    // path that misses it lands in the wrong tree: attachments the agent cannot
    // read, checkpoints that restore someone else's file.
    const workspaceRoot = await this.ensureWorkingRoot();
    if (workspaceRoot) {
      text = await extractInlineImages(text, workspaceRoot);
    }
    // Posture comes from the conversation, not the workspace: another chat may
    // be running under a different mode right now, and the `luno.*` settings
    // are only what a new one starts with.
    const { model, permissionMode: permMode, effort, thinking } = this.settings;
    const cfg = vscode.workspace.getConfiguration("luno");
    const maxTokens = cfg.get<number>("maxTokens", 4096);
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

    this.sessions.ensureCheckpoints(workspaceRoot);

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

    let providerInstance;
    try {
      providerInstance = createProvider({
        cwd: workspaceRoot,
        permissionMode: permMode,
        allowedBashPatterns: bashAllowlist,
        disabledSkills,
        taskType,
        conventions,
        getResumeSessionId: () => this.resumeId,
        setResumeSessionId: (id) => {
          this.resumeId = id;
        },
        token,
        mcpConfigPath: mcpConfig?.path,
        mcpServerNames: mcpConfig?.serverNames,
        effort,
        thinking
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.post({ type: "error", message: msg });
      void mcpConfig?.cleanup();
      return;
    }

    // In `default`/`auto` the provider routes each mutating tool call back to
    // us over the stream-json control channel; we surface it as an inline
    // approval card (see onDelta's `permission_request` handling). Here we just
    // compose the system prompt with the same per-mode / per-task / conventions
    // content the user expects.
    const systemPrompt = buildSystemPrompt({
      workspaceRoot,
      activeFile,
      workspaceName: vscode.workspace.workspaceFolders?.[0]?.name,
      permissionMode: permMode,
      taskType,
      conventions,
      isClaudeCli: true
    });

    this.maybeShowConventionsBanner(conventions);
    if (permMode === "plan") {
      void suggestSkill(this.post, this.ctx, taskType, workspaceRoot);
    }

    this.activeProvider = providerInstance;
    this.orchestrator = new Orchestrator(this.session, {
      provider: providerInstance,
      model,
      maxTokens,
      systemPrompt,
      onDelta: (d: StreamDelta) => {
        // A pending tool-permission prompt: surface it as a dedicated typed
        // message (an inline approval card in the webview) rather than a raw
        // delta the timeline doesn't know how to render.
        if (d.type === "permission_request" && d.permission) {
          // The turn now cannot continue until someone answers. Off screen that
          // reads as a chat that simply stopped, so it has to say so.
          this.awaitingApproval = true;
          this.refreshSurface();
          this.post({ type: "permissionRequest", request: d.permission });
          return;
        }
        // Forward stream deltas to the webview verbatim (text, tool_use_*, etc.).
        this.post({ type: "delta", delta: d });
        // The CLI reports the resolved model (alias → concrete id). Re-publish
        // it as a typed event so the model picker can show what's actually
        // running, not just the alias the user selected.
        if (d.type === "model" && d.model) {
          this.models.record(model, d.model);
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
            rateLimit: d.usage.rateLimit
          });
        }
      }
    });

    this.post({ type: "turnStart" });
    const orchestrator = this.orchestrator;
    const turn = (async () => {
      try {
        await orchestrator.turn(text);
      } finally {
        this.activeProvider = undefined;
        this.awaitingApproval = false;
        // A turn that landed while the user was looking elsewhere is the other
        // thing worth a glyph: the answer is sitting there unread.
        if (!this.visible) this.finishedWhileHidden = true;
        this.refreshSurface();
        this.post({ type: "turnEnd" });
        // Refresh authoritative usage after every turn — Claude Code writes
        // its session JSONL synchronously, so by this point the new tokens
        // are on disk and the aggregator will pick them up.
        void broadcastUsage(this.post);
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
  return {
    model: cfg.get<string>("model", "default"),
    permissionMode: cfg.get<PermissionMode>("permissionMode", "default"),
    effort: cfg.get<EffortLevel>("effort", "high"),
    thinking: cfg.get<boolean>("thinking", true)
  };
}

function worktreeName(sessionId: string): string {
  return `luno-${sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8)}`;
}

/** Strip stray slash prefixes and trailing whitespace from a captured selection. */
function cleanSelection(raw: string): string {
  // Drop a leading line that is purely a slash command (e.g. "/explain").
  const lines = raw.split(/\r?\n/);
  if (lines.length && /^\s*\/\S/.test(lines[0]) && !lines[0].includes("//")) {
    lines.shift();
  }
  // Trim trailing blank lines but keep interior whitespace.
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.join("\n");
}

// ── Prompt attachments ───────────────────────────────────────

const INLINE_DATA_IMAGE_RE =
  /!\[([^\]]*)\]\(data:image\/([a-zA-Z0-9+.-]+);base64,([A-Za-z0-9+/=]+)\)/g;

/**
 * Strip inline `![name](data:image/...;base64,...)` blobs out of a prompt by
 * writing them to disk under `<workspace>/.luno/attachments/` and replacing
 * the markdown with a relative path reference. Without this, dropping a
 * screenshot into the composer puts a multi-MB base64 string into the prompt
 * text — and the CLI rejects the turn with "Prompt is too long".
 *
 * The rewritten message:
 *   1. Stays small (a relative path instead of base64) so it fits the token
 *      budget and serializes cleanly into the session timeline.
 *   2. Points at a real file in the workspace so the agent's Read tool can
 *      view the image directly.
 *
 * `.luno/` is added to the workspace `.gitignore` on first use so users
 * don't accidentally commit the temp attachments.
 */
async function extractInlineImages(
  prompt: string,
  workspaceRoot: string
): Promise<string> {
  if (!INLINE_DATA_IMAGE_RE.test(prompt)) return prompt;
  INLINE_DATA_IMAGE_RE.lastIndex = 0;

  const attachmentsDir = path.join(workspaceRoot, ".luno", "attachments");
  await fs.promises.mkdir(attachmentsDir, { recursive: true });
  await ensureLunoGitignore(workspaceRoot);

  // Walk all matches synchronously, queue the writes, then splice the prompt
  // in one pass. Doing the writes off the regex iteration keeps replacement
  // bookkeeping simple.
  const matches: Array<{
    full: string;
    name: string;
    relPath: string;
    buffer: Buffer;
  }> = [];
  let m: RegExpExecArray | null;
  while ((m = INLINE_DATA_IMAGE_RE.exec(prompt)) !== null) {
    const [full, rawName, ext, base64] = m;
    const buffer = Buffer.from(base64, "base64");
    const id = crypto.randomBytes(6).toString("hex");
    const safeExt = ext.toLowerCase().replace(/[^a-z0-9]/g, "") || "png";
    const fileName = `${id}.${safeExt}`;
    const absPath = path.join(attachmentsDir, fileName);
    await fs.promises.writeFile(absPath, buffer);
    const relPath = path.posix.join(".luno", "attachments", fileName);
    matches.push({ full, name: rawName || fileName, relPath, buffer });
  }

  let out = prompt;
  for (const mt of matches) {
    out = out.replace(mt.full, `![${mt.name}](${mt.relPath})`);
  }
  return out;
}

async function ensureLunoGitignore(workspaceRoot: string): Promise<void> {
  const gitignorePath = path.join(workspaceRoot, ".gitignore");
  try {
    const existing = await fs.promises.readFile(gitignorePath, "utf8");
    if (/^\.luno\/?\s*$/m.test(existing)) return;
    const sep = existing.endsWith("\n") ? "" : "\n";
    await fs.promises.appendFile(gitignorePath, `${sep}.luno/\n`);
  } catch {
    // No .gitignore yet (or read failed) — create one. Best-effort; ignore
    // write failures (read-only FS, permissions, etc.).
    try {
      await fs.promises.writeFile(gitignorePath, ".luno/\n");
    } catch {
      /* swallow */
    }
  }
}
