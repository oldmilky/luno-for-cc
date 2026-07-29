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
import { RateLimitTracker } from "../services/rate-limit.js";
import {
  CheckpointService,
  checkpointStoreDir
} from "../services/checkpoint.js";
import type { RateLimitStatus } from "../core/types.js";
import { AuthManager } from "./domains/auth.js";
import { ModelResolver } from "./domains/models.js";
import { broadcastSkills } from "./domains/skills.js";
import { broadcastUsage } from "./domains/usage.js";
import { broadcastEditorContext } from "./domains/files.js";
import {
  ConversationHost,
  type HostTarget,
  type SharedServices
} from "./conversation-host.js";
import type { Post } from "./messages.js";

/** How often to re-aggregate Claude Code's on-disk usage. Cheap (a few JSONL
 *  files per workspace) and it keeps the meter honest when the user also runs
 *  `claude` in a terminal. */
const USAGE_POLL_MS = 60_000;

/** Where the CLI's last quota verdicts are kept across a window reload. */
const RATE_LIMIT_KEY = "luno.rateLimits.v1";

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

/**
 * The conversation a restored tab was showing.
 *
 * Comes from the webview's own persisted state, which is all VS Code keeps
 * across a window reload — and it is written by a program we ship but do not
 * re-verify here, so it is read defensively rather than cast.
 */
function restoredSessionId(state: unknown): string | undefined {
  const id = (state as { sessionId?: unknown } | undefined)?.sessionId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

export class ConversationRegistry {
  private readonly hosts = new Set<ConversationHost>();
  private readonly shared: SharedServices;
  private readonly disposables: vscode.Disposable[] = [];
  private usageTimer?: NodeJS.Timeout;
  /** Tabs open with a number so several of them are tellable apart before
   *  their conversations have titles; `refreshSurface` renames each one as
   *  soon as it has something to say. */
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

  /** Conversations whose webview currently holds the keyboard. Backs the
   *  `luno.chatFocused` context key — see `setChatFocus`. */
  private readonly focused = new Set<ConversationHost>();

  /** The sidebar and whichever conversation currently occupies it. */
  private sidebarTarget?: HostTarget;
  private sidebarHost?: ConversationHost;

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
    // Quota verdicts outlive the panel: a window that resets at 22:10 still
    // resets at 22:10 after a reload, and re-learning it would mean showing an
    // inferred countdown until the next turn happens to report one.
    const rateLimits = new RateLimitTracker({
      get: () => ctx.globalState.get<RateLimitStatus[]>(RATE_LIMIT_KEY),
      set: (v) => void ctx.globalState.update(RATE_LIMIT_KEY, v)
    });
    this.shared = {
      ctx,
      history: new HistoryService(ctx),
      decorations,
      models,
      auth,
      rateLimits,
      broadcast: this.broadcast,
      conversationFor: (sessionId) => this.conversationFor(sessionId),
      openConversationInTab: (sessionId) => void this.openInTab(sessionId),
      showConversation: (sessionId) => void this.showInSidebar(sessionId),
      startNewConversation: (host) => this.startNewConversation(host),
      discardConversation: (sessionId) => this.discardConversation(sessionId),
      markActive: (host) => {
        this.active = host;
      },
      attentionChanged: () => this.onAttentionChanged?.(),
      focusChanged: (host, focused) => this.setChatFocus(host, focused)
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

    // Without this a window reload loses every conversation that was open as a
    // tab: VS Code brings the tab back and has nobody to hand it to. The
    // sidebar restores exactly one chat, so parallel work — the whole point of
    // tabs — did not survive a reload at all.
    this.disposables.push(
      vscode.window.registerWebviewPanelSerializer(TAB_VIEW_TYPE, {
        deserializeWebviewPanel: (panel, state) => {
          this.restoreTab(panel, restoredSessionId(state));
          return Promise.resolve();
        }
      })
    );

    this.wireEditorContext();
    this.wireWebviewSettings();
    this.usageTimer = setInterval(() => {
      void broadcastUsage(this.broadcast, rateLimits);
    }, USAGE_POLL_MS);

    // Snapshots hold file contents, so they are the one store here that grows
    // without bound. Swept once per activation rather than on a timer: nothing
    // ages fast enough to need more.
    void CheckpointService.prune(
      checkpointStoreDir(ctx.globalStorageUri.fsPath)
    );

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

  /**
   * Hand the registry the sidebar, so it can swap which conversation is on it.
   *
   * The sidebar is a fixed surface with a changing occupant — the opposite of a
   * tab, which is created around one conversation and dies with it.
   */
  useSidebar(target: HostTarget, host: ConversationHost): void {
    this.sidebarTarget = target;
    this.sidebarHost = host;
  }

  /**
   * Put a stored conversation on the sidebar.
   *
   * A conversation already open somewhere else is revealed rather than moved:
   * two surfaces on one session would resume the same CLI session twice. One
   * that is merely detached — left behind by an earlier switch, possibly still
   * streaming — is picked back up with its turn intact.
   */
  async showInSidebar(sessionId: string): Promise<void> {
    const open = this.conversationFor(sessionId);
    if (open?.hasSurface) {
      open.reveal();
      return;
    }
    const host = open ?? this.create();
    if (!open) await host.adoptStored(sessionId);
    this.swapSidebar(host);
  }

  /** The conversation currently on the sidebar. Not the one created at
   *  startup — that is only its first occupant. */
  sidebarConversation(): ConversationHost | undefined {
    return this.sidebarHost;
  }

  /**
   * New Chat.
   *
   * A blank conversation is reused rather than piling up an empty host beside
   * it. One with work in it is left running and reachable from history, because
   * clearing it in place is how a turn used to die.
   */
  startNewSidebarConversation(): void {
    const current = this.sidebarHost;
    if (current) {
      this.startNewConversation(current);
      return;
    }
    this.swapSidebar(this.create());
  }

  /**
   * New Chat, from whichever surface asked.
   *
   * Same rule on both, and the reason it has to be the registry's call: only it
   * knows whether the surface can take a different conversation. The sidebar
   * swaps its occupant; a tab is built around one conversation and cannot, so
   * it opens another tab instead. Either way a conversation with work in it is
   * left running rather than cleared underneath a live turn — clearing calls
   * `newSession`, which aborts the turn and releases the CLI process, and a
   * backgrounded workflow does not survive that.
   */
  startNewConversation(host: ConversationHost): void {
    // An idle conversation is cleared in place, which releases its CLI process.
    // That is deliberate: `--resume` is applied at spawn and nowhere else, so a
    // process kept here would answer the new chat out of the old one's history.
    if (!host.hasLiveWork) {
      host.newSession();
      return;
    }
    // Busy: it keeps its turn, its agents and its process, and stays reachable
    // from history. The sidebar can hand its surface to a fresh conversation; a
    // tab is built around one conversation and cannot, so it opens another.
    if (host === this.sidebarHost) {
      this.swapSidebar(this.create());
      return;
    }
    this.openInTab();
  }

  private swapSidebar(host: ConversationHost): void {
    if (!this.sidebarTarget || host === this.sidebarHost) return;
    this.sidebarHost?.hide();
    this.sidebarHost = host;
    // Editor decorations follow the sidebar: it is the conversation the user is
    // reading source alongside.
    this.primary = host;
    // The surface decides isolation, and this conversation may never have been
    // attached to one — a chat picked from history is created here and shown,
    // never attached, so it used to arrive with isolation simply off.
    host.show(this.sidebarTarget, { isolate: isolationWanted("sidebar") });
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

  /**
   * Publish `luno.chatFocused` — the `when` clause every chat-scoped keybinding
   * is written against, Shift+Tab among them.
   *
   * Kept as a set rather than a boolean because focus arrives from several
   * surfaces at once: clicking from one chat into another delivers the new
   * focus and the old blur in whichever order they land, and a single flag
   * would end up false with a chat plainly focused.
   */
  private setChatFocus(host: ConversationHost, focused: boolean): void {
    const before = this.focused.size > 0;
    if (focused) this.focused.add(host);
    else this.focused.delete(host);
    const now = this.focused.size > 0;
    if (now === before) return;
    void vscode.commands.executeCommand("setContext", "luno.chatFocused", now);
  }

  /** How many conversations are waiting on the user right now. */
  attentionCount(): number {
    return [...this.hosts].filter((h) => h.attention !== "none").length;
  }

  /** The same count split by why, because the two are not the same errand: an
   *  approval is a question nobody has answered, a finished turn is an answer
   *  nobody has read. Only the badge's wording depends on the difference. */
  attentionCounts(): { approval: number; finished: number } {
    let approval = 0;
    let finished = 0;
    for (const host of this.hosts) {
      if (host.attention === "approval") approval += 1;
      else if (host.attention === "finished") finished += 1;
    }
    return { approval, finished };
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
    const panel = vscode.window.createWebviewPanel(
      TAB_VIEW_TYPE,
      `Luno ${this.nextTabNumber++}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    return this.adoptTabPanel(panel, sessionId);
  }

  /**
   * Give a tab back the conversation it was showing before a window reload.
   *
   * The session id survives in the webview's persisted state and nowhere else.
   * When it names a conversation that is already open — the sidebar restores
   * the most recent chat, which can be this one — the tab goes rather than the
   * conversation being opened twice: two hosts on one session resume the same
   * CLI session from two processes. Missing or stale ids simply come back as a
   * new chat, which is what `adoptStored` does with a session it cannot find.
   */
  private restoreTab(panel: vscode.WebviewPanel, sessionId?: string): void {
    const open = sessionId ? this.conversationFor(sessionId) : undefined;
    if (open) {
      open.reveal();
      panel.dispose();
      return;
    }
    this.adoptTabPanel(panel, sessionId);
  }

  /** Put a conversation behind an editor-tab panel — one we just created, or
   *  one VS Code handed back. Everything a tab needs wiring is here, so a
   *  restored tab cannot quietly get less of it than a fresh one. */
  private adoptTabPanel(
    panel: vscode.WebviewPanel,
    sessionId?: string
  ): ConversationHost {
    const host = this.create();
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
        },
        close: () => panel.dispose()
      },
      { adoptSessionId: sessionId, isolate: isolationWanted("tab") }
    );
    // A tab is built around one conversation and dies with it, so its listener
    // can bind to that host directly — unlike the sidebar, whose occupant
    // changes underneath it.
    panel.webview.onDidReceiveMessage((msg) => host.receiveMessage(msg));
    // A hidden tab keeps running, so it has to be able to say it finished or
    // needs an answer without being on screen.
    panel.onDidChangeViewState(() => host.setVisible(panel.visible));
    // Closing the tab ends the conversation: its CLI process must die with it
    // rather than keep streaming into a webview nobody can see.
    panel.onDidDispose(() => this.close(host));
    return host;
  }

  /**
   * End the conversation on `sessionId`, because its history entry is going.
   *
   * A tab closes — its own dispose handler retires the conversation, kills the
   * CLI process and gives the checkout back. The sidebar cannot close itself,
   * so its occupant becomes a new chat instead; that also aborts the turn and
   * drops the session, which is what deleting it has to mean.
   */
  discardConversation(sessionId: string): void {
    const host = this.conversationFor(sessionId);
    if (!host) return;
    if (host === this.sidebarHost) {
      host.newSession();
      return;
    }
    if (!host.closeSurface()) this.close(host);
  }

  /** Retire a conversation, release its CLI process, and give back its
   *  checkout — unless that checkout still holds work, which `removeWorktree`
   *  decides. */
  close(host: ConversationHost): void {
    host.dispose();
    void host.releaseWorktree();
    this.hosts.delete(host);
    // A surface torn down while focused sends no blur, so the key would stay
    // true over a chat that no longer exists.
    this.setChatFocus(host, false);
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

  /** Settings the webview reads for itself. Every open conversation is told,
   *  because each one owns its own composer. */
  private wireWebviewSettings(): void {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration("luno.useCtrlEnterToSend")) return;
        for (const host of this.hosts) host.publishWebviewSettings();
      })
    );
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
