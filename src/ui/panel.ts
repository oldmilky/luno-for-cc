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
    this.sidebar.attach(
      {
        webview: view.webview,
        // `show` is optional on the view type and absent in some hosts, hence
        // the guard rather than a direct call.
        reveal: () => view.show?.(true)
      },
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
  // They address the sidebar conversation. Once conversations can also open as
  // editor tabs, "the sidebar one" stops being the obvious target and these
  // route to whichever is focused instead.

  newSession() {
    this.sidebar.newSession();
  }

  async sendUserMessage(text: string) {
    await this.sidebar.sendUserMessage(text);
  }

  commentOnEditorSelection() {
    this.sidebar.commentOnEditorSelection();
  }

  sendSelectionToChat() {
    this.sidebar.sendSelectionToChat();
  }

  /** Shift+Tab. Targets the conversation the user is working in, since each
   *  now carries its own permission mode. */
  async cycleMode() {
    await this.registry.activeConversation()?.cycleMode();
  }

  openConnectors() {
    this.sidebar.openConnectors();
  }
}
