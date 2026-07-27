// ─────────────────────────────────────────────────────────────
// Every live conversation, and the services they share.
//
// A `ConversationHost` owns one chat and knows nothing about the others. This
// owns the pieces that exist once per extension — the history store, the editor
// decorations, the model probe, the credential — and hands them to each host.
//
// It also owns the fan-out `post`: anything a shared service publishes (auth
// state, the model list, aggregated usage) is true for every open chat, so it
// goes to all of them. Per-conversation traffic never comes through here; it
// goes straight out of the host that produced it.
// ─────────────────────────────────────────────────────────────

import * as vscode from "vscode";

import { HistoryService } from "../services/history.js";
import { PlanDecorationService } from "../services/plan-decorations.js";
import { disposeConventionsWatchers } from "../services/conventions.js";
import { AuthManager } from "./domains/auth.js";
import { ModelResolver } from "./domains/models.js";
import { broadcastSkills } from "./domains/skills.js";
import { broadcastUsage } from "./domains/usage.js";
import { broadcastEditorContext } from "./domains/files.js";
import { ConversationHost, type SharedServices } from "./conversation-host.js";
import type { Post } from "./messages.js";

/** How often to re-aggregate Claude Code's on-disk usage. Cheap (a few JSONL
 *  files per workspace) and it keeps the meter honest when the user also runs
 *  `claude` in a terminal. */
const USAGE_POLL_MS = 60_000;

/** Webview panel type for a conversation opened as an editor tab. VS Code keys
 *  serialization and `retainContextWhenHidden` off it. */
const TAB_VIEW_TYPE = "luno.conversation";

/**
 * Whether a surface gets its own git worktree.
 *
 * `tabs` is the default: the sidebar keeps working on the files the user has
 * open — edits landing in a checkout they cannot see would be worse than the
 * collisions isolation prevents — while every additional chat, which is where
 * parallel work actually happens, gets a tree of its own.
 */
function isolationWanted(surface: "sidebar" | "tab"): boolean {
  const mode = vscode.workspace
    .getConfiguration("luno")
    .get<string>("worktree", "tabs");
  if (mode === "always") return true;
  if (mode === "tabs") return surface === "tab";
  return false;
}

export class ConversationRegistry {
  private readonly hosts = new Set<ConversationHost>();
  private readonly shared: SharedServices;
  private readonly disposables: vscode.Disposable[] = [];
  private usageTimer?: NodeJS.Timeout;
  /** Tabs are numbered so five of them are tellable apart. Real conversation
   *  titles land with the rest of the tab status work. */
  private nextTabNumber = 1;

  /**
   * The conversation the editor follows.
   *
   * Decorations paint into the one editor everyone shares, so exactly one
   * conversation can own them. A background chat quietly decorating source the
   * user is reading would be worse than no decorations at all.
   */
  private primary?: ConversationHost;

  /**
   * The conversation the user last interacted with.
   *
   * Tracked from inbound webview messages rather than from focus events: a
   * message means the user typed, clicked or scrolled in that chat, which is a
   * stronger and simpler signal than anything VS Code exposes about which
   * webview holds the keyboard.
   */
  private active?: ConversationHost;

  /**
   * Told when any conversation starts or stops wanting the user, so the sidebar
   * can carry one badge for every chat that is off screen. Owned by whoever
   * holds the view, since only it can set a badge.
   */
  onAttentionChanged?: () => void;

  /**
   * Publish to every open conversation.
   *
   * An arrow property because the shared services take it as a value, and a
   * plain method passed by reference arrives with `this` unbound. Declared
   * above the constructor because the constructor hands it to those services:
   * field initialisers run first, but relying on that silently is how the next
   * reader gets to rediscover it.
   */
  readonly broadcast: Post = (msg: unknown) => {
    for (const host of this.hosts) host.receiveBroadcast(msg);
  };

  constructor(ctx: vscode.ExtensionContext) {
    const decorations = new PlanDecorationService(
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    );
    const models = new ModelResolver(this.broadcast, ctx);
    const auth = new AuthManager(this.broadcast, ctx, {
      // Auth does not know what a model or a skill is; it only knows that a
      // credential appeared.
      onAuthed: async () => {
        await models.broadcast();
        await broadcastSkills(this.broadcast, ctx);
      },
      // One credential backs every conversation, so losing it ends all of them.
      onSignOut: () => {
        for (const host of this.hosts) host.abandonTurnOnSignOut();
      },
      // The `auth` message carries each conversation's own model, mode and
      // effort, so the shared service cannot compose it — every conversation
      // republishes its own.
      onPublish: () => {
        for (const host of this.hosts) void host.publishAuthState();
      }
    });
    this.shared = {
      ctx,
      history: new HistoryService(ctx),
      decorations,
      models,
      auth,
      conversationFor: (sessionId) => this.conversationFor(sessionId),
      openConversationInTab: (sessionId) => void this.openInTab(sessionId),
      markActive: (host) => {
        this.active = host;
      },
      attentionChanged: () => this.onAttentionChanged?.()
    };

    // Pointing at a different `claude` binary changes which models the aliases
    // resolve to, so drop the cached versions and re-probe.
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("luno.claudeBinaryPath")) {
          models.clear();
          void models.broadcast();
        }
      })
    );

    this.wireEditorContext();
    this.usageTimer = setInterval(() => {
      void broadcastUsage(this.broadcast);
    }, USAGE_POLL_MS);

    ctx.subscriptions.push({ dispose: () => this.dispose() });
  }

  /**
   * The conversation showing `sessionId`, if one is open.
   *
   * Walks the live hosts rather than reading an index: a host's session id
   * changes under it on New Chat and on load, and a stale index would hand back
   * the wrong conversation. A handful of hosts makes the walk free.
   */
  conversationFor(sessionId: string): ConversationHost | undefined {
    return [...this.hosts].find((h) => h.sessionId === sessionId);
  }

  /** Whether the sidebar conversation runs in its own checkout. Only under
   *  `luno.worktree: "always"`, which is an explicit choice to keep every chat
   *  off the files the editor is showing. */
  isolateSidebar(): boolean {
    return isolationWanted("sidebar");
  }

  /** The conversation a keybinding should act on: the one last worked in,
   *  falling back to the first opened. */
  activeConversation(): ConversationHost | undefined {
    return this.active ?? this.primary;
  }

  /** How many conversations are waiting on the user right now. */
  attentionCount(): number {
    return [...this.hosts].filter((h) => h.attention !== "none").length;
  }

  /** Create a conversation. The first one becomes the primary. */
  create(): ConversationHost {
    const host = new ConversationHost(this.shared);
    this.hosts.add(host);
    this.primary ??= host;
    return host;
  }

  /**
   * Open a conversation as an editor tab.
   *
   * `retainContextWhenHidden` keeps a hidden tab's DOM alive. It costs memory
   * per tab, and it is the deliberate trade: without it VS Code tears the
   * webview down on hide and the chat would have to replay its whole timeline —
   * and drop its scroll position and half-typed prompt — every time the user
   * looked at another file.
   */
  openInTab(sessionId?: string): ConversationHost {
    const host = this.create();
    const panel = vscode.window.createWebviewPanel(
      TAB_VIEW_TYPE,
      `Luno ${this.nextTabNumber++}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.iconPath = vscode.Uri.joinPath(
      this.shared.ctx.extensionUri,
      "assets",
      "luno-activitybar.png"
    );
    host.attach(
      {
        webview: panel.webview,
        reveal: () => panel.reveal(),
        setTitle: (title) => {
          panel.title = title;
        }
      },
      { adoptSessionId: sessionId, isolate: isolationWanted("tab") }
    );
    // A hidden tab keeps running, so it has to be able to say it finished or
    // needs an answer without being on screen.
    panel.onDidChangeViewState(() => host.setVisible(panel.visible));
    // Closing the tab ends the conversation: its CLI process must die with it
    // rather than keep streaming into a webview nobody can see.
    panel.onDidDispose(() => this.close(host));
    return host;
  }

  /** Retire a conversation, release its CLI process, and give back its
   *  checkout — unless that checkout still holds work, which `removeWorktree`
   *  decides. */
  close(host: ConversationHost): void {
    host.dispose();
    void host.releaseWorktree();
    this.hosts.delete(host);
    if (this.primary === host) this.primary = this.hosts.values().next().value;
  }

  /**
   * Editor context is global — the selection and active file are the same for
   * every chat — so it is broadcast, and wired once rather than once per
   * conversation. Decorations are the exception and follow the primary.
   */
  private wireEditorContext(): void {
    const publish = () => broadcastEditorContext(this.broadcast);
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((ed) => {
        publish();
        if (ed && this.primary) {
          this.shared.decorations.refreshEditor(ed, this.primary.timeline);
        }
      }),
      vscode.window.onDidChangeTextEditorSelection(publish)
    );
    publish();
  }

  private dispose(): void {
    clearInterval(this.usageTimer);
    for (const host of this.hosts) host.dispose();
    this.hosts.clear();
    this.shared.decorations.dispose();
    this.shared.models.dispose();
    this.shared.auth.dispose();
    disposeConventionsWatchers();
    for (const d of this.disposables) d.dispose();
  }
}
