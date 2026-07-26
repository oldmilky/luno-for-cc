import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { spawn, ChildProcess } from "node:child_process";
import * as readline from "node:readline";
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
import { discoverClaudeSkills } from "../services/claude-skills.js";
import {
  loadConventions,
  disposeConventionsWatchers,
  ConventionsFile
} from "../services/conventions.js";
import { classifyTask } from "../core/task-classifier.js";
import { getSkillSuggestion } from "../services/skill-suggestions.js";
import {
  fetchMarketplace,
  fetchSkillDetail,
  installSkill as installMarketplaceSkill,
  uninstallSkill as uninstallMarketplaceSkill,
  InstallScope,
  InstallTarget
} from "../services/marketplace.js";
import { aggregateClaudeCodeUsage } from "../services/claude-code-usage.js";
import {
  listConnectors as mcpListConnectors,
  connect as mcpConnect,
  cancelConnect as mcpCancelConnect,
  disconnect as mcpDisconnect,
  addCustom as mcpAddCustom,
  removeCustom as mcpRemoveCustom,
  removeManaged as mcpRemoveManaged,
  connectWithApiKey as mcpConnectWithApiKey,
  refreshManagedConnectors as mcpRefreshManaged,
  refreshClaudeCodeStatus as mcpRefreshCliStatus,
  writeCliMcpConfig,
  OAuthCancelled as McpOAuthCancelled,
  CustomDraft as McpCustomDraft
} from "../services/mcp/index.js";

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
   *  without running a turn. Killed at the `init` event (before any API
   *  call), so it's free. Tracked so we can cancel a stale probe. */
  private modelProbe?: ChildProcess;
  /** alias → resolved-id map for every model in the picker. Cached for the
   *  panel's lifetime; re-posted instantly on webview reload so each row can
   *  always show its concrete version. */
  private resolvedModels = new Map<string, string>();
  /** Guard so overlapping `broadcastModels` calls don't fan out duplicate
   *  probe processes. */
  private resolvingModels = false;
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
        this.resolvedModels.clear();
        void this.broadcastModels();
      }
    });
    ctx.subscriptions.push({
      dispose: () => {
        this.decorations.dispose();
        this.artifacts.closeAll();
        disposeConventionsWatchers();
        this.modelProbe?.kill("SIGKILL");
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
      void this.broadcastClaudeCodeUsage();
    });
    this.wireEditorContext();
    // Refresh aggregated Claude Code usage every 60s while the panel is
    // open. Cheap on disk (a few JSONL files per workspace) and keeps the
    // meter honest if the user runs `claude` from a terminal.
    const timer = setInterval(() => {
      void this.broadcastClaudeCodeUsage();
    }, 60_000);
    this.ctx.subscriptions.push({ dispose: () => clearInterval(timer) });
  }

  /** Aggregate authoritative usage from Claude Code's per-workspace JSONL
   *  files and push it to the webview. No-op if no workspace is open. */
  private async broadcastClaudeCodeUsage(): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return;
    try {
      const agg = await aggregateClaudeCodeUsage(root);
      this.post({
        type: "claudeCodeUsage",
        session: agg.session,
        today: agg.today,
        week: agg.week,
        weekSonnet: agg.weekSonnet,
        total: agg.total,
        generatedAt: agg.generatedAt,
        available: agg.available
      });
    } catch {
      // best-effort; the chip falls back to its estimate
    }
  }

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
    const broadcast = () => this.broadcastEditorContext();
    this.ctx.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((ed) => {
        broadcast();
        if (ed) this.decorations.refreshEditor(ed, this.session.timeline);
      }),
      vscode.window.onDidChangeTextEditorSelection(broadcast)
    );
    broadcast();
  }

  private broadcastEditorContext() {
    const ed = vscode.window.activeTextEditor;
    if (!ed) {
      this.post({ type: "editorContext", context: null });
      return;
    }
    const rel = vscode.workspace.asRelativePath(ed.document.uri);
    const sel = ed.selection;
    this.post({
      type: "editorContext",
      context: {
        file: rel,
        language: ed.document.languageId,
        selection: sel.isEmpty
          ? null
          : { startLine: sel.start.line + 1, endLine: sel.end.line + 1 }
      }
    });
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
      await this.broadcastModels();
      await this.broadcastSkills();
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
    this.broadcastConnectors();
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

  private async onMessage(msg: { type: string; [k: string]: unknown }) {
    switch (msg.type) {
      case "prompt":
        await this.handlePrompt(String(msg.text ?? ""));
        break;
      case "cancel":
        this.abortTurn();
        break;
      case "permissionResponse":
        if (
          typeof msg.requestId === "string" &&
          (msg.behavior === "allow" || msg.behavior === "deny")
        ) {
          if (!this.activeProvider?.respondToPermission) {
            console.warn(
              "[luno] permissionResponse arrived but no active provider to answer it"
            );
          }
          this.activeProvider?.respondToPermission?.(
            msg.requestId,
            msg.behavior as PermissionBehavior,
            { restOfTurn: msg.restOfTurn === true }
          );
        }
        break;
      case "newSession":
        this.newSession();
        break;
      case "refreshAuth":
        await this.broadcastAuthState();
        break;
      case "openExternal":
        if (typeof msg.url === "string")
          await vscode.env.openExternal(vscode.Uri.parse(msg.url));
        break;
      case "openFile":
        if (typeof msg.path === "string") {
          await this.handleOpenFile(
            msg.path,
            typeof msg.startLine === "number" ? msg.startLine : 0,
            typeof msg.endLine === "number" ? msg.endLine : 0
          );
        }
        break;
      case "readAttachment":
        if (typeof msg.id === "string" && typeof msg.path === "string") {
          await this.handleReadAttachment(msg.id, msg.path);
        }
        break;
      case "revertFile":
        if (typeof msg.path === "string") {
          await this.handleRevertFile(msg.path);
        }
        break;
      case "refreshUsage":
        await this.broadcastClaudeCodeUsage();
        break;
      case "runTerminalCommand":
        if (typeof msg.command === "string") {
          this.runTerminalCommand(msg.command);
        }
        break;
      case "claudeLogout":
        await this.handleClaudeLogout();
        break;
      case "submitToken":
        if (typeof msg.token === "string") {
          await this.handleSubmitToken(msg.token);
        }
        break;
      case "startClaudeSetup":
        this.handleStartClaudeSetup();
        break;
      case "cancelClaudeSetup":
        this.cancelClaudeSetup();
        break;
      case "confirmClaudeSetup":
        await this.confirmClaudeSetup();
        break;
      case "setModel":
        if (typeof msg.model === "string") {
          await vscode.workspace
            .getConfiguration("luno")
            .update("model", msg.model, vscode.ConfigurationTarget.Global);
          await this.broadcastAuthState();
        }
        break;
      case "setPermissionMode":
        if (typeof msg.mode === "string") {
          await vscode.workspace
            .getConfiguration("luno")
            .update(
              "permissionMode",
              msg.mode,
              vscode.ConfigurationTarget.Global
            );
          await this.broadcastAuthState();
        }
        break;
      case "setEffort":
        if (typeof msg.effort === "string") {
          await vscode.workspace
            .getConfiguration("luno")
            .update("effort", msg.effort, vscode.ConfigurationTarget.Global);
          await this.broadcastAuthState();
        }
        break;
      case "setThinking":
        if (typeof msg.thinking === "boolean") {
          await vscode.workspace
            .getConfiguration("luno")
            .update(
              "thinking",
              msg.thinking,
              vscode.ConfigurationTarget.Global
            );
          await this.broadcastAuthState();
        }
        break;
      case "rewindTo":
        if (typeof msg.turnId === "string") {
          await this.rewindTo(msg.turnId);
        }
        break;
      case "editAt":
        if (typeof msg.turnId === "string" && typeof msg.text === "string") {
          await this.editAt(msg.turnId, msg.text, msg.revertFiles === true);
        }
        break;
      case "refreshEditorContext":
        this.broadcastEditorContext();
        break;
      case "requestModels":
        await this.broadcastModels();
        break;
      case "requestSkills":
        await this.broadcastSkills();
        break;
      case "setSkillEnabled":
        if (typeof msg.id === "string" && typeof msg.enabled === "boolean") {
          await this.setSkillEnabled(msg.id, msg.enabled);
        }
        break;
      case "requestMarketplace":
        await this.handleRequestMarketplace(
          typeof msg.offset === "number" ? msg.offset : 0,
          typeof msg.limit === "number" ? msg.limit : 24,
          typeof msg.query === "string" ? msg.query : undefined
        );
        break;
      case "requestSkillDetail":
        if (typeof msg.name === "string") {
          await this.handleRequestSkillDetail(msg.name);
        }
        break;
      case "installMarketplaceSkill":
        if (
          msg.target &&
          typeof msg.target === "object" &&
          (msg.scope === "user" || msg.scope === "project")
        ) {
          await this.handleInstallMarketplaceSkill(
            msg.target as InstallTarget,
            msg.scope
          );
        }
        break;
      case "uninstallMarketplaceSkill":
        if (
          typeof msg.name === "string" &&
          (msg.scope === "user" || msg.scope === "project")
        ) {
          await this.handleUninstallMarketplaceSkill(msg.name, msg.scope);
        }
        break;
      case "requestFileSearch":
        await this.handleFileSearch(
          String(msg.query ?? ""),
          typeof msg.id === "string" ? msg.id : ""
        );
        break;
      case "captureSelection":
        this.sendSelectionToChat();
        break;
      case "requestHistory":
        await this.broadcastHistory();
        break;
      case "loadSession":
        if (typeof msg.id === "string") await this.loadHistorySession(msg.id);
        break;
      case "deleteHistoryEntry":
        if (typeof msg.id === "string") {
          await this.history.delete(msg.id);
          await this.broadcastHistory();
        }
        break;
      case "planComment":
        if (
          typeof msg.revisionId === "string" &&
          typeof msg.taskId === "string" &&
          typeof msg.body === "string"
        ) {
          this.handlePlanComment(
            msg.revisionId,
            msg.taskId,
            msg.body,
            typeof msg.quote === "string" ? msg.quote : undefined
          );
        }
        break;
      case "planEditComment":
        if (typeof msg.commentId === "string" && typeof msg.body === "string") {
          this.handlePlanEditComment(msg.commentId, msg.body);
        }
        break;
      case "planDeleteComment":
        if (typeof msg.commentId === "string") {
          this.handlePlanDeleteComment(msg.commentId);
        }
        break;
      case "planReplyComment":
        if (
          typeof msg.revisionId === "string" &&
          typeof msg.parentCommentId === "string" &&
          typeof msg.body === "string"
        ) {
          this.handlePlanReplyComment(
            msg.revisionId,
            msg.parentCommentId,
            msg.body
          );
        }
        break;
      case "planResolveComment":
        if (typeof msg.commentId === "string") {
          this.handlePlanResolveComment(msg.commentId, true);
        }
        break;
      case "planReopenComment":
        if (typeof msg.commentId === "string") {
          this.handlePlanResolveComment(msg.commentId, false);
        }
        break;
      case "planOpenFileRef":
        if (
          typeof msg.path === "string" &&
          typeof msg.startLine === "number" &&
          typeof msg.endLine === "number"
        ) {
          await this.handlePlanOpenFileRef(
            msg.path,
            msg.startLine,
            msg.endLine
          );
        }
        break;
      case "planAcceptStep":
        if (
          typeof msg.revisionId === "string" &&
          typeof msg.taskId === "string"
        ) {
          await this.handlePlanAcceptStep(msg.revisionId, msg.taskId);
        }
        break;
      case "planModifyStep":
        if (
          typeof msg.revisionId === "string" &&
          typeof msg.taskId === "string" &&
          typeof msg.instruction === "string"
        ) {
          await this.handlePlanModifyStep(
            msg.revisionId,
            msg.taskId,
            msg.instruction
          );
        }
        break;
      case "planSkipStep":
        if (
          typeof msg.revisionId === "string" &&
          typeof msg.taskId === "string"
        ) {
          this.handlePlanSkipStep(msg.revisionId, msg.taskId);
        }
        break;
      case "planOpenInEditor":
        if (typeof msg.revisionId === "string") {
          this.handlePlanOpenInEditor(msg.revisionId);
        }
        break;
      case "requestArtifactState":
        // Webview-side handshake: the artifact panel mounts, asks for
        // current state, and the host posts it back to that specific
        // panel only. Avoids the race where the post fires before the
        // webview's message listener is wired up.
        if (typeof msg.revisionId === "string") {
          this.artifacts.postToPanel(msg.revisionId, {
            type: "loadedSession",
            events: this.session.timeline,
            title: ""
          });
        }
        break;
      case "planResubmit":
        if (typeof msg.revisionId === "string") {
          await this.handlePlanResubmit(msg.revisionId);
        }
        break;
      case "planAnswer":
        if (
          typeof msg.questionId === "string" &&
          typeof msg.toolUseId === "string" &&
          Array.isArray(msg.answers)
        ) {
          await this.handlePlanAnswer(
            msg.questionId,
            msg.toolUseId,
            msg.answers as Array<{ choice: string; note?: string }>
          );
        }
        break;
      case "planRewindTo":
        if (typeof msg.revisionId === "string") {
          await this.rewindTo(msg.revisionId);
        }
        break;
      case "planProceedRequest":
        if (typeof msg.revisionId === "string") {
          await this.handlePlanProceed(msg.revisionId);
        }
        break;
      case "dismissConventionsBanner":
        await this.ctx.workspaceState.update(
          "luno.conventionsBannerDismissed.v1",
          true
        );
        break;
      case "openConventionsFile":
        if (typeof msg.path === "string") {
          await vscode.window.showTextDocument(vscode.Uri.file(msg.path));
        }
        break;
      case "generateConventions":
        await vscode.commands.executeCommand("luno.generateConventions");
        break;
      case "dismissSkillSuggestion":
        if (typeof msg.skillId === "string") {
          const list = this.ctx.workspaceState.get<string[]>(
            "luno.skillSuggestionDismissed.v1",
            []
          );
          if (!list.includes(msg.skillId)) {
            await this.ctx.workspaceState.update(
              "luno.skillSuggestionDismissed.v1",
              [...list, msg.skillId]
            );
          }
        }
        break;
      case "requestConnectors":
        this.broadcastConnectors();
        // Then fetch tool counts for Claude-Code-managed servers (figma, etc.)
        // using their stored credentials, and re-broadcast so their cards fill
        // in. Best-effort + cached, so reopening the panel is cheap.
        void this.refreshManagedAndRebroadcast();
        break;
      case "connectorConnect":
        if (typeof msg.id === "string") {
          await this.handleConnectorConnect(msg.id);
        }
        break;
      case "connectorCancelConnect":
        if (typeof msg.id === "string") {
          this.handleConnectorCancelConnect(msg.id);
        }
        break;
      case "connectorDisconnect":
        if (typeof msg.id === "string") {
          await this.handleConnectorDisconnect(msg.id);
        }
        break;
      case "connectorAddCustom":
        if (msg.draft && typeof msg.draft === "object") {
          await this.handleConnectorAddCustom(msg.draft as McpCustomDraft);
        }
        break;
      case "connectorRemoveCustom":
        if (typeof msg.id === "string") {
          await this.handleConnectorRemoveCustom(msg.id);
        }
        break;
      case "connectorSetupViaClaudeCode":
        if (typeof msg.id === "string") {
          await this.handleConnectorSetupViaClaudeCode(msg.id);
        }
        break;
      case "connectorConnectWithApiKey":
        if (typeof msg.id === "string" && typeof msg.apiKey === "string") {
          await this.handleConnectorConnectWithApiKey(msg.id, msg.apiKey);
        }
        break;
    }
  }

  // ── MCP connector handlers ──────────────────────────────────

  private broadcastConnectors(): void {
    try {
      const connectors = mcpListConnectors(this.ctx);
      this.post({ type: "connectorsList", connectors });
    } catch (err) {
      this.post({
        type: "error",
        message: `Couldn't list connectors: ${err instanceof Error ? err.message : String(err)}`
      });
    }
  }

  /** Fetch tool counts for Claude-Code-managed servers, then re-broadcast so
   *  their cards show "N tools". Best-effort — failures cache as a card error. */
  private async refreshManagedAndRebroadcast(): Promise<void> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    // Fetch managed tool counts and the `claude mcp list` status (which is the
    // only source for claude.ai connector connection state) in parallel, then
    // re-broadcast so e.g. a Figma the user authorized via Claude Code flips to
    // connected here.
    await Promise.allSettled([
      mcpRefreshManaged(),
      mcpRefreshCliStatus(resolveClaudeBinary(), cwd)
    ]);
    this.broadcastConnectors();
  }

  /** Connect a local API-token preset (e.g. Figma's figma-developer-mcp): store
   *  the token in SecretStorage and spawn the server — no OAuth, fully local. */
  private async handleConnectorConnectWithApiKey(
    id: string,
    apiKey: string
  ): Promise<void> {
    try {
      const connector = await mcpConnectWithApiKey(this.ctx, id, apiKey);
      this.post({
        type: "connectorResult",
        action: "connect",
        id,
        ok: true,
        connector
      });
    } catch (err) {
      this.post({
        type: "connectorResult",
        action: "connect",
        id,
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      });
    }
    this.broadcastConnectors();
  }

  private async handleConnectorConnect(id: string): Promise<void> {
    try {
      const connector = await mcpConnect(this.ctx, id);
      this.post({
        type: "connectorResult",
        action: "connect",
        id,
        ok: true,
        connector
      });
    } catch (err) {
      // Cancellation isn't an "error" the user needs to see in red — flag
      // it so the webview can clear the spinner without showing a toast.
      const cancelled = err instanceof McpOAuthCancelled;
      this.post({
        type: "connectorResult",
        action: "connect",
        id,
        ok: false,
        cancelled,
        error: err instanceof Error ? err.message : String(err)
      });
    }
    this.broadcastConnectors();
  }

  private handleConnectorCancelConnect(id: string): void {
    const cancelled = mcpCancelConnect(id);
    // We always echo back the cancel result so the webview can clear the
    // pending state immediately, even if there was no in-flight attempt
    // (e.g. the user clicked Cancel after the host already resolved).
    this.post({
      type: "connectorResult",
      action: "cancel",
      id,
      ok: cancelled
    });
  }

  private async handleConnectorDisconnect(id: string): Promise<void> {
    try {
      await mcpDisconnect(this.ctx, id);
      this.post({
        type: "connectorResult",
        action: "disconnect",
        id,
        ok: true
      });
    } catch (err) {
      this.post({
        type: "connectorResult",
        action: "disconnect",
        id,
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      });
    }
    this.broadcastConnectors();
  }

  private async handleConnectorAddCustom(draft: McpCustomDraft): Promise<void> {
    try {
      const connector = await mcpAddCustom(this.ctx, draft);
      this.post({
        type: "connectorResult",
        action: "add",
        id: connector.id,
        ok: true,
        connector
      });
    } catch (err) {
      this.post({
        type: "connectorResult",
        action: "add",
        id: "",
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      });
    }
    this.broadcastConnectors();
  }

  private async handleConnectorRemoveCustom(id: string): Promise<void> {
    try {
      if (id.startsWith("managed:")) {
        // Claude-Code-managed server → remove from the user's config via the
        // supported `claude mcp remove` command (run in the workspace so
        // local/project scopes resolve correctly).
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        await mcpRemoveManaged(id, resolveClaudeBinary(), cwd);
      } else {
        await mcpRemoveCustom(this.ctx, id);
      }
      this.post({ type: "connectorResult", action: "remove", id, ok: true });
    } catch (err) {
      this.post({
        type: "connectorResult",
        action: "remove",
        id,
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      });
    }
    this.broadcastConnectors();
  }

  /**
   * Launch the Claude Code MCP auth flow for a connector that can't be OAuth'd
   * directly (e.g. Figma — the vendor only allows Claude Code's pre-registered
   * client). We can't complete the OAuth headlessly, so we drive Claude Code's
   * own `/mcp` flow for the user: clear any stale error, open `claude` in an
   * integrated terminal, and drop into `/mcp` once it boots. After the user
   * authorizes in the browser, the connector loads automatically (Luno
   * imports it as a managed card on the next list).
   */
  private async handleConnectorSetupViaClaudeCode(id: string): Promise<void> {
    // Wipe the stale OAuth/DCR error record so the card stops showing 403.
    try {
      await mcpDisconnect(this.ctx, id);
    } catch {
      // best-effort
    }
    const existing = vscode.window.terminals.find(
      (t) => t.name === "Luno Setup"
    );
    existing?.dispose();
    const term = vscode.window.createTerminal({ name: "Luno Setup" });
    term.show(true);
    // Start the Claude Code TUI, then drop into the MCP connector menu. The
    // second send is delayed so the TUI has booted and is reading stdin (if the
    // timing is off the user just types `/mcp` themselves — the card says so).
    setTimeout(() => term.sendText("claude", true), 300);
    setTimeout(() => term.sendText("/mcp", true), 4000);
    vscode.window.showInformationMessage(
      "Opened Claude Code — choose your connector in the /mcp menu and authorize it in the browser. It'll appear in Luno once connected."
    );
    this.broadcastConnectors();
  }

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
  private async maybeSuggestSkill(
    taskType: import("../core/types.js").TaskType,
    workspaceRoot: string
  ): Promise<void> {
    const dismissed = this.ctx.workspaceState.get<string[]>(
      "luno.skillSuggestionDismissed.v1",
      []
    );
    const suggestion = await getSkillSuggestion(taskType, workspaceRoot);
    if (!suggestion) return;
    if (dismissed.includes(suggestion.skillId)) return;
    this.post({
      type: "skillSuggestion",
      skillId: suggestion.skillId,
      skillName: suggestion.skillName,
      reason: suggestion.reason,
      taskType: suggestion.taskType
    });
  }

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
   * Restore a single file from the most recent checkpoint that snapshotted
   * it. Used by the per-file "Revert" affordance on the EditedFilesCard.
   *
   * `pathOrRel` may be absolute or workspace-relative; `CheckpointService`
   * normalizes both forms internally so the lookup matches regardless of
   * which form the agent's tool input used.
   *
   * Posts a `revertResult` back to the webview with one of three shapes:
   *   - ok: true                          — file overwritten or removed
   *   - ok: false, error: "<no snapshot>" — no checkpoint contains this file
   *   - ok: false, error: <other>         — IO failure
   */
  private async handleRevertFile(pathOrRel: string): Promise<void> {
    if (!this.checkpoints) {
      this.post({
        type: "revertResult",
        path: pathOrRel,
        ok: false,
        error:
          "Checkpoints aren't initialized yet — run at least one prompt first."
      });
      return;
    }
    try {
      const result = await this.checkpoints.restoreFile(pathOrRel);
      if (!result) {
        this.post({
          type: "revertResult",
          path: pathOrRel,
          ok: false,
          error:
            "No prior snapshot for this file (the agent created it before checkpointing started, or it's outside the workspace)."
        });
        return;
      }
      // Synchronize the VS Code buffer with the restored file on disk.
      // Without this, an editor that already had this file open keeps the
      // stale in-memory version and the user can't see the rollback. Two
      // cases:
      //   • File was deleted (existed:false snapshot): close the editor.
      //   • File was overwritten: revert the buffer to disk via the
      //     workbench command. This works even if the user had unsaved
      //     edits (those edits would have been the agent's post-write
      //     content anyway, so dropping them is correct).
      try {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        const isAbs =
          pathOrRel.startsWith("/") || /^[A-Za-z]:[\\/]/.test(pathOrRel);
        const uri = isAbs
          ? vscode.Uri.file(pathOrRel)
          : root
            ? vscode.Uri.joinPath(root, pathOrRel)
            : null;
        if (uri) {
          if (result.deleted) {
            // Try to close the now-deleted file's tab.
            await vscode.commands.executeCommand(
              "vscode.removeFromRecentlyOpened",
              uri
            );
          } else {
            // Force-refresh: show the file and revert its buffer to disk.
            await vscode.window.showTextDocument(uri, {
              preview: false,
              preserveFocus: false
            });
            await vscode.commands.executeCommand(
              "workbench.action.files.revert"
            );
          }
        }
      } catch {
        // best-effort refresh; failure here doesn't change the revert outcome
      }
      this.post({ type: "revertResult", path: pathOrRel, ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.post({
        type: "revertResult",
        path: pathOrRel,
        ok: false,
        error: msg
      });
    }
  }

  /**
   * Reveal a file in the editor. Accepts either an absolute path or a path
   * relative to the workspace root. When a line range is given, the editor
   * scrolls to it and selects that span; otherwise it just opens the file.
   */
  private async handleOpenFile(
    pathOrRel: string,
    startLine: number,
    endLine: number
  ): Promise<void> {
    let target: vscode.Uri;
    if (pathOrRel.startsWith("/") || /^[A-Za-z]:\\/.test(pathOrRel)) {
      target = vscode.Uri.file(pathOrRel);
    } else {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!root) {
        this.post({ type: "error", message: "Open a workspace folder first." });
        return;
      }
      target = vscode.Uri.joinPath(root, pathOrRel);
    }
    try {
      const doc = await vscode.workspace.openTextDocument(target);
      const options: vscode.TextDocumentShowOptions = { preview: false };
      if (startLine > 0) {
        const start = new vscode.Position(Math.max(0, startLine - 1), 0);
        const endIdx = Math.max(start.line, (endLine || startLine) - 1);
        const lineLen = doc.lineAt(Math.min(endIdx, doc.lineCount - 1)).text
          .length;
        options.selection = new vscode.Range(
          start,
          new vscode.Position(endIdx, lineLen)
        );
      }
      await vscode.window.showTextDocument(doc, options);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.post({
        type: "error",
        message: `Could not open ${pathOrRel}: ${msg}`
      });
    }
  }

  private async handlePlanOpenFileRef(
    relPath: string,
    startLine: number,
    endLine: number
  ) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      this.post({
        type: "error",
        message: "Open a workspace folder to navigate plan steps."
      });
      return;
    }
    const target = vscode.Uri.joinPath(root, relPath);
    try {
      const doc = await vscode.workspace.openTextDocument(target);
      const start = new vscode.Position(Math.max(0, startLine - 1), 0);
      const endLineIdx = Math.max(start.line, endLine - 1);
      const lineLen = doc.lineAt(Math.min(endLineIdx, doc.lineCount - 1)).text
        .length;
      const end = new vscode.Position(endLineIdx, lineLen);
      await vscode.window.showTextDocument(doc, {
        selection: new vscode.Range(start, end),
        preview: false
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.post({
        type: "error",
        message: `Could not open ${relPath}: ${msg}`
      });
    }
  }

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

  private async broadcastHistory() {
    const sessions = await this.history.list();
    this.post({ type: "historyList", sessions });
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

  private async broadcastModels() {
    this.post({ type: "models", models: availableModels() });
    void this.resolveModelVersions();
  }

  /**
   * Resolve every alias in the picker (default/opus/sonnet/haiku) to the
   * concrete model id the CLI would use (e.g. `claude-opus-4-7[1m]`), so each
   * row shows its real version the moment the picker opens — not just after a
   * turn.
   *
   * Each probe spawns the bundled CLI and reads the `system`/`init` event,
   * which carries the resolved `model` and fires during session setup —
   * *before* any prompt is sent to the API — then kills the process. No
   * prompt reaches the model, so this costs no subscription tokens. Results
   * are cached for the panel's lifetime and re-posted on webview reload.
   */
  private async resolveModelVersions(): Promise<void> {
    const aliases = availableModels().map((m) => m.value);

    // Re-post everything we already know immediately (covers reloads).
    for (const alias of aliases) {
      const resolved = this.resolvedModels.get(alias);
      if (resolved) this.post({ type: "activeModel", model: resolved, alias });
    }

    if (this.resolvingModels) return;
    const missing = aliases.filter((a) => !this.resolvedModels.has(a));
    if (missing.length === 0) return;

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) return;
    // Resolve against the *same* binary turns will use, so the version shown
    // matches what actually runs (honours luno.claudeBinaryPath).
    const binary = resolveClaudeBinary();
    if (!fs.existsSync(binary)) return;
    const token = await getToken(this.ctx);

    this.resolvingModels = true;
    try {
      // Sequential so we never hold more than one CLI process in memory.
      for (const alias of missing) {
        const resolved = await this.probeModel(
          alias,
          binary,
          workspaceRoot,
          token
        );
        if (resolved) {
          this.resolvedModels.set(alias, resolved);
          this.post({ type: "activeModel", model: resolved, alias });
        }
      }
    } finally {
      this.resolvingModels = false;
    }
  }

  /**
   * Spawn the CLI for a single alias, resolve to the concrete model id from
   * its `init` event, then kill the process. Resolves to null on any
   * error/timeout so the caller can move on to the next alias.
   */
  private probeModel(
    alias: string,
    binary: string,
    cwd: string,
    token: string | undefined
  ): Promise<string | null> {
    return new Promise((resolve) => {
      const env = token
        ? { ...process.env, ANTHROPIC_API_KEY: token }
        : process.env;
      // A throwaway prompt the model never sees — we kill at the init event.
      // `--no-session-persistence` avoids leaving a stray empty session.
      const child = spawn(
        binary,
        [
          "-p",
          "--model",
          alias,
          "--output-format",
          "stream-json",
          "--verbose",
          "--no-session-persistence",
          "."
        ],
        { cwd, env, stdio: ["ignore", "pipe", "ignore"] }
      );
      this.modelProbe = child;

      let settled = false;
      const finish = (result: string | null) => {
        if (settled) return;
        settled = true;
        if (this.modelProbe === child) this.modelProbe = undefined;
        if (!child.killed) child.kill("SIGKILL");
        resolve(result);
      };

      const rl = readline.createInterface({
        input: child.stdout!,
        crlfDelay: Infinity
      });
      rl.on("line", (line) => {
        if (settled) return;
        const trimmed = line.trim();
        if (!trimmed) return;
        let ev: { type?: string; subtype?: string; model?: string };
        try {
          ev = JSON.parse(trimmed);
        } catch {
          return;
        }
        if (
          ev.type === "system" &&
          ev.subtype === "init" &&
          typeof ev.model === "string"
        ) {
          finish(ev.model);
        }
      });
      child.once("error", () => finish(null));
      child.once("exit", () => finish(null));
      // Safety net: never let a wedged probe linger.
      setTimeout(() => finish(null), 10_000);
    });
  }

  private static readonly DISABLED_SKILLS_KEY = "luno.disabledSkills.v1";

  private async broadcastSkills() {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const disabled = new Set(
      this.ctx.globalState.get<string[]>(
        ChatPanelProvider.DISABLED_SKILLS_KEY,
        []
      )
    );
    const skills = await availableSkills(workspaceRoot, disabled);
    this.post({ type: "skills", skills });
  }

  private async setSkillEnabled(id: string, enabled: boolean): Promise<void> {
    const list = this.ctx.globalState.get<string[]>(
      ChatPanelProvider.DISABLED_SKILLS_KEY,
      []
    );
    const set = new Set(list);
    if (enabled) set.delete(id);
    else set.add(id);
    await this.ctx.globalState.update(
      ChatPanelProvider.DISABLED_SKILLS_KEY,
      Array.from(set)
    );
    await this.broadcastSkills();
  }

  // ── Marketplace handlers ────────────────────────────────────

  private async handleRequestMarketplace(
    offset: number,
    limit: number,
    query: string | undefined
  ): Promise<void> {
    try {
      const result = await fetchMarketplace({ offset, limit, query });
      this.post({
        type: "marketplaceList",
        skills: result.skills.map((s) => ({
          id: s.id,
          name: s.name,
          namespace: s.namespace,
          description: s.description,
          author: s.author,
          stars: s.stars,
          installs: s.installs,
          sourceUrl: s.sourceUrl,
          repoOwner: s.repoOwner,
          repoName: s.repoName,
          directoryPath: s.directoryPath
        })),
        total: result.total,
        offset: result.offset,
        limit: result.limit
      });
    } catch (err) {
      this.post({
        type: "marketplaceError",
        message: err instanceof Error ? err.message : String(err)
      });
    }
  }

  private async handleRequestSkillDetail(name: string): Promise<void> {
    try {
      const { skill, content } = await fetchSkillDetail(name);
      this.post({
        type: "skillDetail",
        name,
        skill: {
          id: skill.id,
          name: skill.name,
          namespace: skill.namespace,
          description: skill.description,
          author: skill.author,
          stars: skill.stars,
          installs: skill.installs,
          sourceUrl: skill.sourceUrl,
          repoOwner: skill.repoOwner,
          repoName: skill.repoName,
          directoryPath: skill.directoryPath
        },
        content
      });
    } catch (err) {
      this.post({
        type: "skillDetail",
        name,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  private async handleInstallMarketplaceSkill(
    target: InstallTarget,
    scope: InstallScope
  ): Promise<void> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const result = await installMarketplaceSkill(target, scope, cwd);
    this.post({
      type: "marketplaceInstallResult",
      action: "install",
      name: target.name,
      ok: result.ok,
      scope: result.scope,
      installPath: result.installPath,
      filesWritten: result.filesWritten,
      error: result.error
    });
    // Re-broadcast so the picker picks up the new skill in its on-disk source.
    if (result.ok) {
      await this.broadcastSkills();
    }
  }

  private async handleUninstallMarketplaceSkill(
    name: string,
    scope: InstallScope
  ): Promise<void> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const result = await uninstallMarketplaceSkill(name, scope, cwd);
    this.post({
      type: "marketplaceInstallResult",
      action: "uninstall",
      name,
      ok: result.ok,
      scope: result.scope,
      error: result.error
    });
    if (result.ok) {
      await this.broadcastSkills();
    }
  }

  private async handleFileSearch(query: string, id: string) {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) {
      this.post({ type: "fileSearchResults", id, results: [] });
      return;
    }
    const glob = query ? `**/*${escapeGlob(query)}*` : "**/*";
    const found = await vscode.workspace.findFiles(
      new vscode.RelativePattern(root, glob),
      "**/{node_modules,.git,dist,build,out,.next,.venv,__pycache__}/**",
      40
    );
    const q = query.toLowerCase();
    const results = found
      .map((u) => ({
        path: vscode.workspace.asRelativePath(u),
        name: u.path.split("/").pop() ?? ""
      }))
      .sort((a, b) => {
        const an = a.name.toLowerCase();
        const bn = b.name.toLowerCase();
        if (q) {
          const aMatch = an.startsWith(q) ? 0 : an.includes(q) ? 1 : 2;
          const bMatch = bn.startsWith(q) ? 0 : bn.includes(q) ? 1 : 2;
          if (aMatch !== bMatch) return aMatch - bMatch;
        }
        return a.path.localeCompare(b.path);
      })
      .slice(0, 12);
    this.post({ type: "fileSearchResults", id, results });
  }

  /**
   * Read an attachment file from disk and ship it back to the webview as a
   * data URL. Used by UserMessage to preview the same image the user attached
   * earlier — the wire format stores only a relative path so we hydrate it
   * on demand. Path is sandboxed to the workspace root to refuse `../`
   * traversal attempts.
   */
  private async handleReadAttachment(id: string, attachmentPath: string) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      this.post({
        type: "attachmentData",
        id,
        path: attachmentPath,
        error: "No workspace open."
      });
      return;
    }
    const abs = path.resolve(root, attachmentPath);
    if (!abs.startsWith(root + path.sep) && abs !== root) {
      this.post({
        type: "attachmentData",
        id,
        path: attachmentPath,
        error: "Attachment path is outside the workspace."
      });
      return;
    }
    try {
      const buffer = await fs.promises.readFile(abs);
      const ext = path.extname(abs).slice(1).toLowerCase();
      const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
      const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;
      this.post({ type: "attachmentData", id, path: attachmentPath, dataUrl });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({
        type: "attachmentData",
        id,
        path: attachmentPath,
        error: message
      });
    }
  }

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
    const disabledSkills = this.ctx.globalState.get<string[]>(
      ChatPanelProvider.DISABLED_SKILLS_KEY,
      []
    );

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
      void this.maybeSuggestSkill(taskType, workspaceRoot);
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
          this.resolvedModels.set(model, d.model);
          this.post({ type: "activeModel", model: d.model, alias: model });
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
        void this.broadcastClaudeCodeUsage();
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

  private post(msg: unknown) {
    this.view?.webview.postMessage(msg);
    // Mirror to any open artifact editor tabs so they stay in sync with the
    // chat — comment edits, step accepts, plan revisions, etc. all need to
    // appear on both surfaces.
    this.artifacts.broadcast(msg);
  }

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

function escapeGlob(s: string): string {
  return s.replace(/[[\]{}*?!()]/g, "\\$&");
}

// ── Models / skills catalogs ─────────────────────────────────

export type ModelGroup = "alias" | "version";

export interface ModelInfo {
  value: string;
  label: string;
  note: string;
  supportsTools: boolean;
  group: ModelGroup;
}

/**
 * Models surfaced in the picker.
 *
 * Luno runs exclusively on the Claude Code subscription via the bundled
 * `claude` CLI, so we surface the CLI's *aliases* rather than pinned version
 * IDs. Per `claude --help`, `--model` takes "an alias for the latest model
 * (e.g. 'sonnet' or 'opus')" — each alias always resolves to the newest
 * release for that tier on the user's plan. That means no hardcoded version
 * numbers to go stale: the picker tracks whatever Claude Code ships as latest.
 *
 * Reference: https://code.claude.com/docs/en/model-config
 */
function availableModels(): ModelInfo[] {
  // Claude Code CLI aliases — each tracks the latest model for its tier.
  return [
    {
      value: "default",
      label: "Default",
      note: "Most capable for complex work",
      supportsTools: true,
      group: "alias"
    },
    {
      value: "opus",
      label: "Opus",
      note: "Deepest reasoning, hardest problems",
      supportsTools: true,
      group: "alias"
    },
    {
      value: "sonnet",
      label: "Sonnet",
      note: "Best for everyday tasks",
      supportsTools: true,
      group: "alias"
    },
    {
      value: "haiku",
      label: "Haiku",
      note: "Fastest for quick answers",
      supportsTools: true,
      group: "alias"
    }
  ];
}

export interface SkillInfo {
  id: string;
  name: string;
  category: "tool" | "skill" | "integration";
  description: string;
  enabled: boolean;
  toggleable: boolean;
  external?: boolean;
  /** "user" / "project" for filesystem-discovered skills; undefined otherwise. */
  source?: "user" | "project";
}

/**
 * Skills surfaced in the chat composer. Mirrors Claude Code's tool taxonomy
 * plus user-installed skills discovered on disk under ~/.claude/skills/ and
 * <workspace>/.claude/skills/.
 *
 * `disabled` carries the set of skill ids the user has toggled off in the
 * picker — used to flip `enabled: false` so the UI reflects state, even
 * though the toggle is a preference (Claude Code auto-loads skills based
 * on the prompt; we can't actually filter them at the CLI layer).
 */
async function availableSkills(
  workspaceRoot: string | undefined,
  disabled: Set<string>
): Promise<SkillInfo[]> {
  // Capabilities surfaced by Claude Code (CLI). Marked `external` because
  // they execute inside the CLI agent — Luno doesn't own them.
  const claudeCode: SkillInfo[] = [
    {
      id: "Read",
      name: "Read",
      category: "tool",
      description: "Read files in the workspace",
      enabled: true,
      toggleable: false,
      external: true
    },
    {
      id: "Write",
      name: "Write",
      category: "tool",
      description: "Create and edit files",
      enabled: true,
      toggleable: false,
      external: true
    },
    {
      id: "Bash",
      name: "Bash",
      category: "tool",
      description: "Run shell commands",
      enabled: true,
      toggleable: false,
      external: true
    },
    {
      id: "Glob",
      name: "Glob",
      category: "skill",
      description: "Find files by glob pattern",
      enabled: true,
      toggleable: false,
      external: true
    },
    {
      id: "Grep",
      name: "Grep",
      category: "skill",
      description: "Search file contents",
      enabled: true,
      toggleable: false,
      external: true
    },
    {
      id: "Edit",
      name: "Edit",
      category: "skill",
      description: "Targeted in-file edits",
      enabled: true,
      toggleable: false,
      external: true
    },
    {
      id: "WebFetch",
      name: "WebFetch",
      category: "skill",
      description: "Fetch and read URLs",
      enabled: true,
      toggleable: false,
      external: true
    },
    {
      id: "Task",
      name: "Sub-agents",
      category: "skill",
      description: "Spawn parallel sub-agents",
      enabled: true,
      toggleable: false,
      external: true
    }
  ];

  // User-installed skills from disk. Both `~/.claude/skills/<name>/SKILL.md`
  // and `<ws>/.claude/skills/<name>/SKILL.md` are scanned; failures are
  // swallowed (missing dir, unreadable files, etc.).
  let custom: SkillInfo[];
  try {
    const found = await discoverClaudeSkills(workspaceRoot);
    custom = found.map((s) => ({
      id: s.id,
      name: s.name,
      category: "skill",
      description: s.description,
      enabled: !disabled.has(s.id),
      toggleable: true,
      external: true,
      source: s.source
    }));
  } catch {
    custom = [];
  }

  // Optional integrations (placeholder — not yet wired).
  const integrations: SkillInfo[] = [
    {
      id: "mcp",
      name: "MCP Servers",
      category: "integration",
      description: "Model Context Protocol servers (configure to enable)",
      enabled: false,
      toggleable: false
    }
  ];

  return [...claudeCode, ...custom, ...integrations];
}

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
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif"
};

const INLINE_DATA_IMAGE_RE =
  /!\[([^\]]*)\]\(data:image\/([a-zA-Z0-9+.-]+);base64,([A-Za-z0-9+/=]+)\)/g;

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
