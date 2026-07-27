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
import { HistoryService } from "../services/history.js";
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
import { SessionStore } from "./domains/session-store.js";
import { scopeForWrite } from "./domains/settings-scope.js";
import { confirmBypassMode } from "./domains/permission-modes.js";
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
import {
  loadConventions,
  disposeConventionsWatchers,
  ConventionsFile
} from "../services/conventions.js";
import { classifyTask } from "../core/task-classifier.js";
import type { InstallTarget } from "../services/marketplace.js";
// Only what the turn path still needs: the connector *handlers* live in
// `domains/connectors.ts`, but a turn has to hand the CLI an MCP config file
// built from whatever is currently connected.
import { writeCliMcpConfig } from "../services/mcp/index.js";

export class ChatPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "luno.chat";

  private view?: vscode.WebviewView;
  private orchestrator?: Orchestrator;
  /** The provider running the current turn. Held so the `permissionResponse`
   *  message can route the user's allow/deny back to the live CLI process. */
  private activeProvider?: ChatProvider;
  // In-flight turn; awaited before starting a new one so turns never overlap.
  private activeTurn?: Promise<void>;
  /** Owns the model list, the alias → concrete-id cache, and the probe that
   *  fills it. Three fields and three methods used to live on this class. */
  private readonly models: ModelResolver;
  /** Owns the current session, its timeline listeners, debounced persistence,
   *  checkpoints and the CLI resume id. Four fields and six methods used to
   *  live on this class. */
  private readonly sessions: SessionStore;
  /** Owns which credential we have and the flows that get one. Two fields, a
   *  storage key and seven methods used to live on this class. */
  private readonly auth: AuthManager;
  /** The fourteen plan-review actions. They could not move until the session
   *  store existed — see the note at the bottom of `plan-state.ts`. */
  private readonly plan: PlanHandlers;
  private history: HistoryService;
  private decorations: PlanDecorationService;
  private artifacts: PlanArtifactManager;

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
  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.models = new ModelResolver(this.post, ctx);
    this.history = new HistoryService(ctx);
    this.decorations = new PlanDecorationService(
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    );
    this.artifacts = new PlanArtifactManager(ctx);
    // After history and decorations: the store wires session events straight
    // into both, so it cannot be built before they exist.
    this.sessions = new SessionStore(this.post, this.history, this.decorations);
    this.auth = new AuthManager(this.post, ctx, {
      // Auth does not know what a model or a skill is; it only knows that a
      // credential appeared. These are the two things that were inline in
      // `broadcastAuthState` and `handleClaudeLogout`.
      onAuthed: async () => {
        await this.models.broadcast();
        await broadcastSkills(this.post, this.ctx);
      },
      onSignOut: () => {
        this.abortTurn();
        this.orchestrator = undefined;
        this.resumeId = undefined;
      }
    });
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
    // Pointing at a different `claude` binary changes which models the
    // aliases resolve to, so drop the cached versions and re-probe.
    const cfgWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("luno.claudeBinaryPath")) {
        this.models.clear();
        void this.models.broadcast();
      }
    });
    ctx.subscriptions.push({
      dispose: () => {
        this.decorations.dispose();
        this.artifacts.closeAll();
        disposeConventionsWatchers();
        this.models.dispose();
        this.sessions.dispose();
        this.auth.dispose();
        cfgWatcher.dispose();
      }
    });
    this.sessions.reset();
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.ctx.extensionUri, "webview", "dist")
      ]
    };
    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage((msg) => {
      // onMessage is async; surface rejections instead of letting them become
      // silent unhandled promise rejections (which previously masked failures
      // like a throwing checkpoint restore mid-rewind).
      void this.onMessage(msg).catch((err) =>
        console.error("[luno] onMessage failed:", err)
      );
    });
    this.post({ type: "hello", sessionId: this.session.id });
    void this.broadcastAuthState();
    // Try to pick up the most recently used chat instead of starting fresh.
    // Without this, every VS Code reload / extension activation would create
    // a new Session id and the user's "one chat" would split across
    // history entries on each reload. The restore is best-effort: if there's
    // no prior session (or none with user content) we just keep the empty
    // session that the constructor created.
    void this.restoreLatestSession().then(() => {
      this.replayTimeline();
      void broadcastUsage(this.post);
    });
    this.wireEditorContext();
    // Refresh aggregated Claude Code usage every 60s while the panel is
    // open. Cheap on disk (a few JSONL files per workspace) and keeps the
    // meter honest if the user runs `claude` from a terminal.
    const timer = setInterval(() => {
      void broadcastUsage(this.post);
    }, 60_000);
    this.ctx.subscriptions.push({ dispose: () => clearInterval(timer) });
  }

  /** Aggregate authoritative usage from Claude Code's per-workspace JSONL
   *  files and push it to the webview. No-op if no workspace is open. */

  /**
   * On startup, list saved sessions and adopt the most recently updated one
   * as the current session. The user can still click "New Chat" to start a
   * fresh one explicitly.
   */
  private async restoreLatestSession(): Promise<void> {
    // Only restore if our in-memory session is still empty — otherwise we'd
    // clobber a user that's already typing. (Ordinarily the constructor's
    // fresh session is empty until the first prompt.)
    if (this.session.timeline.length > 0) return;
    try {
      const list = await this.history.list();
      if (list.length === 0) return;
      const latest = list[0]; // already sorted by updatedAt desc
      const stored = await this.history.load(latest.id);
      // Require real user content — never re-adopt an empty / placeholder
      // session (e.g. one rewound down to empty), which would resurrect a
      // chat the user just cleared.
      if (!stored || !stored.timeline.some((e) => e.kind === "user")) return;

      this.sessions.adopt(stored);
    } catch {
      // Restore is best-effort; on any failure we fall through to the
      // empty session created by the constructor.
    }
  }

  private wireEditorContext() {
    const broadcast = () => broadcastEditorContext(this.post);
    this.ctx.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((ed) => {
        broadcast();
        if (ed) this.decorations.refreshEditor(ed, this.session.timeline);
      }),
      vscode.window.onDidChangeTextEditorSelection(broadcast)
    );
    broadcast();
  }

  /** Kept as a method because a dozen call sites re-publish auth after a
   *  settings change; the state itself lives in `auth`, which owns the
   *  definition of "authed". */
  async broadcastAuthState() {
    await this.auth.broadcast();
  }

  reveal() {
    this.view?.show?.(true);
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
      if (model) await this.updateSetting("model", model);
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
      await this.updateSetting("permissionMode", mode);
    },
    setEffort: async (m) => {
      const effort = str(m, "effort");
      if (effort) await this.updateSetting("effort", effort);
    },
    setThinking: async (m) => {
      const thinking = bool(m, "thinking");
      if (thinking !== undefined) {
        await this.updateSetting("thinking", thinking);
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
          num(m, "endLine") ?? 0
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
    requestHistory: () => broadcastHistory(this.post, this.history),
    loadSession: async (m) => {
      const id = str(m, "id");
      if (id) await this.loadHistorySession(id);
    },
    deleteHistoryEntry: async (m) => {
      const id = str(m, "id");
      if (!id) return;
      await this.history.delete(id);
      await broadcastHistory(this.post, this.history);
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
          title: ""
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
   * Write a `luno.*` setting, then re-broadcast so the UI follows.
   *
   * Writes to **the scope the value is actually being read from**, not always
   * Global. VS Code resolves narrowest-wins, so a `luno.effort` in
   * `.vscode/settings.json` silently beats every Global write: the click
   * dispatched, the write succeeded, the effective value never moved, and
   * `broadcastAuthState` echoed the old one back — so the control snapped
   * straight back to where it was and looked like a dead button.
   *
   * That is exactly what happened with a workspace pinning `effort: max` and
   * `permissionMode: auto`: neither could be changed from the picker, with no
   * error anywhere.
   */
  private async updateSetting(
    key: string,
    value: string | boolean
  ): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("luno");
    const TARGETS = {
      workspaceFolder: vscode.ConfigurationTarget.WorkspaceFolder,
      workspace: vscode.ConfigurationTarget.Workspace,
      global: vscode.ConfigurationTarget.Global
    } as const;

    await cfg.update(key, value, TARGETS[scopeForWrite(cfg.inspect(key))]);
    await this.broadcastAuthState();
  }

  private async onMessage(msg: RawMessage) {
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

  private async loadHistorySession(id: string) {
    const stored = await this.history.load(id);
    if (!stored) {
      this.post({ type: "error", message: "Session not found." });
      return;
    }
    this.artifacts.closeAll();
    this.abortTurn();
    this.orchestrator = undefined;
    // Splices the stored session in keeping its original id, so the next save
    // overwrites the same file instead of forking the conversation into a
    // second history entry — and drops the previous session's checkpoints.
    // `restoreLatestSession` used to carry its own copy of this.
    this.sessions.adopt(stored);

    this.post({
      type: "loadedSession",
      events: stored.timeline,
      title: stored.title
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
        if (prevMode) {
          const cfg = vscode.workspace.getConfiguration("luno");
          const currentMode = cfg.get<PermissionMode>(
            "permissionMode",
            "default"
          );
          if (currentMode !== prevMode) {
            await cfg.update(
              "permissionMode",
              prevMode,
              vscode.ConfigurationTarget.Global
            );
            await this.broadcastAuthState();
          }
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
    const workspaceForImages =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceForImages) {
      text = await extractInlineImages(text, workspaceForImages);
    }
    const cfg = vscode.workspace.getConfiguration("luno");
    const model = cfg.get<string>("model", "default");
    const maxTokens = cfg.get<number>("maxTokens", 4096);
    const permMode = cfg.get<PermissionMode>("permissionMode", "default");
    const effort = cfg.get<EffortLevel>("effort", "high");
    const thinking = cfg.get<boolean>("thinking", true);
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

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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
    this.view?.webview.postMessage(msg);
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
