import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { Session } from "../core/session.js";
import { Orchestrator } from "../core/orchestrator.js";
import {
  PermissionMode,
  PermissionBehavior,
  StreamDelta,
  PlanRevisionMeta,
  PlanSections,
  REQUIRED_PLAN_SECTIONS
} from "../core/types.js";
import type { ChatProvider } from "../providers/base.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { createProvider, resolveClaudeBinary } from "../providers/factory.js";
import type { EffortLevel } from "../providers/claude-cli.js";
import { getToken, setToken, deleteToken, classifyToken } from "../secrets.js";
import { CheckpointService } from "../services/checkpoint.js";
import { HistoryService, deriveTitle } from "../services/history.js";
import { PlanDecorationService } from "../services/plan-decorations.js";
import { PlanArtifactManager } from "./plan-artifact-panel.js";
import { buildWebviewHtml, makeNonce } from "./webview-html.js";
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
  private session!: Session;
  private orchestrator?: Orchestrator;
  /** The provider running the current turn. Held so the `permissionResponse`
   *  message can route the user's allow/deny back to the live CLI process. */
  private activeProvider?: ChatProvider;
  // In-flight turn; awaited before starting a new one so turns never overlap.
  private activeTurn?: Promise<void>;
  private resumeId?: string;
  /** Short-lived CLI process used to resolve an alias → concrete model id
  /** Owns the model list, the alias → concrete-id cache, and the probe that
   *  fills it. Three fields and three methods used to live on this class. */
  private readonly models: ModelResolver;
  private checkpoints?: CheckpointService;
  private history: HistoryService;
  private decorations: PlanDecorationService;
  private artifacts: PlanArtifactManager;
  private saveTimer?: NodeJS.Timeout;
  /** Sticky flag set when the user has clicked Logout this session.
   *  `broadcastAuthState` ORs this with "no token in SecretStorage" to
   *  decide whether the webview should show the welcome screen — so even
   *  if SecretStorage somehow returns a stale token, the explicit logout
   *  takes precedence until the user signs back in. */
  private signedOut = false;
  /** In-flight `claude setup-token` terminal, if any. We use a VS Code
   *  terminal (not a background child process) because `setup-token` is
   *  an interactive command — it prints a URL, then either waits for the
   *  user to paste a code back into stdin or for its local OAuth callback
   *  server to fire. Either way we need a real TTY the user can see. */
  private setupTerminal?: vscode.Terminal;

  /** Persists "the user signed in via `claude setup-token`, which stored
   *  credentials in Claude Code's own credential store (Keychain on macOS
   *  or ~/.claude/.credentials.json elsewhere)". When this is true we treat
   *  the user as authed even if SecretStorage holds no token — the bundled
   *  CLI will pick up its own creds on each spawn. */
  private static readonly CLAUDE_CREDS_READY_KEY = "luno.claudeCredsReady.v1";

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.models = new ModelResolver(this.post, ctx);
    this.history = new HistoryService(ctx);
    this.decorations = new PlanDecorationService(
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    );
    this.artifacts = new PlanArtifactManager(ctx);
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
        cfgWatcher.dispose();
      }
    });
    this.initSession();
  }

  private initSession() {
    this.session = new Session();
    this.attachSessionListeners();
  }

  /**
   * Wire timeline + per-turn + per-plan-revision hooks onto the current
   * session. Factored out so it can be reused after `loadHistorySession`
   * and `restoreLatestSession` swap the session instance.
   */
  private attachSessionListeners() {
    this.session.onEvent((e) => {
      this.post({ type: "timeline", event: e });
      this.trackFileForCheckpoint(e);
      // Each plan revision is its own restore point so rewind can land on
      // any revision and bring file state + comment threads with it.
      if (e.kind === "plan_revision" && this.checkpoints) {
        void this.checkpoints.captureBeforePlanRevision(e.id);
      }
      // Mirror plan changes into editor decorations so comments + active
      // step are visible inline next to the source.
      if (e.kind === "plan_revision" || e.kind === "plan_comment") {
        this.decorations.syncFromTimeline(this.session.timeline);
      }
      this.scheduleSave();
    });
    this.session.onUserTurn(async (eventId) => {
      if (this.checkpoints) {
        await this.checkpoints.captureBefore(eventId);
      }
    });
  }

  /** Debounced save — coalesces bursts of timeline events into one write. */
  private scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      void this.history.save({
        id: this.session.id,
        title: deriveTitle(this.session.timeline),
        createdAt: this.session.createdAt,
        updatedAt: Date.now(),
        messages: this.session.messages,
        timeline: this.session.timeline,
        resumeId: this.resumeId
      });
    }, 400);
  }

  /**
   * When the agent (or the Claude CLI agent) calls a write/edit tool, snapshot
   * the file's *current* content into the latest checkpoint so rewind can
   * restore it. This fires synchronously before the tool actually runs (we
   * see the tool_call event right before fs.writeFile / CLI Write executes).
   */
  private trackFileForCheckpoint(e: {
    kind: string;
    body?: string;
    meta?: Record<string, unknown>;
  }) {
    if (!this.checkpoints) return;
    if (e.kind !== "tool_call") return;
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(e.body ?? "{}");
    } catch {
      return;
    }
    const rel = String(input.path ?? input.file_path ?? input.filePath ?? "");
    if (!rel) return;
    const name = String(e.meta?.name ?? "").toLowerCase();
    // Claude CLI's Write / Edit / MultiEdit / NotebookEdit / Update tools.
    if (
      /^(write|edit|multiedit|notebookedit|update|create|str_replace_editor)/.test(
        name
      )
    ) {
      void this.checkpoints.addFileToLatest(rel);
    }
  }

  private ensureCheckpoints(workspaceRoot: string) {
    if (!this.checkpoints) {
      this.checkpoints = new CheckpointService(workspaceRoot);
    }
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

      this.session = new Session(stored.title);
      Object.defineProperty(this.session, "id", { value: stored.id });
      Object.defineProperty(this.session, "createdAt", {
        value: stored.createdAt
      });
      this.session.messages = stored.messages;
      this.session.timeline = stored.timeline;
      this.session.title = stored.title;
      this.resumeId = stored.resumeId;

      // Re-attach the same listener wiring `initSession` would have set.
      // (We replaced this.session, so the prior closure now points at a
      // dead Session object.)
      this.attachSessionListeners();
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

  /**
   * Compute the authoritative auth status by inspecting SecretStorage.
   * `authed` is true when a token is present AND the user hasn't actively
   * signed out this session. We broadcast both the auth status and the
   * model / permission-mode so the webview can hydrate ChatScreen state.
   */
  async broadcastAuthState() {
    const cfg = vscode.workspace.getConfiguration("luno");
    const model = cfg.get<string>("model", "default");
    const permissionMode = cfg.get<PermissionMode>("permissionMode", "default");
    const effort = cfg.get<EffortLevel>("effort", "high");
    const thinking = cfg.get<boolean>("thinking", true);
    const token = await getToken(this.ctx);
    const credsReady = this.ctx.globalState.get<boolean>(
      ChatPanelProvider.CLAUDE_CREDS_READY_KEY,
      false
    );
    const authed = !this.signedOut && (!!token || credsReady);
    this.post({
      type: "auth",
      authed,
      model,
      permissionMode,
      effort,
      thinking
    });
    if (authed) {
      await this.models.broadcast();
      await broadcastSkills(this.post, this.ctx);
    }
  }

  /**
   * Sign out. Luno owns auth state entirely (token in SecretStorage),
   * so logout is a single durable operation: confirm → cancel any in-flight
   * stream → delete the secret → flip the webview to the welcome screen.
   * No CLI invocation, no `~/.claude/` file manipulation. The user can sign
   * back in by pasting a fresh token on the welcome screen.
   */
  /**
   * Kick off the automated OAuth flow.
   *
   * `claude setup-token` is an interactive command — it prints a URL,
   * waits for the user to sign in (either via stdin paste or its local
   * callback server), then writes credentials to Claude Code's own store
   * and exits. A background child process can't service its stdin, so
   * we run it inside a visible VS Code terminal the user can interact
   * with. When they confirm sign-in via the welcome screen, we persist
   * the credsReady flag and proceed.
   */
  private handleStartClaudeSetup(): void {
    // Drop any prior terminal — re-using one that already had `claude`
    // running would type the new command as REPL input, not execute it.
    this.cancelClaudeSetup();

    // Must go through the same resolver as every other call site. Luno ships
    // no bundled CLI — the binary is auto-detected, or
    // whatever `luno.claudeBinaryPath` points at.
    const binary = resolveClaudeBinary();
    if (!fs.existsSync(binary)) {
      this.post({
        type: "setupProgress",
        stage: "error",
        error:
          `Claude CLI not found. Luno searched PATH and the standard ` +
          `install locations and came up empty. Install Claude Code, or set ` +
          `"luno.claudeBinaryPath" to your claude binary ` +
          `(run \`where claude\` / \`which claude\` to find it), ` +
          `or paste a token manually below.`
      });
      return;
    }

    this.post({ type: "setupProgress", stage: "launching" });

    // Launch the binary directly as the terminal's process (shellPath +
    // shellArgs) instead of typing a command into whatever shell happens to
    // be the default. Routing through a shell breaks on Windows, where the
    // default integrated terminal is PowerShell: a command that *starts*
    // with a quoted path — `"C:\...\claude.exe" setup-token` — is parsed as
    // a string literal, so the trailing argument fails with
    // `Unexpected token 'setup-token' in expression or statement`.
    // (PowerShell would need a leading `&` call operator, which in turn
    // breaks cmd.exe and POSIX shells.) Running the executable directly
    // means no shell parses our command at all, so it behaves identically
    // across PowerShell, cmd.exe, bash, and zsh — and the path can contain
    // spaces without any quoting. setup-token stays fully interactive: its
    // stdin/stdout are the terminal's, so the URL prompt and token paste
    // work exactly as before.
    const term = vscode.window.createTerminal({
      name: "Luno Sign-in",
      shellPath: binary,
      shellArgs: ["setup-token"]
    });
    this.setupTerminal = term;
    term.show(true);
    this.post({ type: "setupProgress", stage: "awaitingBrowser" });

    // If the user closes the terminal mid-flow, snap back to idle so the
    // welcome screen doesn't stay stuck on "awaiting browser".
    const closeSub = vscode.window.onDidCloseTerminal((closed) => {
      if (closed !== term) return;
      closeSub.dispose();
      if (this.setupTerminal === term) {
        this.setupTerminal = undefined;
        // Don't error — the user may have closed the terminal after
        // completing sign-in. They'll click "I've signed in" next.
      }
    });
  }

  /**
   * Sign-in succeeded but the CLI didn't emit a token (creds went into
   * Claude Code's own store). Persist the "credsReady" flag and let the
   * CLI use its own credentials on every subsequent spawn — no env
   * injection from our side.
   */
  private async markClaudeCredsReady(): Promise<void> {
    this.post({ type: "setupProgress", stage: "saving" });
    await this.ctx.globalState.update(
      ChatPanelProvider.CLAUDE_CREDS_READY_KEY,
      true
    );
    this.signedOut = false;
    this.setupTerminal?.dispose();
    this.setupTerminal = undefined;
    this.post({ type: "setupProgress", stage: "done" });
    await this.broadcastAuthState();
  }

  /** Cancel a pending `claude setup-token` invocation. */
  private cancelClaudeSetup(): void {
    this.setupTerminal?.dispose();
    this.setupTerminal = undefined;
  }

  /**
   * User clicked "I've signed in" on the welcome screen. The terminal
   * flow stored credentials in Claude Code's own credential store; mark
   * credsReady and proceed.
   */
  private async confirmClaudeSetup(): Promise<void> {
    await this.markClaudeCredsReady();
  }

  /**
   * Run a shell command in a fresh, integrated terminal.
   *
   * IMPORTANT: we always dispose any existing "Luno Setup" terminal
   * before creating a new one. Re-using a terminal that previously hosted
   * `claude` (or any other interactive command) would cause `sendText` to
   * type the new command **as input into the still-running process**
   * rather than execute it as a shell command. Disposing first guarantees
   * a clean shell prompt.
   *
   * `sendText` is also deferred to the next tick so the new terminal's
   * shell has time to print its initial prompt — without that, on some
   * shells (zsh with slow init) the keystrokes can interleave with the
   * shell startup output.
   */
  private runTerminalCommand(command: string): void {
    const existing = vscode.window.terminals.find(
      (t) => t.name === "Luno Setup"
    );
    existing?.dispose();
    const term = vscode.window.createTerminal({ name: "Luno Setup" });
    term.show(true);
    setTimeout(() => {
      term.sendText(command, true);
    }, 250);
  }

  private async handleClaudeLogout(): Promise<void> {
    const pick = await vscode.window.showWarningMessage(
      "Sign out of Claude?",
      {
        modal: true,
        detail:
          "Removes the auth token stored in VS Code's SecretStorage and returns you to the welcome screen. Chat history, checkpoints, and pinned files are preserved."
      },
      "Sign out"
    );
    if (pick !== "Sign out") return;
    this.abortTurn();
    this.orchestrator = undefined;
    this.resumeId = undefined;
    await deleteToken(this.ctx);
    // Clear the "Claude Code has stored creds" flag too — otherwise the
    // user would stay authed via the CLI's own keychain entry even after
    // we wiped our SecretStorage. Note: we don't `claude logout` because
    // that triggers an interactive terminal flow; the next time the user
    // signs in, `claude setup-token` will overwrite the stored creds.
    await this.ctx.globalState.update(
      ChatPanelProvider.CLAUDE_CREDS_READY_KEY,
      false
    );
    this.signedOut = true;
    await this.broadcastAuthState();
  }

  /**
   * Accept a user-pasted token from the welcome screen. We do a
   * format-only check (no network round-trip — the actual validation
   * happens when the user's first prompt streams through the CLI). Posts
   * `tokenResult` back for the form to show success/failure inline.
   */
  private async handleSubmitToken(rawToken: string): Promise<void> {
    const token = rawToken.trim();
    if (!token) {
      this.post({ type: "tokenResult", ok: false, error: "Token is empty." });
      return;
    }
    const kind = classifyToken(token);
    if (kind === "unknown") {
      this.post({
        type: "tokenResult",
        ok: false,
        error:
          "Unrecognized token format. Use a Claude Code OAuth token (sk-ant-oat…) or an Anthropic Console API key (sk-ant-api…)."
      });
      return;
    }
    await setToken(this.ctx, token);
    this.signedOut = false;
    this.post({ type: "tokenResult", ok: true });
    await this.broadcastAuthState();
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
    this.initSession();
    this.resumeId = undefined;
    this.checkpoints?.clear();
    this.checkpoints = undefined;
    this.abortTurn();
    this.orchestrator = undefined;
    this.post({ type: "reset", sessionId: this.session.id });
  }

  async sendUserMessage(text: string) {
    this.reveal();
    await this.handlePrompt(text);
  }

  /**
   * Cmd+U: pull the active editor's selection (or current line if no
   * selection) and surface it inside the composer as a clean attachment.
   * Strips stray slash prefixes and other formatting artifacts.
   */
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
        this.handlePlanComment(revisionId, "__inline__", body, quote);
        this.reveal();
      });
  }

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
    refreshAuth: () => this.broadcastAuthState(),
    claudeLogout: () => this.handleClaudeLogout(),
    submitToken: async (m) => {
      const token = str(m, "token");
      if (token) await this.handleSubmitToken(token);
    },
    startClaudeSetup: () => this.handleStartClaudeSetup(),
    cancelClaudeSetup: () => this.cancelClaudeSetup(),
    confirmClaudeSetup: () => this.confirmClaudeSetup(),
    runTerminalCommand: (m) => {
      const command = str(m, "command");
      if (command) this.runTerminalCommand(command);
    },

    // ── Settings ───────────────────────────────────────────────
    setModel: async (m) => {
      const model = str(m, "model");
      if (model) await this.updateSetting("model", model);
    },
    setPermissionMode: async (m) => {
      const mode = str(m, "mode");
      if (mode) await this.updateSetting("permissionMode", mode);
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
        this.handlePlanComment(revisionId, taskId, body, str(m, "quote"));
      }
    },
    planEditComment: (m) => {
      const commentId = str(m, "commentId");
      const body = str(m, "body");
      if (commentId && body !== undefined) {
        this.handlePlanEditComment(commentId, body);
      }
    },
    planDeleteComment: (m) => {
      const commentId = str(m, "commentId");
      if (commentId) this.handlePlanDeleteComment(commentId);
    },
    planReplyComment: (m) => {
      const revisionId = str(m, "revisionId");
      const parentCommentId = str(m, "parentCommentId");
      const body = str(m, "body");
      if (revisionId && parentCommentId && body !== undefined) {
        this.handlePlanReplyComment(revisionId, parentCommentId, body);
      }
    },
    planResolveComment: (m) => {
      const commentId = str(m, "commentId");
      if (commentId) this.handlePlanResolveComment(commentId, true);
    },
    planReopenComment: (m) => {
      const commentId = str(m, "commentId");
      if (commentId) this.handlePlanResolveComment(commentId, false);
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
        await this.handlePlanAcceptStep(revisionId, taskId);
      }
    },
    planModifyStep: async (m) => {
      const revisionId = str(m, "revisionId");
      const taskId = str(m, "taskId");
      const instruction = str(m, "instruction");
      if (revisionId && taskId && instruction !== undefined) {
        await this.handlePlanModifyStep(revisionId, taskId, instruction);
      }
    },
    planSkipStep: (m) => {
      const revisionId = str(m, "revisionId");
      const taskId = str(m, "taskId");
      if (revisionId && taskId) this.handlePlanSkipStep(revisionId, taskId);
    },
    planOpenInEditor: (m) => {
      const revisionId = str(m, "revisionId");
      if (revisionId) this.handlePlanOpenInEditor(revisionId);
    },
    planResubmit: async (m) => {
      const revisionId = str(m, "revisionId");
      if (revisionId) await this.handlePlanResubmit(revisionId);
    },
    planAnswer: async (m) => {
      const questionId = str(m, "questionId");
      const toolUseId = str(m, "toolUseId");
      const answers = arr(m, "answers");
      if (questionId && toolUseId && answers) {
        await this.handlePlanAnswer(
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
      if (revisionId) await this.handlePlanProceed(revisionId);
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

  /** Write a `luno.*` setting globally, then re-broadcast so the UI follows. */
  private async updateSetting(
    key: string,
    value: string | boolean
  ): Promise<void> {
    await vscode.workspace
      .getConfiguration("luno")
      .update(key, value, vscode.ConfigurationTarget.Global);
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

  /** Append a plan_comment event tied to a (revisionId, taskId). No round-trip yet. */
  private handlePlanComment(
    revisionId: string,
    taskId: string,
    body: string,
    quote?: string
  ) {
    const trimmed = body.trim();
    if (!trimmed) return;
    if (this.isRevisionProceeded(revisionId)) {
      this.postLockedError();
      return;
    }
    this.session.emitPlanComment({
      commentId: makeNonce().slice(0, 8),
      revisionId,
      taskId,
      body: trimmed,
      quote: quote && quote.trim() ? quote.trim() : undefined
    });
  }

  /**
   * Edit an existing comment in place. We mutate the timeline event's meta
   * rather than emitting a superseding event so the rewind/truncate logic
   * stays simple — the comment remains anchored at its original position
   * for restore purposes.
   */
  private handlePlanEditComment(commentId: string, body: string) {
    const trimmed = body.trim();
    if (!trimmed) return;
    if (this.isCommentRevisionProceeded(commentId)) {
      this.postLockedError();
      return;
    }
    const ev = this.findCommentEvent(commentId);
    if (!ev) return;
    const meta = ev.meta as Record<string, unknown>;
    meta.body = trimmed;
    meta.editedAt = Date.now();
    ev.body = trimmed;
    this.post({ type: "timeline", event: ev });
    this.scheduleSave();
  }

  /**
   * Soft-delete: flag the comment as deleted but leave the event in the
   * timeline so any rewind to a checkpoint older than this delete restores
   * the comment intact. The webview filters deleted comments out at fold
   * time.
   */
  private handlePlanDeleteComment(commentId: string) {
    if (this.isCommentRevisionProceeded(commentId)) {
      this.postLockedError();
      return;
    }
    const ev = this.findCommentEvent(commentId);
    if (!ev) return;
    const meta = ev.meta as Record<string, unknown>;
    meta.deleted = true;
    this.post({ type: "timeline", event: ev });
    this.scheduleSave();
  }

  private findCommentEvent(commentId: string) {
    return this.session.timeline.find(
      (e) =>
        e.kind === "plan_comment" &&
        (e.meta as { commentId?: string } | undefined)?.commentId === commentId
    );
  }

  private findRevisionEvent(revisionId: string) {
    return this.session.timeline.find(
      (e) =>
        e.kind === "plan_revision" &&
        (e.meta as { revisionId?: string } | undefined)?.revisionId ===
          revisionId
    );
  }

  /**
   * Required plan sections that are missing entirely or present-but-empty,
   * returned as display labels ("Risks", "Verification"). Gives the Proceed
   * gate teeth: the completeness badge is otherwise cosmetic, so we surface
   * the gaps in the approval modal before the user lets the agent start
   * editing from a thin plan. Returns [] when sections weren't parsed (legacy
   * plans predating section parsing) so we never warn on a false negative.
   */
  private incompletePlanSections(meta: PlanRevisionMeta | undefined): string[] {
    const sections: PlanSections | undefined = meta?.sections;
    if (!sections) return [];
    const out: string[] = [];
    for (const key of REQUIRED_PLAN_SECTIONS) {
      const v = sections[key];
      if (v === undefined || v.trim() === "") {
        out.push(key.charAt(0).toUpperCase() + key.slice(1));
      }
    }
    return out;
  }

  /**
   * True when the plan revision has been "proceeded" by the user — the
   * revision is locked from further comments / step mutations / re-Proceed
   * until the user rewinds to its checkpoint, which clears the flag.
   */
  private isRevisionProceeded(revisionId: string): boolean {
    const ev = this.findRevisionEvent(revisionId);
    if (!ev) return false;
    return (ev.meta as { proceeded?: boolean } | undefined)?.proceeded === true;
  }

  private isCommentRevisionProceeded(commentId: string): boolean {
    const ev = this.findCommentEvent(commentId);
    if (!ev) return false;
    const revId = (ev.meta as { revisionId?: string } | undefined)?.revisionId;
    return revId ? this.isRevisionProceeded(revId) : false;
  }

  private postLockedError(): void {
    this.post({
      type: "error",
      message: "Plan is locked. Rewind to this revision's checkpoint to edit."
    });
  }

  /** Append a reply: a new plan_comment whose `parentCommentId` points at `parent`. */
  private handlePlanReplyComment(
    revisionId: string,
    parentCommentId: string,
    body: string
  ) {
    const trimmed = body.trim();
    if (!trimmed) return;
    if (this.isRevisionProceeded(revisionId)) {
      this.postLockedError();
      return;
    }
    const parent = this.findCommentEvent(parentCommentId);
    const parentMeta = parent?.meta as
      { taskId?: string; quote?: string } | undefined;
    this.session.emitPlanComment({
      commentId: makeNonce().slice(0, 8),
      revisionId,
      taskId: parentMeta?.taskId ?? "__general__",
      body: trimmed,
      // Inherit the parent's quote so the reply still renders in the
      // sidebar with a "jump to passage" affordance.
      quote: parentMeta?.quote,
      parentCommentId
    });
  }

  /** Toggle a comment's manual resolved state. */
  private handlePlanResolveComment(commentId: string, resolve: boolean) {
    if (this.isCommentRevisionProceeded(commentId)) {
      this.postLockedError();
      return;
    }
    const ev = this.findCommentEvent(commentId);
    if (!ev) return;
    const meta = ev.meta as Record<string, unknown>;
    if (resolve) meta.resolvedAt = Date.now();
    else delete meta.resolvedAt;
    this.post({ type: "timeline", event: ev });
    this.scheduleSave();
  }

  /**
   * Reveal a workspace-relative path at the given range and select that
   * range so the user sees the slice the plan step is talking about.
   */

  /**
   * Mutate a single task's status on its plan_revision and re-post the event.
   * Returns the updated revision event (or null if it doesn't exist) so callers
   * can chain a follow-up agent prompt.
   */
  private mutateTaskStatus(
    revisionId: string,
    taskId: string,
    nextStatus: "accepted" | "skipped" | "in_progress"
  ) {
    const ev = this.findRevisionEvent(revisionId);
    if (!ev) return null;
    const meta = ev.meta as {
      tasks?: Array<{ id: string; status: string }>;
    } & Record<string, unknown>;
    const tasks = meta.tasks ?? [];
    const idx = tasks.findIndex((t) => t.id === taskId);
    if (idx === -1) return null;
    tasks[idx] = { ...tasks[idx], status: nextStatus };
    meta.tasks = tasks;
    this.post({ type: "timeline", event: ev });
    this.scheduleSave();
    return { ev, task: tasks[idx] };
  }

  /**
   * Plan "Proceed" pressed. Show a permission popup, switch out of plan mode
   * if needed, then send the continuation prompt — all in one step so the
   * agent can start writing without the user having to manually flip mode.
   */
  private async handlePlanProceed(revisionId: string): Promise<void> {
    if (this.isRevisionProceeded(revisionId)) {
      this.postLockedError();
      return;
    }

    const cfg = vscode.workspace.getConfiguration("luno");
    const currentMode = cfg.get<PermissionMode>("permissionMode", "default");

    // Fetched up front so we can warn on an incomplete plan before the user
    // authorizes edits. Reused below for locking the revision.
    const ev = this.findRevisionEvent(revisionId);
    const planMeta = ev?.meta as unknown as PlanRevisionMeta | undefined;

    const baseDetail =
      currentMode === "plan"
        ? "Plan mode blocks edits. Approving switches into Agent mode so the agent can carry out the plan autonomously."
        : "The agent will continue with file edits and any necessary commands.";
    const missing = this.incompletePlanSections(planMeta);
    const detail =
      missing.length > 0
        ? `⚠ This plan is missing or has empty sections: ${missing.join(", ")}. ` +
          "Skipping these is the most common cause of broken work. Consider " +
          "cancelling and asking Luno to complete the plan first.\n\n" +
          baseDetail
        : baseDetail;

    const choice = await vscode.window.showInformationMessage(
      "Luno has a plan ready. Allow it to start implementing?",
      { modal: true, detail },
      "Allow & continue"
    );

    if (!choice) return; // user cancelled / closed modal

    // Out of plan, go straight into Agent mode (auto). Anywhere else, leave
    // the user's chosen mode alone.
    const targetMode: PermissionMode =
      currentMode === "plan" ? "auto" : currentMode;

    if (targetMode !== currentMode) {
      await cfg.update(
        "permissionMode",
        targetMode,
        vscode.ConfigurationTarget.Global
      );
      // Mirror the change back to the webview so the mode pill updates
      // before the next turn begins.
      await this.broadcastAuthState();
      // Drop the prior CLI resume id. Without this, the next claude-cli
      // invocation passes --resume <plan-mode-session> and the resumed
      // session's stored permission posture (plan = no edits) sticks even
      // though we passed a new --permission-mode flag, so writes keep
      // getting denied with "It seems write permissions need to be
      // granted." A fresh session honors the new mode cleanly. We hand
      // the plan file path back to the agent in the continuation prompt
      // below so the lost conversation context is recovered.
      this.resumeId = undefined;
    }

    // Lock the revision: no more comments / step mutations / re-Proceed
    // until the user rewinds to this revision's checkpoint. Capture the
    // pre-Proceed mode so rewind can restore it. (`ev` was fetched above.)
    const planFilePath =
      ev &&
      ((ev.meta as { planFilePath?: string } | undefined)?.planFilePath ??
        undefined);
    if (ev) {
      const meta = ev.meta as Record<string, unknown>;
      meta.proceeded = true;
      meta.prePermissionMode = currentMode;
      this.post({ type: "timeline", event: ev });
      this.scheduleSave();
    }

    // Continue the conversation. If we cleared resumeId above, the agent
    // is in a fresh session with no planning context — so we hand it the
    // plan file path to re-read. The "permission mode has changed" line
    // is load-bearing: without it the model occasionally remembers being
    // told (in the prior plan-mode prompt) to refuse edits and gets stuck
    // even though the gate is open.
    const continuation = [
      "Plan approved. The permission mode has been switched out of plan mode — you now have permission to make file edits and run the commands the plan requires.",
      planFilePath
        ? `Re-read the plan at \`${planFilePath}\` and carry out each step in order.`
        : "Carry out each step of the plan in order.",
      "The plan was written in a separate read-only session, so before you rely on any file:line reference in it, re-open that location and confirm it still matches — fix the step rather than trusting a stale or mistaken citation.",
      "Stop only if you hit a blocker that requires user input."
    ].join("\n\n");
    void this.handlePrompt(continuation);
  }

  private async handlePlanAcceptStep(revisionId: string, taskId: string) {
    if (this.isRevisionProceeded(revisionId)) {
      this.postLockedError();
      return;
    }
    const result = this.mutateTaskStatus(revisionId, taskId, "accepted");
    if (!result) return;
    const taskMeta = result.task as { content?: string };
    const content = taskMeta.content ?? "this step";
    await this.handlePrompt(
      `Step approved — proceed with: "${content}".\n\n` +
        "Execute only this step, then stop and wait for the next instruction. " +
        "When done, emit a TodoWrite that marks this step's status as " +
        '"completed" and leaves later steps untouched.'
    );
  }

  private async handlePlanModifyStep(
    revisionId: string,
    taskId: string,
    instruction: string
  ) {
    const trimmed = instruction.trim();
    if (!trimmed) return;
    if (this.isRevisionProceeded(revisionId)) {
      this.postLockedError();
      return;
    }
    const ev = this.findRevisionEvent(revisionId);
    if (!ev) return;
    const meta = ev.meta as {
      tasks?: Array<{ id: string; content?: string; status: string }>;
    };
    const task = meta.tasks?.find((t) => t.id === taskId);
    const content = task?.content ?? "the step";
    await this.handlePrompt(
      `Modify the plan step: "${content}".\n\n` +
        `Change requested: ${trimmed}\n\n` +
        "Preserve every step that is already marked accepted or completed. " +
        "Regenerate downstream steps as needed and emit a fresh ExitPlanMode " +
        "(plus TodoWrite) reflecting the updated plan."
    );
  }

  private handlePlanSkipStep(revisionId: string, taskId: string) {
    if (this.isRevisionProceeded(revisionId)) {
      this.postLockedError();
      return;
    }
    this.mutateTaskStatus(revisionId, taskId, "skipped");
  }

  /**
   * Reveal the plan as a real editor tab. The artifact webview shares the
   * same compiled bundle as the chat panel; it loads `ArtifactApp` instead
   * of the chat shell because the host injects window globals that the
   * webview entry reads at boot.
   */
  private handlePlanOpenInEditor(revisionId: string) {
    const ev = this.findRevisionEvent(revisionId);
    if (!ev) {
      this.post({
        type: "error",
        message: "That plan revision is no longer available."
      });
      return;
    }
    const meta = ev.meta as unknown as PlanRevisionMeta;
    this.artifacts.open(meta);
  }

  /**
   * Bundle all unresolved plan_comment events for `revisionId` into a single
   * structured user turn and feed it back through the regular handlePrompt
   * pipeline. The orchestrator's PlanInterceptor will turn the response into
   * a fresh plan_revision with parentRevisionId pointing at the old one.
   */
  private async handlePlanResubmit(revisionId: string) {
    if (this.isRevisionProceeded(revisionId)) {
      this.postLockedError();
      return;
    }
    const comments = this.session.timeline.filter(
      (e) =>
        e.kind === "plan_comment" &&
        (e.meta as { revisionId?: string } | undefined)?.revisionId ===
          revisionId &&
        !(e.meta as { resolvedInRevisionId?: string } | undefined)
          ?.resolvedInRevisionId
    );
    if (comments.length === 0) return;

    const tasksById = new Map<string, string>();
    const revEvent = this.session.timeline.find(
      (e) =>
        e.kind === "plan_revision" &&
        (e.meta as { revisionId?: string })?.revisionId === revisionId
    );
    const tasks =
      (
        revEvent?.meta as
          { tasks?: Array<{ id: string; content: string }> } | undefined
      )?.tasks ?? [];
    for (const t of tasks) tasksById.set(t.id, t.content);

    interface CommentEntry {
      body: string;
      quote?: string;
    }
    const grouped = new Map<string, CommentEntry[]>();
    for (const c of comments) {
      const meta = c.meta as { taskId: string; body: string; quote?: string };
      const list = grouped.get(meta.taskId) ?? [];
      list.push({ body: meta.body, quote: meta.quote });
      grouped.set(meta.taskId, list);
    }

    const lines = ["The plan needs revision based on this feedback:", ""];
    for (const [taskId, entries] of grouped) {
      const label =
        taskId === "__general__"
          ? "Whole-plan feedback"
          : taskId === "__inline__"
            ? "Inline feedback"
            : (tasksById.get(taskId) ?? `(task ${taskId})`);
      lines.push(`**${label}**`);
      for (const e of entries) {
        if (e.quote) {
          // Truncate long quotes — the agent doesn't need the whole passage,
          // just enough to relocate what the user was reacting to.
          const snippet =
            e.quote.length > 240 ? `${e.quote.slice(0, 237)}…` : e.quote;
          lines.push(
            `- (re: "${snippet.replace(/\s+/g, " ").trim()}") ${e.body}`
          );
        } else {
          lines.push(`- ${e.body}`);
        }
      }
      lines.push("");
    }
    lines.push(
      "Produce an updated plan via ExitPlanMode that addresses each comment."
    );
    await this.handlePrompt(lines.join("\n"));
  }

  /**
   * Record the user's question-card answers in the timeline, then forward
   * them as a synthetic user turn so the model knows how to proceed.
   */
  private async handlePlanAnswer(
    questionId: string,
    _toolUseId: string,
    answers: Array<{ choice: string; note?: string }>
  ) {
    this.session.emitPlanAnswer({ questionId, answers });
    const summary = answers
      .map((a, i) => `Q${i + 1}: ${a.choice}${a.note ? ` (${a.note})` : ""}`)
      .join("; ");
    await this.handlePrompt(`Answer to your question — ${summary}`);
  }

  private async loadHistorySession(id: string) {
    const stored = await this.history.load(id);
    if (!stored) {
      this.post({ type: "error", message: "Session not found." });
      return;
    }
    // Replace the in-memory session with the stored one. We don't construct a
    // brand-new Session() because we need the id/createdAt to match for
    // subsequent saves to overwrite the same file.
    this.artifacts.closeAll();
    this.abortTurn();
    this.orchestrator = undefined;
    this.checkpoints?.clear();
    this.checkpoints = undefined;
    this.resumeId = stored.resumeId;

    this.session = new Session(stored.title);
    // Splice in the persisted state. (The Session constructor already set a
    // fresh id/createdAt — overwrite via Object.defineProperty since they're
    // declared readonly. Cleaner than reworking Session's API for one site.)
    Object.defineProperty(this.session, "id", { value: stored.id });
    Object.defineProperty(this.session, "createdAt", {
      value: stored.createdAt
    });
    this.session.messages = stored.messages;
    this.session.timeline = stored.timeline;
    this.session.title = stored.title;

    this.attachSessionListeners();

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
      if (this.saveTimer) {
        clearTimeout(this.saveTimer);
        this.saveTimer = undefined;
      }
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

    // Refuse to start a turn when the user is signed out or has neither a
    // pasted token nor Claude Code's own stored credentials. `credsReady`
    // is set when `claude setup-token` exits cleanly without emitting a
    // token (the OAuth creds live in Claude Code's own credential store).
    const token = await getToken(this.ctx);
    const credsReady = this.ctx.globalState.get<boolean>(
      ChatPanelProvider.CLAUDE_CREDS_READY_KEY,
      false
    );
    if ((!token && !credsReady) || this.signedOut) {
      this.signedOut = !token && !credsReady;
      await this.broadcastAuthState();
      return;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      this.post({ type: "error", message: "Open a folder to use Luno." });
      return;
    }

    this.ensureCheckpoints(workspaceRoot);

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
