// ─────────────────────────────────────────────────────────────
// The sidebar view.
//
// This used to be the whole extension host: one class holding the session, the
// checkpoints, the in-flight turn, the handler table and the webview, which is
// precisely why there could only ever be one chat. Switching conversations had
// to kill the running turn, because there was nowhere else to put it.
//
// What is left here is the `WebviewViewProvider` contract and the commands
// `extension.ts` binds. The conversation itself lives in `ConversationHost`,
// and everything shared between conversations lives in `ConversationRegistry`.
// ─────────────────────────────────────────────────────────────

import * as vscode from "vscode";

import { ConversationHost } from "./conversation-host.js";
import { ConversationRegistry } from "./conversation-registry.js";

export class ChatPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "luno.chat";

  private readonly registry: ConversationRegistry;
  private readonly sidebar: ConversationHost;

  constructor(ctx: vscode.ExtensionContext) {
    this.registry = new ConversationRegistry(ctx);
    this.sidebar = this.registry.create();
  }

  resolveWebviewView(view: vscode.WebviewView) {
    // The sidebar is the one surface that is always reachable, so it carries
    // the count for every conversation that is waiting off screen. Without it a
    // tab parked on an approval is a chat that silently stopped.
    this.registry.onAttentionChanged = () => {
      const waiting = this.registry.attentionCount();
      view.badge =
        waiting > 0
          ? { value: waiting, tooltip: `${waiting} chat(s) need you` }
          : undefined;
    };
    view.onDidChangeVisibility(() => this.sidebar.setVisible(view.visible));
    const target = {
      webview: view.webview,
      // `show` is optional on the view type and absent in some hosts, hence
      // the guard rather than a direct call.
      reveal: () => view.show?.(true)
    };
    // The sidebar is a fixed surface whose occupant changes; the registry owns
    // that swap, so it needs both.
    this.registry.useSidebar(target, this.sidebar);
    this.sidebar.attach(
      target,
      // Only the sidebar resumes: it is the surface a window reload is expected
      // to bring back. A tab that did this would reopen a chat already on
      // screen. Isolation is decided by the registry, which reads the setting.
      { resumeLastConversation: true, isolate: this.registry.isolateSidebar() }
    );
  }

  /** Open an additional conversation as an editor tab. It runs its own turn,
   *  and nothing about it disturbs the sidebar's. */
  openInNewTab() {
    this.registry.openInTab();
  }

  // ── Commands bound in extension.ts ───────────────────────────
  //
  // They address whichever conversation the sidebar is currently showing, which
  // stops being the one built at startup as soon as the user switches chats.

  private get current(): ConversationHost {
    return this.registry.sidebarConversation() ?? this.sidebar;
  }

  newSession() {
    this.registry.startNewSidebarConversation();
  }

  async sendUserMessage(text: string) {
    await this.current.sendUserMessage(text);
  }

  commentOnEditorSelection() {
    this.current.commentOnEditorSelection();
  }

  sendSelectionToChat() {
    this.current.sendSelectionToChat();
  }

  /** Shift+Tab. Targets the conversation the user is working in, since each
   *  now carries its own permission mode. */
  async cycleMode() {
    await this.registry.activeConversation()?.cycleMode();
  }

  openConnectors() {
    this.current.openConnectors();
  }
}
